// rooms.mjs — booking types through the PACKAGE, on a real staff token
// (plan/booking-types.md Phase 2, "done when").
//
// verify.mjs proves the database rules on the service client and on tokens.
// This proves @rag/bookings uses them correctly: that a group is one insert,
// that errors come back as the right class and message, that a quote and the
// stored price agree, and that photos are stored, capped and cleaned up.
//
// Needs no OpenAI key. It creates and deletes:
//   * a throwaway `rooms-probe` tenant, per_room, with one slot;
//   * a probe user who is its member (the staff token is minted for it, as
//     requireAdmin() does), deleted at the end;
//   * photos in the bucket under the probe's folder, removed at the end.
// Villa is only READ (as its operator), for the whole-resort and
// cross-tenant checks.
//
// Every refusal has its positive twin (CLAUDE.md trap 12).
//
// Run:  pnpm --filter @rag/bookings rooms

import { randomBytes } from 'node:crypto';
import { staffClient } from '@rag/db';
import { asOperator, supabase } from '@rag/db/service';
import {
  addImage,
  BookingConflictError,
  BookingInputError,
  checkRoomAvailability,
  createAccommodation,
  createBookings,
  listAccommodations,
  listBookings,
  listImages,
  listUnits,
  localDate,
  MAX_IMAGE_BYTES,
  PerRoomOnlyError,
  quote,
  removeImage,
  setRates,
  updateAccommodation,
} from '../dist/index.js';

let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failures++;
};
/** Run fn and return what it threw, or null. */
const thrown = async (fn) => {
  try {
    await fn();
    return null;
  } catch (error) {
    return error;
  }
};
const described = (e) => (e ? `${e.name}: ${e.message}` : 'no error');

