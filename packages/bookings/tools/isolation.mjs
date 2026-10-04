// isolation.mjs — cross-tenant checks for @rag/bookings, through the package.
//
// verify.mjs proves the database refuses cross-tenant WRITES. This proves the
// package does not do cross-tenant READS, which only its tenant_id filters
// prevent (CLAUDE.md rule 6). Same approach as packages/rag/tools/isolation.mjs:
// two tenants that both have bookings, each asked about the other's.
//
// Needs no OpenAI key. It creates:
//   * a throwaway `bookings-probe` tenant with the bookings application, one
//     unit and one slot, deleted at the end (the delete cascades);
//   * ONE booking in villa, 300 days out, HARD-deleted at the end. Cancelling
//     it would leave a row in villa's real history;
//   * (24–29, customer booking Phase 6) holiday days and web requests in the
//     two per_room probes, gone with them.
//
// TWO WALLS (auth-rls Rule 1). By default staff work runs as each tenant's
// OPERATOR member, on a staff token, as the admin routes' does, so both the
// code filters and RLS stand in the way. With --filters-only it runs on the
// service client: RLS bypassed, the tenant_id filters alone. Both must pass.
// Needs: pnpm --filter @rag/db member:operator -- villa (and northwind)
//
// Run:  pnpm --filter @rag/bookings isolation [-- --filters-only]

