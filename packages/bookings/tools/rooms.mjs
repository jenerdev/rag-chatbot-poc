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
//   * photos in the bucket under the probe's folder, removed at the end;
//   * (20–29) web requests and holiday days in the probe, and a second
//     throwaway tenant, rooms-bare, for the unpriced-page check.
// Villa is only READ (as its operator), for the whole-resort and
// cross-tenant checks.
//
// Every refusal has its positive twin (CLAUDE.md trap 12).
//
// Run:  pnpm --filter @rag/bookings rooms

import { randomBytes } from 'node:crypto';
import { mintTenantToken, scopedClient, staffClient } from '@rag/db';
import { asOperator, supabase } from '@rag/db/service';
import {
  addImage,
  BookingConflictError,
  BookingInputError,
  bookingPage,
  BookingsNotEnabledError,
  confirmRequest,
  copyCalendarDays,
  declineRequest,
  listCalendar,
  listRequests,
  quoteRequest,
  removeCalendarDay,
  requestBooking,
  setCalendarDay,
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
  moveImage,
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
  await supabase.from('memberships').insert({ user_id: userId, tenant_id: probeRow.id, role: 'admin' });
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
  // Garden 2 guests (its standard), Family 5 guests: 3 above the default
  // standard of 2, at the default ₱250 (plan/extra-guests.md).
  const monday = await quote(probe, { rooms: [{ unitId: garden.id, guestCount: 2 }, { unitId: family.id, guestCount: 5 }], slotId: night.id, date: MONDAY });
  const friday = await quote(probe, { unitId: garden.id, slotId: night.id, date: FRIDAY });
  const noRate = await thrown(() => quote(probe, { unitId: loft.id, slotId: night.id, date: MONDAY }));
  check(
    monday.total === 1025000 && friday.total === 450000 && noRate instanceof BookingInputError,
    'quote: weekday and weekend from the database, with extra guests; no rate says so',
    `${MONDAY} ${monday.lines.map((l) => `${l.unit} ${l.basePrice}+${l.extraGuestPrice}`).join(' + ')} = ${monday.total} · ${FRIDAY} ${friday.total} · Loft: ${described(noRate)}`,
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
  const again = await thrown(() => createBookings(probe, { unitId: garden.id, guestCount: 1, slotId: night.id, date: MONDAY, guestName: 'Second' }));
  const blocker = await createBookings(probe, { unitId: garden.id, guestCount: 1, slotId: night.id, date: TUESDAY, guestName: 'Blocker' });
  const clash = await thrown(() =>
    createBookings(probe, {
      rooms: [{ unitId: family.id, guestCount: 1 }, { unitId: garden.id, guestCount: 1 }],
      slotId: night.id,
      date: TUESDAY,
      guestName: 'Clash',
    }),
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
  const inactive = await thrown(() => createBookings(probe, { unitId: loft.id, guestCount: 1, slotId: night.id, date: FRIDAY, guestName: 'x' }));
  const foreign = await thrown(() => createBookings(probe, { unitId: villaRoom.id, guestCount: 1, slotId: night.id, date: FRIDAY, guestName: 'x' }));
  const nowhere = await thrown(() => createBookings(probe, { unitId: 999999999, guestCount: 1, slotId: night.id, date: FRIDAY, guestName: 'x' }));
  check(
    [inactive, foreign, nowhere].every((e) => e instanceof BookingInputError && e.message === 'No such unit or slot.'),
    'inactive, another tenant\'s, and missing rooms look identical',
    [inactive, foreign, nowhere].map(described).join(' | '),
  );
  const noRateRoom = await createAccommodation(probe, { name: 'Unpriced', capacity: 2 });
  const unpriced = await thrown(() => createBookings(probe, { unitId: noRateRoom.id, guestCount: 1, slotId: night.id, date: FRIDAY, guestName: 'x' }));
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
      && keys === 'capacity,date,extraGuestPrice,extraPersonRate,price,slot,standardCapacity,status,total,unit',
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

  // 15–18. Extra guests (plan/extra-guests.md Phase 2), through the package.
  //        A room created with NOTHING but a name gets the request's
  //        defaults: standard 2, maximum 4, ₱250.
  const quad = await createAccommodation(probe, { name: 'Quad' });
  await setRates(probe, quad.id, [{ slotId: night.id, weekdayPrice: 350000, weekendPrice: 450000 }]);
  check(
    quad.standardCapacity === 2 && quad.capacity === 4 && quad.extraPersonRate === 25000,
    'extra guests: a new room defaults to standard 2, maximum 4, ₱250',
    `standard ${quad.standardCapacity}, maximum ${quad.capacity}, rate ${quad.extraPersonRate}`,
  );
  {
    const parties = [];
    for (const guestCount of [1, 2, 3, 4]) {
      const q = await quote(probe, { unitId: quad.id, guestCount, slotId: night.id, date: MONDAY });
      parties.push(`${guestCount}:${q.lines[0].basePrice}+${q.lines[0].extraGuestPrice}=${q.total}`);
    }
    const five = await thrown(() => quote(probe, { unitId: quad.id, guestCount: 5, slotId: night.id, date: MONDAY }));
    check(
      parties.join(' ') === '1:350000+0=350000 2:350000+0=350000 3:350000+25000=375000 4:350000+50000=400000'
        && five instanceof BookingInputError && /at most 4/.test(five.message),
      'extra guests: the quote for 1–4 guests, and 5 refused before booking',
      `${parties.join(' ')} · 5: ${described(five)}`,
    );
  }
  {
    const booked = await createBookings(probe, { unitId: quad.id, guestCount: 3, slotId: night.id, date: MONDAY, guestName: 'Three' });
    const [row] = booked.bookings;
    const listed = (await listBookings(probe, { from: MONDAY })).find((b) => b.id === row?.id);
    check(
      row?.basePrice === 350000 && row.extraGuestPrice === 25000 && row.price === 375000 && booked.total === 375000
        && listed?.extraGuestPrice === 25000,
      'extra guests: 3 guests stored and listed as 350000 + 25000 = 375000',
      `${row?.basePrice} + ${row?.extraGuestPrice} = ${row?.price}; group total ${booked.total}; listed ${listed?.basePrice}+${listed?.extraGuestPrice}`,
    );
  }
  {
    const noCount = await thrown(() => createBookings(probe, { unitId: quad.id, slotId: night.id, date: TUESDAY, guestName: 'x' }));
    const foreignNoCount = await thrown(() => createBookings(probe, { unitId: villaRoom.id, slotId: night.id, date: TUESDAY, guestName: 'x' }));
    const badStandard = await thrown(() => updateAccommodation(probe, quad.id, { standardCapacity: 5 }));
    check(
      noCount instanceof BookingInputError && /number of guests/.test(noCount.message)
        && foreignNoCount?.message === 'No such unit or slot.'
        && badStandard instanceof BookingInputError,
      "extra guests: no guest count is a 400; another tenant's room still says 'No such unit'; standard above the maximum refused",
      `${described(noCount)} | ${described(foreignNoCount)} | ${described(badStandard)}`,
    );
  }

  // 19. Photo order (code review, 2026-09-28). New photos take the next
  //     place, 0, 1, 2; "move right" on the first swaps it with the second
  //     (p2, p1, p3), not to the end, and a move past the end is false.
  {
    const photos = [];
    for (let i = 0; i < 3; i++) photos.push(await addImage(probe, quad.id, PNG));
    const label = (list) => list.map((img) => `p${photos.findIndex((x) => x.id === img.id) + 1}`).join(',');
    const orders = photos.map((img) => img.sortOrder).join(',');
    const moved = await moveImage(probe, quad.id, photos[0].id, 1);
    const afterRight = await listImages(probe, quad.id);
    const pastEnd = await moveImage(probe, quad.id, photos[2].id, 1);
    const back = await moveImage(probe, quad.id, photos[0].id, -1);
    const afterLeft = await listImages(probe, quad.id);
    check(
      orders === '0,1,2' && moved && label(afterRight) === 'p2,p1,p3' && afterRight.map((i) => i.sortOrder).join(',') === '0,1,2'
        && pastEnd === false && back && label(afterLeft) === 'p1,p2,p3',
      'photos: new ones take the next place; a move swaps neighbours',
      `orders on upload ${orders} · → ${label(afterRight)} (${afterRight.map((i) => i.sortOrder).join(',')}) · past the end ${pastEnd} · ← ${label(afterLeft)}`,
    );
  }

  // 20–29 are customer booking Phase 2 (plan/customer-booking.md): the
  //        booking page's reads, quotes, requests and the holiday calendar,
  //        through the PACKAGE. Requests go through a CHAT token, as the
  //        public page will; confirm and decline through the staff token.
  //        A "Hall" room priced like villa: 30 included, 45 at most, ₱250
  //        above 30, ₱16,000 weekday / ₱20,000 weekend.
  {
    await supabase.from('slots').update({ nightly: true }).eq('tenant_id', probe.id).eq('id', night.id);
    const chat = { id: probe.id, slug: probe.slug, db: scopedClient(mintTenantToken({ tenantId: probe.id })) };
    const hall = await createAccommodation(probe, { name: 'Hall', capacity: 45, standardCapacity: 30, extraPersonRate: 25000, sortOrder: 20 });
    await setRates(probe, hall.id, [{ slotId: night.id, weekdayPrice: 1600000, weekendPrice: 2000000 }]);
    const THU = firstOf(100, [4]);
    const next = (iso, n) => {
      const d = new Date(`${iso}T00:00:00Z`);
      d.setUTCDate(d.getUTCDate() + n);
      return d.toISOString().slice(0, 10);
    };
    const FRI = next(THU, 1);
    const PEAK = firstOf(130, [4]);
    const HOLIDAY = firstOf(140, [2]);
    const contact = (n) => ({ name: 'Rooms Probe', phone: `0917000${String(n).padStart(4, '0')}`, email: `rooms-probe-${n}@example.com` });
    const stay = (overrides = {}) => ({ slotId: night.id, rooms: [{ unitId: hall.id, guests: 32 }], checkIn: THU, nights: 2, ...contact(1), ...overrides });

    // 20. The page, on a chat token: priced active rooms only (the Loft,
    //     retired in 6, is not offered), the night slot marked nightly, 14 nights.
    //     A whole_resort tenant with no rates has no page: 404.
    {
      const page = await bookingPage(chat);
      const names = page.units.map((u) => u.name);
      const { data: bare } = await supabase.from('tenants').insert({ slug: 'rooms-bare', business_name: 'bare', assistant_name: 'x' }).select('id, slug').single();
      let bareError = null;
      try {
        await supabase.from('tenant_applications').insert({ tenant_id: bare.id, application_key: 'bookings', config: { timezone: 'Asia/Manila' } });
        await supabase.from('units').insert({ tenant_id: bare.id, name: 'Whole property' });
        bareError = await thrown(() => bookingPage({ id: bare.id, slug: bare.slug, db: scopedClient(mintTenantToken({ tenantId: bare.id })) }));
      } finally {
        await supabase.from('tenants').delete().eq('id', bare.id);
      }
      check(
        names.includes('Hall') && !names.includes('Loft') && page.slots.every((s) => s.nightly) && page.maxNights === 14
          && page.units.every((u) => u.rates.length > 0) && bareError instanceof BookingsNotEnabledError,
        'booking page: priced active units only, nightly slot, 14 nights; an unpriced tenant is a 404',
        `${names.join(', ')} · slots ${page.slots.map((s) => `${s.name}${s.nightly ? '*' : ''}`).join(',')} · unpriced: ${described(bareError)}`,
      );
    }

    // 21. A weekday + weekend stay, quoted on the chat token: 1650000 + 2050000.
    {
      const q = await quoteRequest(chat, stay());
      const got = q.lines.map((l) => `${l.date} ${l.basePrice}+${l.extraGuestPrice}+${l.surcharge}=${l.price}`).join(', ');
      check(
        q.available && q.total === 3700000 && got === `${THU} 1600000+50000+0=1650000, ${FRI} 2000000+50000+0=2050000`,
        'quote: a Thursday + Friday stay is priced night by night',
        `${got} · total ${q.total} · available ${q.available}`,
      );
    }

    // 22. The calendar through the package: staff add a peak day with ₱4,000
    //     and a plain holiday; the chat token reads both and cannot write.
    //     Villa's 24 Dec shape, on a Thursday: the weekend rate + ₱500 +
    //     ₱4,000 = ₱24,500 exactly.
    {
      await setCalendarDay(probe, { day: PEAK, kind: 'peak', label: 'Probe peak', surcharge: 400000 });
      await setCalendarDay(probe, { day: HOLIDAY, label: 'Probe holiday' });
      const seen = await listCalendar(chat, { from: PEAK, to: HOLIDAY });
      const chatWrite = await thrown(() => setCalendarDay(chat, { day: PEAK, label: 'Chat', surcharge: 0 }));
      const peak = await quoteRequest(chat, stay({ checkIn: PEAK, nights: 1 }));
      const line = peak.lines[0];
      check(
        seen.map((d) => `${d.day} ${d.kind} ${d.surcharge}`).join(', ') === `${PEAK} peak 400000, ${HOLIDAY} holiday 0`
          && chatWrite !== null && !(chatWrite instanceof BookingInputError)
          && `${line.basePrice}+${line.extraGuestPrice}+${line.surcharge}=${line.price}` === '2000000+50000+400000=2450000' && line.holiday === 'Probe peak',
        "calendar: staff write, chat reads; a peak Thursday is ₱24,500 (villa's 24 Dec)",
        `${seen.map((d) => d.day).join(',')} · chat write: ${described(chatWrite)} · ${line.basePrice}+${line.extraGuestPrice}+${line.surcharge}=${line.price} "${line.holiday}"`,
      );
    }

    // 23. A holiday with no holiday_price is the weekend rate; with one, that
    //     price. A holidayPrice sent for some rates but not all is refused,
    //     and a rate edit that leaves it out keeps it.
    {
      const before = (await quoteRequest(chat, stay({ checkIn: HOLIDAY, nights: 1 }))).lines[0].basePrice;
      await setRates(probe, hall.id, [{ slotId: night.id, weekdayPrice: 1600000, weekendPrice: 2000000, holidayPrice: 2500000 }]);
      const after = (await quoteRequest(chat, stay({ checkIn: HOLIDAY, nights: 1 }))).lines[0].basePrice;
      const weekday = (await quoteRequest(chat, stay({ checkIn: THU, nights: 1 }))).lines[0].basePrice;
      const mixed = await thrown(() =>
        setRates(probe, family.id, [
          { slotId: night.id, weekdayPrice: 1, weekendPrice: 1, holidayPrice: 5 },
          { slotId: night.id + 100000, weekdayPrice: 1, weekendPrice: 1 },
        ]),
      );
      const kept = (await setRates(probe, hall.id, [{ slotId: night.id, weekdayPrice: 1600000, weekendPrice: 2000000 }])).rates[0].holidayPrice;
      check(
        before === 2000000 && after === 2500000 && weekday === 1600000 && mixed instanceof BookingInputError && kept === 2500000,
        'holiday rate: weekend when unset, holiday_price when set; a rate edit without it keeps it',
        `unset ${before} · set ${after} · weekday ${weekday} · mixed: ${described(mixed)} · kept ${kept}`,
      );
    }

    // 24. THE request, on the chat token: 2 pending rows, one reference, the
    //     receipt's total is the sum of the STORED prices, check-out 12:00
    //     (04:00 UTC) on the third day.
    let receipt;
    {
      receipt = await requestBooking(chat, stay());
      const stored = (await listBookings(probe, { from: THU, to: FRI })).filter((b) => b.reference === receipt.reference);
      const sum = stored.reduce((t, b) => t + b.price, 0);
      check(
        /^ROO-[A-Z2-9]{6}$/.test(receipt.reference) && stored.length === 2 && stored.every((b) => b.status === 'pending' && b.source === 'web')
          && receipt.total === sum && sum === 3700000 && receipt.endsAt === `${next(FRI, 1)}T04:00:00+00:00`,
        'request: 2 pending web rows, one reference, total = the stored prices',
        `${receipt.reference} · ${stored.length} rows ${stored.map((b) => b.status).join(',')} · receipt ${receipt.total}, stored ${sum} · ends ${receipt.endsAt}`,
      );
    }

    // 25. Staff see it as ONE request; a second request for the same nights
    //     is accepted too (a request holds nothing), and neither clashes yet.
    {
      const second = await requestBooking(chat, stay(contact(2)));
      const list = await listRequests(probe, { from: THU });
      const mine = list.filter((r) => [receipt.reference, second.reference].includes(r.reference));
      check(
        mine.length === 2 && mine.every((r) => r.status === 'pending' && r.nights === 2 && r.total === 3700000 && !r.clash && r.bookingIds.length === 2)
          && mine.some((r) => r.guestEmail === 'rooms-probe-1@example.com'),
        'staff list: one row per request; two requests for the same nights, no clash yet',
        mine.map((r) => `${r.reference} ${r.status} ${r.nights}n ${r.total} clash=${r.clash}`).join(' · '),
      );
    }

    // 26. Confirm the first: true, and true again. The second then clashes,
    //     and confirming it is a 409 that changes nothing; declining it is
    //     true. A quote for those nights now says unavailable, and a new
    //     request for them is refused up front (409), nothing saved.
    {
      const find = async (email) => (await listRequests(probe, { from: THU })).find((r) => r.guestEmail === email);
      const firstId = (await find('rooms-probe-1@example.com')).groupId;
      const secondId = (await find('rooms-probe-2@example.com')).groupId;
      const confirmed = await confirmRequest(probe, firstId);
      const again = await confirmRequest(probe, firstId);
      const clashing = await find('rooms-probe-2@example.com');
      const refusedConfirm = await thrown(() => confirmRequest(probe, secondId));
      const stillPending = (await find('rooms-probe-2@example.com')).status;
      const declined = await declineRequest(probe, secondId);
      const afterDecline = (await find('rooms-probe-2@example.com')).status;
      const quoteAfter = await quoteRequest(chat, stay());
      const before = (await listBookings(probe, { from: THU, to: FRI })).length;
      const late = await thrown(() => requestBooking(chat, stay(contact(3))));
      const after = (await listBookings(probe, { from: THU, to: FRI })).length;
      check(
        confirmed && again && clashing.clash && refusedConfirm instanceof BookingConflictError && refusedConfirm.status === 409
          && stillPending === 'pending' && declined && afterDecline === 'cancelled'
          && !quoteAfter.available && late instanceof BookingConflictError && after === before,
        'confirm: whole group; a clashing confirm is 409 and changes nothing; decline; the nights are gone',
        `confirm ${confirmed}/${again} · clash ${clashing.clash} · ${described(refusedConfirm)} · then ${stillPending} · decline ${declined} → ${afterDecline} · quote available ${quoteAfter.available} · late ${described(late)} · rows ${before} → ${after}`,
      );
    }

    // 27. The walls, through the package: villa's unit id is "No such unit or
    //     slot.", exactly as a missing one; a chat token's confirm is false
    //     (RLS: it updates nothing), never an error that tells them apart.
    {
      const foreignUnit = await thrown(() => requestBooking(chat, stay({ rooms: [{ unitId: villaRoom.id, guests: 2 }], ...contact(4) })));
      const foreignQuote = await thrown(() => quoteRequest(chat, stay({ rooms: [{ unitId: villaRoom.id, guests: 2 }] })));
      const anyId = (await listRequests(probe, { from: THU }))[0]?.groupId ?? '00000000-0000-0000-0000-000000000000';
      const chatConfirm = await confirmRequest(chat, anyId);
      check(
        foreignUnit?.message === 'No such unit or slot.' && foreignQuote?.message === 'No such unit or slot.' && chatConfirm === false,
        "walls: villa's unit is 'No such unit or slot.'; a chat token's confirm is false",
        `${described(foreignUnit)} | ${described(foreignQuote)} | chat confirm: ${chatConfirm}`,
      );
    }

    // 28. The contact limit through the package is a 429 (BookingLimitError):
    //     contact 5 sends 3 requests, the 4th is refused.
    {
      const codes = [];
      for (const offset of [200, 210, 220, 230]) {
        const error = await thrown(() => requestBooking(chat, stay({ checkIn: firstOf(offset, [1]), nights: 1, ...contact(5) })));
        codes.push(error ? `${error.name} ${error.status}` : 'ok');
      }
      check(
        codes.join(',') === 'ok,ok,ok,BookingLimitError 429',
        'request: the 4th open request from one contact is a 429',
        codes.join(','),
      );
    }

    // 29. Copying a fixed date to next year, and removing a day, counted: a
    //     second remove is false, and so is a chat token's (RLS: 0 rows).
    {
      const year = Number(PEAK.slice(0, 4)) + 1;
      const copied = await copyCalendarDays(probe, { days: [PEAK], toYear: year });
      const removed = await removeCalendarDay(probe, HOLIDAY);
      const again = await removeCalendarDay(probe, HOLIDAY);
      const chatRemove = await removeCalendarDay(chat, PEAK);
      const left = await listCalendar(probe, { from: PEAK, to: `${year}-12-31` });
      check(
        copied.length === 1 && copied[0].day === `${year}${PEAK.slice(4)}` && copied[0].surcharge === 400000
          && removed && !again && !chatRemove && left.map((d) => d.day).join(',') === `${PEAK},${year}${PEAK.slice(4)}`,
        'calendar: a date copied to next year; remove is counted (again false, chat token false)',
        `copied ${copied.map((d) => d.day).join(',')} · removed ${removed}/${again} · chat ${chatRemove} · left ${left.map((d) => d.day).join(',')}`,
      );
    }
  }

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