// Dates in the probe's timezone, far enough out that nothing is in the way.
const day = (offset) => {
  const d = new Date(`${localDate('Asia/Manila')}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
};
/** The first date at or after `offset` days out whose ISO weekday is in `days`. */
const firstOf = (offset, days) => {
  for (let i = offset; ; i++) {
    const iso = new Date(`${day(i)}T00:00:00Z`).getUTCDay() || 7;
    if (days.includes(iso)) return day(i);
  }
};
const MONDAY = firstOf(40, [1]);
const FRIDAY = firstOf(40, [5]);
const TUESDAY = firstOf(40, [2]);

// A real 1×1 PNG (the spike's), and a PNG header padded to a given size.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);
const paddedPng = (size) => Buffer.concat([PNG, Buffer.alloc(size - PNG.length)]);

const { data: villaRow } = await supabase.from('tenants').select('id, slug').eq('slug', 'villa').single();
const villa = await asOperator(villaRow);

const { data: probeRow, error: probeError } = await supabase
  .from('tenants')
  .insert({ slug: 'rooms-probe', business_name: 'rooms.mjs probe', assistant_name: 'Probe' })
  .select('id, slug')
  .single();
if (probeError) throw new Error(`Could not create the probe tenant: ${probeError.message}`);

const email = `rooms-probe-${Date.now()}@example.com`;
let userId = null;
try {
  await supabase
    .from('tenant_applications')
    .insert({ tenant_id: probeRow.id, application_key: 'bookings', config: { timezone: 'Asia/Manila', booking_type: 'per_room' } });
  const { data: night } = await supabase
    .from('slots')
    .insert({ tenant_id: probeRow.id, name: 'Night', start_time: '14:00', duration: '22 hours' })
    .select('id')
    .single();

  const { data: created, error: userError } = await supabase.auth.admin.createUser({
    email,
    password: randomBytes(24).toString('base64url'),
    email_confirm: true,
  });
  if (userError) throw new Error(`Could not create the probe user: ${userError.message}`);
  userId = created.user.id;
  await supabase.from('memberships').insert({ user_id: userId, tenant_id: probeRow.id });
  const probe = { id: probeRow.id, slug: probeRow.slug, db: await staffClient(probeRow.id, userId) };
  if (!probe.db) throw new Error('Could not mint the probe staff token');

  // 1. Rooms, through the package, on the staff token.
  const garden = await createAccommodation(probe, { name: 'Garden Room', capacity: 2, sortOrder: 1, description: 'Ground floor.' });
  const family = await createAccommodation(probe, { name: 'Family Room', capacity: 6, sortOrder: 2 });
  const loft = await createAccommodation(probe, { name: 'Loft', capacity: 4, sortOrder: 3 });
  const duplicate = await thrown(() => createAccommodation(probe, { name: 'Garden Room' }));
  check(
    [garden, family, loft].every((a) => a.active && a.rates.length === 0) && duplicate instanceof BookingInputError,
    'staff add rooms; a duplicate name is a 400',
    `${[garden, family, loft].map((a) => `${a.name} (${a.capacity})`).join(', ')} · duplicate: ${described(duplicate)}`,
  );

  // 2. Rates. The Loft gets none yet.
  await setRates(probe, garden.id, [{ slotId: night.id, weekdayPrice: 350000, weekendPrice: 450000 }]);
  const withRates = await setRates(probe, family.id, [{ slotId: night.id, weekdayPrice: 600000, weekendPrice: 750000 }]);
  const floatPeso = await thrown(() => setRates(probe, family.id, [{ slotId: night.id, weekdayPrice: 6000.5, weekendPrice: 1 }]));
  const villaRoom = (await listUnits(villa))[0];
  const foreignRate = await setRates(probe, villaRoom.id, [{ slotId: night.id, weekdayPrice: 1, weekendPrice: 1 }]);
  check(
    withRates?.rates[0]?.weekdayPrice === 600000 && floatPeso instanceof BookingInputError && foreignRate === null,
    'rates set in centavos; a float is refused; another tenant\'s room is null',
    `Family ${JSON.stringify(withRates?.rates)} · float ${described(floatPeso)} · villa's room ${foreignRate}`,
  );

  // 3. A quote, weekday and weekend, and a room with no rate.
  const monday = await quote(probe, { rooms: [{ unitId: garden.id }, { unitId: family.id }], slotId: night.id, date: MONDAY });
  const friday = await quote(probe, { unitId: garden.id, slotId: night.id, date: FRIDAY });
  const noRate = await thrown(() => quote(probe, { unitId: loft.id, slotId: night.id, date: MONDAY }));
  check(
    monday.total === 950000 && friday.total === 450000 && noRate instanceof BookingInputError,
    'quote: weekday and weekend from the database; no rate says so',
    `${MONDAY} ${monday.lines.map((l) => `${l.unit} ${l.price}`).join(' + ')} = ${monday.total} · ${FRIDAY} ${friday.total} · Loft: ${described(noRate)}`,
  );

  // 4. Two rooms, one booking: one group, and the stored total is the quote's.
  //    A `price` in the input is not even read (it is not a NewBooking field).
  const group = await createBookings(probe, {
    rooms: [{ unitId: garden.id, guestCount: 2 }, { unitId: family.id, guestCount: 5 }],
    slotId: night.id,
    date: MONDAY,
    guestName: 'Rooms Probe',
    price: 1,
  });
  check(
    group.bookings.length === 2 && group.groupId !== null && group.bookings.every((b) => b.groupId === group.groupId) && group.total === monday.total,
    'two rooms booked as one group; the stored total equals the quote',
    `group ${group.groupId} · ${group.bookings.map((b) => `#${b.id} ${b.unit} ${b.price}`).join(', ')} · total ${group.total}`,
  );

  // 5. The same room again is a 409. Then a group that clashes on ONE room:
  //    Garden is booked alone on Tuesday first, so Family + Garden on Tuesday
  //    must fail, and must leave no Family row behind (one statement, D-053).
  const again = await thrown(() => createBookings(probe, { unitId: garden.id, slotId: night.id, date: MONDAY, guestName: 'Second' }));
  const blocker = await createBookings(probe, { unitId: garden.id, slotId: night.id, date: TUESDAY, guestName: 'Blocker' });
  const clash = await thrown(() =>
    createBookings(probe, { rooms: [{ unitId: family.id }, { unitId: garden.id }], slotId: night.id, date: TUESDAY, guestName: 'Clash' }),
  );
  const tuesday = await listBookings(probe, { from: TUESDAY });
  check(
    again instanceof BookingConflictError && blocker.bookings.length === 1 && clash instanceof BookingConflictError
      && tuesday.length === 1 && tuesday[0].guestName === 'Blocker',
    'the same room twice is a 409, and a clashing group saves none of its rooms',
    `again: ${described(again)} · group: ${described(clash)} · Tuesday rows: ${tuesday.map((b) => `${b.unit} (${b.guestName})`).join(', ')}`,
  );

  // 6. Refused rooms, each with the message the caller should see.
  await setRates(probe, loft.id, [{ slotId: night.id, weekdayPrice: 400000, weekendPrice: 500000 }]);
  await updateAccommodation(probe, loft.id, { active: false });
  const inactive = await thrown(() => createBookings(probe, { unitId: loft.id, slotId: night.id, date: FRIDAY, guestName: 'x' }));
  const foreign = await thrown(() => createBookings(probe, { unitId: villaRoom.id, slotId: night.id, date: FRIDAY, guestName: 'x' }));
  const nowhere = await thrown(() => createBookings(probe, { unitId: 999999999, slotId: night.id, date: FRIDAY, guestName: 'x' }));
  check(
    [inactive, foreign, nowhere].every((e) => e instanceof BookingInputError && e.message === 'No such unit or slot.'),
    'inactive, another tenant\'s, and missing rooms look identical',
    [inactive, foreign, nowhere].map(described).join(' | '),
  );
  const noRateRoom = await createAccommodation(probe, { name: 'Unpriced', capacity: 2 });
  const unpriced = await thrown(() => createBookings(probe, { unitId: noRateRoom.id, slotId: night.id, date: FRIDAY, guestName: 'x' }));
  const tooMany = await thrown(() => createBookings(probe, { unitId: garden.id, guestCount: 3, slotId: night.id, date: FRIDAY, guestName: 'x' }));
  const fits = await createBookings(probe, { unitId: garden.id, guestCount: 2, slotId: night.id, date: FRIDAY, guestName: 'Fits' });
  check(
    unpriced instanceof BookingInputError && /no price/.test(unpriced.message)
      && tooMany instanceof BookingInputError && /more guests/.test(tooMany.message)
      && fits.bookings[0]?.price === 450000,
    'no rate and over capacity are 400s; at capacity books at the weekend rate',
    `${described(unpriced)} | ${described(tooMany)} | fits: ${fits.bookings[0]?.price}`,
  );

  // 7. A rate edit leaves the stored prices alone; a new quote sees it.
  await setRates(probe, garden.id, [{ slotId: night.id, weekdayPrice: 999900, weekendPrice: 999900 }]);
  const mondayAfter = (await listBookings(probe, { from: MONDAY })).find((b) => b.unitId === garden.id);
  const requote = await quote(probe, { unitId: garden.id, slotId: night.id, date: MONDAY });
  check(
    mondayAfter?.price === 350000 && requote.total === 999900,
    'a rate edit reprices quotes, not bookings',
    `stored ${mondayAfter?.price} · new quote ${requote.total}`,
  );

  // 8. Room availability: taken where booked, only rooms that fit, only
  //    priced and active ones, and no guest data.
  const rooms = await checkRoomAvailability(probe, { from: MONDAY });
  const forSix = await checkRoomAvailability(probe, { from: MONDAY, guests: 6 });
  const keys = rooms[0] ? Object.keys(rooms[0]).sort().join(',') : '';
  check(
    rooms.map((r) => `${r.unit} ${r.status}`).join(', ') === 'Garden Room taken, Family Room taken'
      && forSix.map((r) => r.unit).join(',') === 'Family Room'
      && keys === 'capacity,date,price,slot,status,unit',
    'room availability: priced active rooms, capacity filter, no guest data',
    `${rooms.map((r) => `${r.unit} ${r.status} ${r.price}`).join(', ')} · 6 guests: ${forSix.map((r) => r.unit).join(',')} · keys ${keys}`,
  );

  // 9. The room filter on the staff list.
  // The dates are found independently, so either can come first.
  const span = { from: [MONDAY, FRIDAY, TUESDAY].sort()[0], to: [MONDAY, FRIDAY, TUESDAY].sort()[2] };
  const onlyFamily = await listBookings(probe, span, { unitId: family.id });
  const villaFilter = await listBookings(probe, span, { unitId: villaRoom.id });
  check(
    onlyFamily.length > 0 && onlyFamily.every((b) => b.unitId === family.id) && villaFilter.length === 0,
    'the room filter shows one room, and another tenant\'s room shows nothing',
    `Family: ${onlyFamily.length} rows · villa's room: ${villaFilter.length}`,
  );

  // 10. Photos. The type comes from the bytes; SVG and oversize are refused.
  const photo = await addImage(probe, garden.id, PNG);
  const response = photo ? await fetch(photo.url) : null;
  const svg = await thrown(() => addImage(probe, garden.id, Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')));
  const huge = await thrown(() => addImage(probe, garden.id, paddedPng(MAX_IMAGE_BYTES + 1)));
  const foreignPhoto = await addImage(probe, villaRoom.id, PNG);
  check(
    photo?.path.startsWith(`${probe.id}/${garden.id}/`) && photo.path.endsWith('.png') && response?.status === 200
      && svg instanceof BookingInputError && huge instanceof BookingInputError && foreignPhoto === null,
    'a photo is stored under its own folder and served; SVG, oversize and another tenant\'s room are refused',
    `${photo?.path} ${response?.status} · svg: ${described(svg)} · huge: ${described(huge)} · villa's room: ${foreignPhoto}`,
  );

  // 11. The 7th photo is refused by the trigger AFTER its upload, and the
  //     upload is removed: the folder holds exactly 6 objects, not 7.
  for (let i = 0; i < 5; i++) await addImage(probe, garden.id, PNG);
  const seventh = await thrown(() => addImage(probe, garden.id, PNG));
  const { data: objects } = await supabase.storage.from('unit-images').list(`${probe.id}/${garden.id}`);
  const rows = await listImages(probe, garden.id);
  check(
    seventh instanceof BookingInputError && objects?.length === 6 && rows.length === 6,
    'the 7th photo is refused and its upload removed',
    `${described(seventh)} · objects ${objects?.length} · rows ${rows.length}`,
  );

  // 12. Removing a photo removes its object; removing it again is false.
  const wrongRoom = await removeImage(probe, family.id, rows[0].id);
  const removed = await removeImage(probe, garden.id, rows[0].id);
  const removedAgain = await removeImage(probe, garden.id, rows[0].id);
  const { data: objectsAfter } = await supabase.storage.from('unit-images').list(`${probe.id}/${garden.id}`);
  check(
    wrongRoom === false && removed === true && removedAgain === false && objectsAfter?.length === 5,
    "a removed photo takes its object with it; another room's id removes nothing",
    `via the Family Room ${wrongRoom}, removed ${removed}, again ${removedAgain}, objects left ${objectsAfter?.length}`,
  );

  // 13. The staff list: rooms in order, with rates and photos, inactive included.
  const list = await listAccommodations(probe);
  check(
    list.map((a) => `${a.name}${a.active ? '' : ' (inactive)'}`).join(', ') === 'Unpriced, Garden Room, Family Room, Loft (inactive)'
      && list.find((a) => a.id === garden.id)?.images.length === 5,
    'listAccommodations: order, rates, photos, inactive rooms kept',
    list.map((a) => `${a.name}${a.active ? '' : ' (inactive)'} ${a.rates.length}r ${a.images.length}p`).join(', '),
  );

  // 14. A whole-resort tenant has no rooms to manage, and cannot book several.
  const errors = await Promise.all([
    thrown(() => listAccommodations(villa)),
    thrown(() => checkRoomAvailability(villa, { from: MONDAY })),
    thrown(() => quote(villa, { unitId: villaRoom.id, slotId: night.id, date: MONDAY })),
  ]);
  const several = await thrown(() =>
    createBookings(villa, { rooms: [{ unitId: villaRoom.id }, { unitId: villaRoom.id + 1 }], slotId: night.id, date: MONDAY, guestName: 'x' }),
  );
  check(
    errors.every((e) => e instanceof PerRoomOnlyError && e.status === 404) && several instanceof BookingInputError,
    'villa (whole_resort): rooms are a 404, several units a 400',
    `${errors.map(described).join(' | ')} | several: ${described(several)}`,
  );
} finally {
  // Photos first: deleting the tenant removes the rows, not the objects (R-30).
  const { data: folders } = await supabase.storage.from('unit-images').list(`${probeRow.id}`);
  for (const folder of folders ?? []) {
    const { data: files } = await supabase.storage.from('unit-images').list(`${probeRow.id}/${folder.name}`);
    if (files?.length) await supabase.storage.from('unit-images').remove(files.map((f) => `${probeRow.id}/${folder.name}/${f.name}`));
  }
  if (userId) {
    const { error } = await supabase.auth.admin.deleteUser(userId);
    if (error) console.log(`WARN  could not delete the probe user ${email}: ${error.message}`);
  }
  const { error } = await supabase.from('tenants').delete().eq('id', probeRow.id);
  if (error) console.log(`WARN  could not delete the rooms-probe tenant: ${error.message}`);
}

console.log(failures === 0 ? '\nALL ROOMS CHECKS PASS' : `\n${failures} ROOMS CHECK(S) FAILED`);
process.exitCode = failures === 0 ? 0 : 1;