import { mintTenantToken, scopedClient, staffClient } from '@rag/db';
import { asOperator, operatorEmail, supabase, userIdByEmail } from '@rag/db/service';
import {
  addImage,
  BookingConflictError,
  BookingInputError,
  BookingsNotEnabledError,
  bookingPage,
  cancelBooking,
  checkAvailability,
  checkRoomAvailability,
  confirmRequest,
  createAccommodation,
  createBooking,
  createBookings,
  declineRequest,
  getAccommodation,
  hasBookingPage,
  listAccommodations,
  listBookings,
  listCalendar,
  listImages,
  roomPhotos,
  listRequests,
  listSlots,
  listUnits,
  localDate,
  quote,
  quoteRequest,
  removeCalendarDay,
  removeImage,
  requestBooking,
  setCalendarDay,
  setImageOrder,
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

const { data: tenants, error: tenantError } = await supabase
  .from('tenants')
  .select('id, slug')
  .in('slug', ['villa', 'northwind']);
if (tenantError) throw new Error(tenantError.message);
// Staff work (list, book, cancel) runs as each tenant's operator, or on the
// service client with --filters-only. Availability is what the chatbot asks,
// so it always runs on a CHAT token, as the tool executor's does. That also
// puts the security-definer check_availability's own tenant check in the path.
const filtersOnly = process.argv.includes('--filters-only');
console.log(filtersOnly ? 'WALL: code filters alone (service client, RLS bypassed)' : 'WALL: filters + RLS (operator staff tokens, as the admin routes)');
const staff = (t) => t && (filtersOnly ? { id: t.id, slug: t.slug, db: supabase } : asOperator({ id: t.id, slug: t.slug }));
const chat = (t) => ({ ...t, db: scopedClient(mintTenantToken({ tenantId: t.id })) });
const villa = await staff(tenants.find((t) => t.slug === 'villa'));
const northwind = await staff(tenants.find((t) => t.slug === 'northwind'));
if (!villa || !northwind) throw new Error('Needs tenants villa and northwind');

// 300 days out, in villa's timezone: far enough that no real booking is there.
const day = (offset) => {
  const d = new Date(`${localDate('Asia/Manila')}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
};
const probeDate = day(300);

const { data: probeRow, error: probeError } = await supabase
  .from('tenants')
  .insert({ slug: 'bookings-probe', business_name: 'bookings isolation probe', assistant_name: 'Probe' })
  .select('id, slug')
  .single();
if (probeError) throw new Error(`Could not create the probe tenant: ${probeError.message}`);
// The probe's staff: villa's operator, made a member of the probe for this
// run only (deleting the probe tenant cascades to the membership). So this
// user is a member of BOTH tenants, and the checks below prove a member of
// two tenants still sees only the tenant its token names.
let probeDb = supabase;
if (!filtersOnly) {
  const operatorId = await userIdByEmail(operatorEmail('villa'));
  await supabase.from('memberships').insert({ user_id: operatorId, tenant_id: probeRow.id, role: 'admin' });
  probeDb = (await staffClient(probeRow.id, operatorId))?.db ?? null;
  if (!probeDb) throw new Error('Could not make the probe operator a member');
}
const probe = { id: probeRow.id, slug: probeRow.slug, db: probeDb };

// --- booking types (plan/booking-types.md Phase 7) ----------------------------
// Two throwaway per_room tenants, A and B. A's staff try every new read and
// write against B's room, rate, photo and booking. B is a probe, not a real
// tenant, ON PURPOSE: a failing "cannot delete another tenant's photo" check
// would otherwise delete a real one. Harbor is only READ (its chat token).
// The same villa operator is a member of both, so with RLS on, this proves a
// member of two tenants still acts as only the one its token names.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);
const roomProbes = [];
async function roomProbe(slug) {
  const { data, error } = await supabase
    .from('tenants')
    .insert({ slug, business_name: `rooms isolation ${slug}`, assistant_name: 'Probe' })
    .select('id, slug')
    .single();
  if (error) throw new Error(`Could not create ${slug}: ${error.message}`);
  roomProbes.push(data.id);
  await supabase
    .from('tenant_applications')
    .insert({ tenant_id: data.id, application_key: 'bookings', config: { timezone: 'Asia/Manila', booking_type: 'per_room' } });
  await supabase.from('slots').insert({ tenant_id: data.id, name: 'Night', start_time: '14:00', duration: '22 hours' });
  let db = supabase;
  if (!filtersOnly) {
    const operatorId = await userIdByEmail(operatorEmail('villa'));
    await supabase.from('memberships').insert({ user_id: operatorId, tenant_id: data.id, role: 'admin' });
    db = (await staffClient(data.id, operatorId))?.db ?? null;
    if (!db) throw new Error(`Could not make the operator a member of ${slug}`);
  }
  return { id: data.id, slug: data.slug, db };
}

let villaBookingId = null;
try {
  await supabase
    .from('tenant_applications')
    .insert({ tenant_id: probe.id, application_key: 'bookings', config: { timezone: 'Asia/Manila' } });
  await supabase.from('units').insert({ tenant_id: probe.id, name: 'Probe unit' });
  await supabase.from('slots').insert({ tenant_id: probe.id, name: 'Probe slot', start_time: '09:00', duration: '2 hours' });

  // 1. Northwind has no bookings application: every call is a 404-shaped
  //    error, the same answer "no such route" would give.
  {
    const errors = await Promise.all([
      thrown(() => checkAvailability(chat(northwind), { from: probeDate })),
      thrown(() => listBookings(northwind, { from: probeDate })),
      thrown(() => cancelBooking(northwind, 1)),
    ]);
    check(
      errors.every((e) => e instanceof BookingsNotEnabledError && e.status === 404),
      'northwind: bookings not enabled, 404',
      errors.map((e) => e?.message ?? 'no error').join(' | '),
    );
  }

  // 2. Villa's own setup, through the package.
  const [villaUnits, villaSlots] = await Promise.all([listUnits(villa), listSlots(villa)]);
  check(
    villaUnits.length === 1 && villaSlots.length === 3,
    'villa: 1 unit, 3 slots',
    `${villaUnits.map((u) => u.name).join(', ')} · ${villaSlots.map((s) => `${s.name} ${s.startTime}`).join(', ')}`,
  );

  // 3. A villa booking, then the same slot again: the second is a 409.
  const overnight = villaSlots.find((s) => s.name === 'Overnight');
  const booked = await createBooking(villa, {
    unitId: villaUnits[0].id,
    slotId: overnight.id,
    date: probeDate,
    guestName: 'Isolation Probe',
    guestPhone: '0917-000-0000',
  });
  villaBookingId = booked.id;
  check(booked.status === 'confirmed' && booked.slot === 'Overnight', 'villa: booking created', `#${booked.id} ${booked.date} ${booked.slot}`);

  const again = await thrown(() =>
    createBooking(villa, { unitId: villaUnits[0].id, slotId: overnight.id, date: probeDate, guestName: 'Second' }),
  );
  check(
    again instanceof BookingConflictError && again.status === 409,
    'villa: the same slot again is a 409',
    again?.message ?? 'NO ERROR — double-booked',
  );

  // 4. Villa's availability shows it, and carries no guest data.
  {
    const rows = await checkAvailability(chat(villa), { from: probeDate });
    const keys = [...new Set(rows.flatMap((r) => Object.keys(r)))].sort().join(',');
    const text = JSON.stringify(rows);
    check(
      rows.find((r) => r.slot === 'Overnight')?.status === 'taken',
      'villa: availability shows the booking as taken',
      rows.map((r) => `${r.slot} ${r.status}`).join(', '),
    );
    check(
      keys === 'date,slot,status,unit' && !text.includes('Isolation Probe') && !text.includes('0917'),
      'villa: availability carries no guest data',
      `keys: ${keys}`,
    );
  }

  // 5. The probe tenant, which HAS bookings, cannot see villa's.
  {
    const probeList = await listBookings(probe, { from: probeDate });
    check(
      probeList.length === 0,
      "probe: listBookings does not include villa's booking",
      `${probeList.length} rows`,
    );
    const probeAvailability = await checkAvailability(chat(probe), { from: probeDate });
    check(
      probeAvailability.every((r) => r.unit === 'Probe unit' && r.status === 'open'),
      "probe: availability shows only its own unit, all open",
      probeAvailability.map((r) => `${r.unit}/${r.slot} ${r.status}`).join(', '),
    );
  }

  // 6. The probe cannot cancel villa's booking by id. `false` is "not yours or
  //    not there", indistinguishable on purpose, and the booking is untouched.
  {
    const cancelled = await cancelBooking(probe, villaBookingId);
    const { data: still } = await supabase.from('bookings').select('status').eq('id', villaBookingId).single();
    check(
      cancelled === false && still.status === 'confirmed',
      "probe: cannot cancel villa's booking",
      `returned ${cancelled}, villa's is still ${still.status}`,
    );
    const nobody = await cancelBooking(probe, 999_999_999);
    check(nobody === false, 'probe: a nonexistent id gives the same false', `returned ${nobody}`);
  }

  // 7. The probe cannot book villa's unit. The message is the same one a
  //    nonexistent id gets, so unit ids cannot be enumerated.
  {
    const probeSlots = await listSlots(probe);
    const crossTenant = await thrown(() =>
      createBooking(probe, { unitId: villaUnits[0].id, slotId: probeSlots[0].id, date: probeDate, guestName: 'x' }),
    );
    const nonexistent = await thrown(() =>
      createBooking(probe, { unitId: 999_999_999, slotId: probeSlots[0].id, date: probeDate, guestName: 'x' }),
    );
    check(
      crossTenant instanceof BookingInputError &&
        nonexistent instanceof BookingInputError &&
        crossTenant.message === nonexistent.message,
      "probe: villa's unit looks exactly like no unit",
      `"${crossTenant?.message}" vs "${nonexistent?.message}"`,
    );
  }

  // 8. A past date is refused, measured against the tenant's today.
  {
    const past = await thrown(() => checkAvailability(chat(villa), { from: day(-1) }));
    check(
      past instanceof BookingInputError && past.message.includes('is in the past'),
      'villa: yesterday is refused',
      past?.message ?? 'NO ERROR',
    );
  }
  // 13–22. Booking types: A cannot reach B's rooms, rates, photos, bookings.
  const a = await roomProbe('rooms-iso-a');
  const b = await roomProbe('rooms-iso-b');
  const [aNight] = await listSlots(a);
  const [bNight] = await listSlots(b);
  const aRoom = await createAccommodation(a, { name: 'A Room', capacity: 2 });
  const bRoom = await createAccommodation(b, { name: 'B Room', capacity: 2 });
  await setRates(a, aRoom.id, [{ slotId: aNight.id, weekdayPrice: 100000, weekendPrice: 100000 }]);
  await setRates(b, bRoom.id, [{ slotId: bNight.id, weekdayPrice: 200000, weekendPrice: 200000 }]);
  const bPhoto = await addImage(b, bRoom.id, PNG);
  const bBooked = await createBookings(b, { unitId: bRoom.id, guestCount: 1, slotId: bNight.id, date: probeDate, guestName: 'B Guest' });
  const bState = async () => {
    const { data: unit } = await supabase.from('units').select('name, capacity, standard_capacity, extra_person_rate, active').eq('id', bRoom.id).single();
    const { data: rate } = await supabase.from('unit_rates').select('weekday_price').eq('unit_id', bRoom.id).single();
    const { data: objects } = await supabase.storage.from('unit-images').list(`${b.id}/${bRoom.id}`);
    const { data: photo } = await supabase.from('unit_images').select('sort_order').eq('id', bPhoto.id).single();
    return JSON.stringify({ unit, rate, objects: objects?.length, photo });
  };
  const before = await bState();

  // 13. A's staff list only A's rooms, and B's room reads as "not there".
  {
    const list = await listAccommodations(a);
    const got = await getAccommodation(a, bRoom.id);
    check(
      list.map((r) => r.name).join(',') === 'A Room' && got === null,
      "rooms A: lists only its own rooms; B's room is null",
      `${list.map((r) => r.name).join(',')} · B's room: ${got}`,
    );
  }

  // 14. A cannot change B's room, its rates, or its photo's order; each is
  //     `null`/`false`, like a room that does not exist.
  {
    const renamed = await updateAccommodation(a, bRoom.id, { name: 'Hijacked', active: false });
    const repriced = await setRates(a, bRoom.id, [{ slotId: aNight.id, weekdayPrice: 1, weekendPrice: 1 }]);
    const reordered = await setImageOrder(a, bRoom.id, bPhoto.id, 9);
    const missing = await updateAccommodation(a, 999_999_999, { name: 'x' });
    check(
      renamed === null && repriced === null && reordered === false && missing === null,
      "rooms A: cannot change B's room, rates or photo order",
      `rename ${renamed} · rates ${repriced} · order ${reordered} · a missing room ${missing}`,
    );
  }

  // 15. A cannot remove B's photo, even naming B's room, and cannot add one to it.
  {
    const removed = await removeImage(a, bRoom.id, bPhoto.id);
    const added = await addImage(a, bRoom.id, PNG);
    const photos = await listImages(a, bRoom.id);
    check(
      removed === false && added === null && photos.length === 0,
      "rooms A: cannot remove, add or list B's photos",
      `remove ${removed} · add ${added} · list ${photos.length}`,
    );
  }

  // 16. B's room, rate, object and photo row are exactly as they were.
  {
    const after = await bState();
    check(after === before, "rooms B: untouched by everything A tried", after);
  }

  // 16b. The chat's room cards (D-094): A's photos by room name hold none of
  // B's rooms and none of B's photo URLs, on A's own token.
  {
    const cards = await roomPhotos(a);
    const names = cards.map((c) => c.name);
    const urls = cards.flatMap((c) => c.photos);
    check(
      !names.includes(bRoom.name) && !urls.some((u) => u.includes(bPhoto.path)),
      "rooms A: roomPhotos() lists A's rooms only, none of B's photos",
      `rooms ${names.join(', ')} · urls ${urls.length}`,
    );
  }

  // 17. A cannot quote or book B's room: the message is the one a missing room
  //     gets. A group of A's room + B's room saves NEITHER (one statement).
  {
    const quoted = await thrown(() => quote(a, { unitId: bRoom.id, slotId: aNight.id, date: probeDate }));
    const nowhere = await thrown(() => quote(a, { unitId: 999_999_999, slotId: aNight.id, date: probeDate }));
    const group = await thrown(() =>
      createBookings(a, { rooms: [{ unitId: aRoom.id, guestCount: 1 }, { unitId: bRoom.id, guestCount: 1 }], slotId: aNight.id, date: probeDate, guestName: 'x' }),
    );
    const aRows = await listBookings(a, { from: probeDate });
    check(
      quoted instanceof BookingInputError && quoted.message === nowhere?.message
        && group instanceof BookingInputError && group.message === 'No such unit or slot.' && aRows.length === 0,
      "rooms A: B's room quotes and books like no room, and a mixed group saves nothing",
      `quote "${quoted?.message}" vs "${nowhere?.message}" · group "${group?.message}" · A's rows ${aRows.length}`,
    );
  }

  // 18. A's room filter with B's room id: [], though B has a booking there.
  {
    const filtered = await listBookings(a, { from: probeDate }, { unitId: bRoom.id });
    const own = await listBookings(b, { from: probeDate });
    check(
      filtered.length === 0 && own.length === 1 && own[0].id === bBooked.bookings[0].id,
      "rooms A: filtering by B's room shows nothing; B sees its booking",
      `A filtered ${filtered.length} · B ${own.length}`,
    );
  }

  // 19–20. Room availability, on CHAT tokens as the chatbot asks: each probe
  //        sees only its own room, and harbor (real, read only) neither.
  {
    const ra = await checkRoomAvailability(chat(a), { from: probeDate });
    const rb = await checkRoomAvailability(chat(b), { from: probeDate });
    check(
      ra.map((r) => `${r.unit} ${r.status}`).join(',') === 'A Room open' && rb.map((r) => `${r.unit} ${r.status}`).join(',') === 'B Room taken',
      'rooms: each tenant\'s room availability is its own',
      `A: ${ra.map((r) => `${r.unit} ${r.status}`).join(',')} · B: ${rb.map((r) => `${r.unit} ${r.status}`).join(',')}`,
    );
    const { data: harborRow } = await supabase.from('tenants').select('id, slug').eq('slug', 'harbor').single();
    const rh = await checkRoomAvailability(chat(harborRow), { from: probeDate });
    check(
      rh.length > 0 && !rh.some((r) => r.unit === 'A Room' || r.unit === 'B Room'),
      "harbor: its rooms only, no probe's",
      [...new Set(rh.map((r) => r.unit))].join(', '),
    );
  }

  // 21. A whole-resort tenant (villa) reaches no room function at all.
  {
    const errors = await Promise.all([
      thrown(() => listAccommodations(villa)),
      thrown(() => getAccommodation(villa, bRoom.id)),
      thrown(() => checkRoomAvailability(chat(villa), { from: probeDate })),
    ]);
    check(
      errors.every((e) => e?.status === 404),
      'villa: every room function is a 404',
      errors.map((e) => e?.message ?? 'no error').join(' | '),
    );
  }

  // 23. plan/extra-guests.md Phase 5: A cannot change B's extra-guest
  //     settings, nor price a party in B's room. B's room was created with
  //     the defaults (standard 2, ₱250), so its state already carries them,
  //     and check 16's before/after comparison covers them too.
  {
    const changed = await updateAccommodation(a, bRoom.id, { standardCapacity: 1, extraPersonRate: 0, maxCapacity: 9 });
    const party = await thrown(() => quote(a, { unitId: bRoom.id, guestCount: 2, slotId: aNight.id, date: probeDate }));
    const { data: unit } = await supabase.from('units').select('standard_capacity, extra_person_rate, capacity').eq('id', bRoom.id).single();
    check(
      changed === null && party instanceof BookingInputError && party.message === 'No such unit or slot.'
        && unit.standard_capacity === 2 && unit.extra_person_rate === 25000 && unit.capacity === 2,
      "rooms A: cannot change B's standard, fee or maximum, nor quote a party in B's room",
      `update ${changed} · quote "${party?.message}" · B still ${unit.standard_capacity}/${unit.capacity} +${unit.extra_person_rate}`,
    );
  }

  // 24–29. plan/customer-booking.md Phase 6: the holiday calendar, the
  //        public page's reads, and web requests, each across A and B.
  //        Requests run on CHAT tokens in both modes, as the public page's
  //        do; the staff side (list, confirm, decline) follows the mode.
  const REQ_DATE = day(310);
  const contact = (n) => ({ name: 'Isolation Probe', phone: `0917000${String(n).padStart(4, '0')}`, email: `iso-${n}@example.com` });
  const webRows = async (tenant) =>
    (await supabase.from('bookings').select('id, status, group_id').eq('tenant_id', tenant.id).eq('source', 'web')).data ?? [];

  // 24. B's staff list a peak day; A's list does not show it, B's chat token
  //     does; A cannot remove it (false, and it stays). A then lists a day of
  //     its own on the SAME date: one date, two tenants, two entries.
  {
    await setCalendarDay(b, { day: REQ_DATE, kind: 'peak', label: 'B peak', surcharge: 50000 });
    const aBefore = await listCalendar(a, { from: REQ_DATE, to: REQ_DATE });
    const bSees = await listCalendar(chat(b), { from: REQ_DATE, to: REQ_DATE });
    const removed = await removeCalendarDay(a, REQ_DATE);
    await setCalendarDay(a, { day: REQ_DATE, label: 'A day' });
    const aAfter = await listCalendar(a, { from: REQ_DATE, to: REQ_DATE });
    const { data: bStill } = await supabase.from('rate_calendar').select('label, surcharge').eq('tenant_id', b.id).eq('day', REQ_DATE).single();
    check(
      aBefore.length === 0 && bSees.length === 1 && bSees[0].surcharge === 50000 && removed === false
        && aAfter.map((d) => d.label).join(',') === 'A day' && bStill?.label === 'B peak' && bStill.surcharge === 50000,
      "calendar: A sees none of B's days, cannot remove one, and keeps its own entry on the same date",
      `A before ${aBefore.length} · B sees ${bSees.length} · A remove ${removed} · A after ${aAfter.map((d) => d.label).join(',')} · B still "${bStill?.label}" +${bStill?.surcharge}`,
    );
  }

  // 25. The price follows the tenant's OWN calendar: on the same date A's
  //     room has no surcharge and B's has ₱500 (unit_price's tenant filter,
  //     in SQL, so the same in both modes).
  {
    const qa = await quoteRequest(chat(a), { slotId: aNight.id, rooms: [{ unitId: aRoom.id, guests: 1 }], checkIn: REQ_DATE, nights: 1 });
    const qb = await quoteRequest(chat(b), { slotId: bNight.id, rooms: [{ unitId: bRoom.id, guests: 1 }], checkIn: REQ_DATE, nights: 1 });
    const la = qa.lines[0];
    const lb = qb.lines[0];
    check(
      la.surcharge === 0 && la.price === 100000 && la.holiday === 'A day' && lb.surcharge === 50000 && lb.price === 250000 && lb.holiday === 'B peak',
      "calendar: each tenant's quote carries its own day and surcharge",
      `A ${la.basePrice}+${la.surcharge}=${la.price} "${la.holiday}" · B ${lb.basePrice}+${lb.surcharge}=${lb.price} "${lb.holiday}"`,
    );
  }

  // 26. The public page's reads on A's chat token: only A's room and A's
  //     calendar; B's room quotes like no room; northwind has no page.
  {
    const page = await bookingPage(chat(a));
    const foreign = await thrown(() => quoteRequest(chat(a), { slotId: aNight.id, rooms: [{ unitId: bRoom.id, guests: 1 }], checkIn: REQ_DATE, nights: 1 }));
    const nowhere = await thrown(() => quoteRequest(chat(a), { slotId: aNight.id, rooms: [{ unitId: 999_999_999, guests: 1 }], checkIn: REQ_DATE, nights: 1 }));
    const hasA = await hasBookingPage(chat(a));
    const hasNorthwind = await hasBookingPage(chat(northwind));
    check(
      page.units.map((u) => u.name).join(',') === 'A Room' && page.calendar.map((d) => d.label).join(',') === 'A day'
        && foreign instanceof BookingInputError && foreign.message === nowhere?.message && hasA === true && hasNorthwind === false,
      "page A: its own room and calendar; B's room quotes like no room; northwind has no page",
      `units ${page.units.map((u) => u.name).join(',')} · calendar ${page.calendar.map((d) => d.label).join(',')} · "${foreign?.message}" vs "${nowhere?.message}" · pages A ${hasA}, northwind ${hasNorthwind}`,
    );
  }

  // 27. A's chat token cannot request B's room: "No such unit or slot.", and
  //     NO row lands in either tenant. B's own request lands, pending.
  let bGroup = null;
  {
    const foreign = await thrown(() =>
      requestBooking(chat(a), { slotId: aNight.id, rooms: [{ unitId: bRoom.id, guests: 1 }], checkIn: REQ_DATE, nights: 1, ...contact(1) }),
    );
    const [aRows, bRows] = await Promise.all([webRows(a), webRows(b)]);
    const own = await requestBooking(chat(b), { slotId: bNight.id, rooms: [{ unitId: bRoom.id, guests: 1 }], checkIn: REQ_DATE, nights: 1, ...contact(2) });
    const bAfter = await webRows(b);
    bGroup = bAfter[0]?.group_id ?? null;
    check(
      foreign instanceof BookingInputError && foreign.message === 'No such unit or slot.' && aRows.length === 0 && bRows.length === 0
        && /^ROO-/.test(own.reference) && own.total === 250000 && bAfter.length === 1 && bAfter[0].status === 'pending',
      "request A→B's room: refused, nothing saved anywhere; B's own request is pending in B",
      `"${foreign?.message}" · rows A ${aRows.length}, B ${bRows.length} · B's own ${own.reference} ${own.total} → ${bAfter.map((r) => r.status).join(',')}`,
    );
  }

  // 28. A's staff do not see B's request, and cannot confirm or decline it:
  //     false, like a request that does not exist, and B's stays pending.
  {
    const aList = await listRequests(a, { from: REQ_DATE });
    const bList = await listRequests(b, { from: REQ_DATE });
    const confirmed = await confirmRequest(a, bGroup);
    const declined = await declineRequest(a, bGroup);
    const missing = await confirmRequest(a, '00000000-0000-0000-0000-000000000000');
    const still = (await webRows(b)).map((r) => r.status).join(',');
    check(
      aList.length === 0 && bList.length === 1 && bList[0].groupId === bGroup && confirmed === false && declined === false && missing === false && still === 'pending',
      "requests A: sees none of B's; cannot confirm or decline B's (false, like a missing id); B's stays pending",
      `A list ${aList.length} · B list ${bList.length} · confirm ${confirmed} · decline ${declined} · missing ${missing} · B still ${still}`,
    );
  }

  // 29. The positive twin: B confirms its own request, and every row of the
  //     group is confirmed; A's availability on that date is untouched.
  {
    const confirmed = await confirmRequest(b, bGroup);
    const rows = (await webRows(b)).map((r) => r.status).join(',');
    const aOpen = (await checkRoomAvailability(chat(a), { from: REQ_DATE })).map((r) => `${r.unit} ${r.status}`).join(',');
    const bTaken = (await checkRoomAvailability(chat(b), { from: REQ_DATE })).map((r) => `${r.unit} ${r.status}`).join(',');
    check(
      confirmed === true && rows === 'confirmed' && aOpen === 'A Room open' && bTaken === 'B Room taken',
      "requests B: confirms its own; A's room stays open, B's is taken",
      `confirm ${confirmed} · B rows ${rows} · A ${aOpen} · B ${bTaken}`,
    );
  }

  // 22. B's photo is on the public URL (the twin of 15's refusals), and B
  //     can remove it itself.
  {
    const served = await fetch(bPhoto.url);
    const removed = await removeImage(b, bRoom.id, bPhoto.id);
    const { data: objects } = await supabase.storage.from('unit-images').list(`${b.id}/${bRoom.id}`);
    check(
      served.status === 200 && removed === true && objects?.length === 0,
      'rooms B: its own photo is served, and it can remove it',
      `served ${served.status} · removed ${removed} · objects left ${objects?.length}`,
    );
  }
} finally {
  for (const id of roomProbes) {
    const { data: folders } = await supabase.storage.from('unit-images').list(`${id}`);
    for (const folder of folders ?? []) {
      const { data: files } = await supabase.storage.from('unit-images').list(`${id}/${folder.name}`);
      if (files?.length) await supabase.storage.from('unit-images').remove(files.map((f) => `${id}/${folder.name}/${f.name}`));
    }
  }
  if (roomProbes.length) await supabase.from('tenants').delete().in('id', roomProbes);
  if (villaBookingId !== null) {
    const { error } = await supabase.from('bookings').delete().eq('tenant_id', villa.id).eq('id', villaBookingId);
    if (error) console.log(`WARN  could not delete villa probe booking #${villaBookingId}: ${error.message}`);
  }
  const { error } = await supabase.from('tenants').delete().eq('id', probe.id);
  if (error) console.log(`WARN  could not delete the bookings-probe tenant: ${error.message}`);
}

console.log(failures === 0 ? '\nALL BOOKINGS ISOLATION CHECKS PASS' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
