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
//     two per_room probes, gone with them;
//   * (30, manage booking) a proof object, a payment and a change request on
//     B's request, gone with the probe (the object removed and counted);
//   * (31, notifications) three push devices and northwind's operator as
//     B's staff, gone with the probes (the deletes cascade).
//
// TWO WALLS (auth-rls Rule 1). By default staff work runs as each tenant's
// OPERATOR member, on a staff token, as the admin routes' does, so both the
// code filters and RLS stand in the way. With --filters-only it runs on the
// service client: RLS bypassed, the tenant_id filters alone. Both must pass.
// Needs: pnpm --filter @rag/db member:operator -- villa (and northwind; 31
// makes northwind's operator a member of a probe).
//
// Run:  pnpm --filter @rag/bookings isolation [-- --filters-only]

import { randomUUID } from 'node:crypto';
import { mintTenantToken, scopedClient, staffClient } from '@rag/db';
import { asOperator, operatorEmail, supabase, userIdByEmail } from '@rag/db/service';
import {
  addImage,
  addUnitRoom,
  deleteUnitRoom,
  moveOptions,
  moveStay,
  updateUnitRoom,
  BookingConflictError,
  BookingInputError,
  BookingsNotEnabledError,
  bookingPage,
  calendarDayBookings,
  calendarDays,
  calendarSlots,
  cancelBooking,
  checkAvailability,
  checkRoomAvailability,
  confirmRequest,
  createAccommodation,
  createBooking,
  createBookings,
  declineRequest,
  deviceCount,
  deviceOf,
  getAccommodation,
  guestStay,
  listChanges,
  listPayments,
  markNotificationsRead,
  notificationFeed,
  proofUrl,
  stayHistory,
  hasBookingPage,
  listAccommodations,
  listBookings,
  listCalendar,
  listImages,
  roomPhotos,
  createPromo,
  deletePromo,
  listPromos,
  retirePromo,
  updatePromo,
  listRequests,
  listSlots,
  listUnits,
  localDate,
  quote,
  quoteRequest,
  removeCalendarDay,
  removeAllDevices,
  removeDevice,
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
const proofObjects = [];
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
    status: 'confirmed', // D-095: a seeded booking must take the span
  });
  villaBookingId = booked.id;
  check(booked.status === 'confirmed' && booked.slot === 'Overnight', 'villa: booking created', `#${booked.id} ${booked.date} ${booked.slot}`);

  const again = await thrown(() =>
    // D-095: only a CONFIRMED booking can clash; a pending one would be allowed and left behind.
    createBooking(villa, { unitId: villaUnits[0].id, slotId: overnight.id, date: probeDate, guestName: 'Second', status: 'confirmed' }),
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
  const bBooked = await createBookings(b, { unitId: bRoom.id, guestCount: 1, slotId: bNight.id, date: probeDate, guestName: 'B Guest', status: 'confirmed' });
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

  // 16c. Promos (D-097): B's promo is invisible to A's list, untouchable by
  //      A's edit, retire and delete, "No such promo code" to A's customer
  //      quoting with B's code, and "No such promo." to A's staff booking
  //      with B's promo id. B's promo is as it was.
  {
    const bPromo = await createPromo(b, { name: 'B only', kind: 'percent', value: 1000, validFrom: probeDate, validTo: probeDate, code: 'B-ONLY' });
    const aList = await listPromos(a, { all: true });
    const edited = await updatePromo(a, bPromo.id, { name: 'hijacked' });
    const retired = await retirePromo(a, bPromo.id);
    const deleted = await deletePromo(a, bPromo.id);
    const quoted = await quoteRequest(chat(a), { slotId: aNight.id, rooms: [{ unitId: aRoom.id, guests: 1 }], checkIn: probeDate, nights: 1, promoCode: 'B-ONLY' });
    let booked = null;
    try {
      await createBookings(a, { unitId: aRoom.id, guestCount: 1, slotId: aNight.id, date: probeDate, guestName: 'A with B promo', promoId: bPromo.id });
    } catch (error) {
      booked = error;
    }
    const { data: still } = await supabase.from('promos').select('name, active').eq('id', bPromo.id).single();
    check(
      aList.every((p) => p.id !== bPromo.id) && edited === null && retired === false && deleted === false
        && quoted.promo === null && quoted.discount === 0 && quoted.promoMessage === 'No such promo code.'
        && booked instanceof BookingInputError && booked.message === 'No such promo.'
        && still?.name === 'B only' && still?.active === true,
      "promos A: B's promo is unlisted, unedited, unretired, undeleted; B's code is no code to A's customer; B's id no promo to A's staff",
      `list ${aList.length} · edit ${edited} · retire ${retired} · delete ${deleted} · quote "${quoted.promoMessage}" · book ${booked?.message ?? 'BOOKED'} · B still "${still?.name}" active ${still?.active}`,
    );
  }

  // 16d. The staff calendar (D-103): B's confirmed night and B's pending
  //      request are on B's calendar (the positive twin) and nowhere on A's;
  //      A naming B's room reads no slot rows, and its days have nothing to
  //      sell rather than B's counts.
  {
    const nextDay = day(301);
    await createBookings(b, { unitId: bRoom.id, guestCount: 1, slotId: bNight.id, date: nextDay, guestName: 'B Pending' });
    const range = { from: probeDate, to: nextDay };
    const aDays = (await calendarDays(a, range)).days;
    const bDays = (await calendarDays(b, range)).days;
    const aOnB = await calendarSlots(a, range, { unitId: bRoom.id });
    const aOnBDays = (await calendarDays(a, range, { unitId: bRoom.id })).days;
    const counts = (days) => days.map((d) => `${d.taken}/${d.sellable}p${d.pending}`).join(' ');
    // The Day view's guests: B's on B's day, none on A's, none for A naming B's room.
    const bGuests = (await calendarDayBookings(b, probeDate)).map((r) => r.booking.guestName);
    const aGuests = (await calendarDayBookings(a, probeDate)).map((r) => r.booking.guestName);
    const aOnBGuests = await calendarDayBookings(a, probeDate, { unitId: bRoom.id });
    check(
      bDays[0]?.taken === 1 && bDays[1]?.pending === 1
        && aDays.every((d) => d.taken === 0 && d.pending === 0)
        && aOnB.length === 0 && aOnBDays.every((d) => d.state === 'none' && d.taken === 0 && d.pending === 0)
        && bGuests.includes('B Guest') && !aGuests.includes('B Guest') && aOnBGuests.length === 0,
      "calendar A: B's confirmed night, pending request and guest are on B's calendar and not A's; A naming B's room reads nothing",
      `B ${counts(bDays)} · A ${counts(aDays)} · A on B's room ${aOnB.length} slots, ${aOnBDays.map((d) => d.state).join(',')} · guests B [${bGuests}] A [${aGuests}] A on B ${aOnBGuests.length}`,
    );
  }

  // 16e. Room types (plan/room-types.md Phase 6, D-133): A cannot read B's
  //      physical rooms, add one to B's type, rename, retire or delete one,
  //      or move B's booking, each refused like a room that is not there.
  //      The positive twin: B adds a room and moves its own booking to it,
  //      then moves it back and retires the room, so later checks see one.
  {
    const { data: bRooms } = await supabase.from('unit_rooms').select('id, name, active').eq('unit_id', bRoom.id);
    const bRoomId = bRooms[0].id;
    const bBookingId = bBooked.bookings[0].id;
    const seen = (await listAccommodations(a)).flatMap((r) => r.rooms.map((x) => x.name));
    // Wall 2 alone: an unfiltered read of the table under A's token. On the
    // service client (filters only) the same read would bypass RLS, so it is
    // RLS's check and is skipped there.
    const raw = filtersOnly ? null : (await a.db.from('unit_rooms').select('id')).data?.filter((r) => bRooms.some((x) => x.id === r.id)).length;
    const added = await addUnitRoom(a, bRoom.id, 'Hijack 2');
    const renamed = await updateUnitRoom(a, bRoom.id, bRoomId, { name: 'Hijacked' });
    const retired = await updateUnitRoom(a, bRoom.id, bRoomId, { active: false });
    const deleted = await deleteUnitRoom(a, bRoom.id, bRoomId);
    const options = await moveOptions(a, bBookingId);
    // move_room() is a definer that asks for a staff token of the tenant
    // itself; the service client is no one's staff, so on filters alone the
    // move is not callable at all and is skipped (null = skipped there).
    const moved = filtersOnly ? null : await moveStay(a, bBookingId, bRoomId, 'iso: not yours');
    const { data: after } = await supabase.from('unit_rooms').select('id, name, active').eq('unit_id', bRoom.id);
    const { data: row } = await supabase.from('bookings').select('room_id').eq('id', bBookingId).single();
    check(
      !seen.includes(bRooms[0].name) && (raw === null || raw === 0) && added === null && renamed === false && retired === false
        && deleted === false && options === null && moved === null && JSON.stringify(after) === JSON.stringify(bRooms) && row.room_id === bRoomId,
      "room types A: cannot read, add, rename, retire, delete or move B's rooms (null/false); B's rooms and booking unchanged",
      `A sees ${seen.join(',')} · raw ${raw ?? 'skipped'} · add ${added} · rename ${renamed} · retire ${retired} · delete ${deleted} · options ${options} · move ${moved} · B rooms ${after.length}`,
    );

    const second = await addUnitRoom(b, bRoom.id, 'B Room 2');
    const offered = (await moveOptions(b, bBookingId))?.rooms.find((r) => r.id === second);
    const there = filtersOnly ? 1 : await moveStay(b, bBookingId, second, 'iso: the positive twin');
    const { data: moved2 } = await supabase.from('bookings').select('room_id').eq('id', bBookingId).single();
    const back = filtersOnly ? 1 : await moveStay(b, bBookingId, bRoomId, 'iso: back again');
    const off = await updateUnitRoom(b, bRoom.id, second, { active: false });
    check(
      second !== null && offered?.free === true && there === 1 && (filtersOnly || moved2.room_id === second) && back === 1 && off === true,
      `room types B: adds its own room${filtersOnly ? '' : ', moves its booking there and back'}, retires it`,
      `added #${second} · offered free ${offered?.free} · ${filtersOnly ? 'moves skipped (a definer, staff tokens only)' : `moved ${there} (row on #${moved2.room_id}) · back ${back}`} · retired ${off}`,
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
    // D-100: listRequests() lists staff stays too, so B's list is counted by
    // source; A's must be empty whatever B holds.
    const bWeb = bList.filter((r) => r.source === 'web');
    check(
      aList.length === 0 && bWeb.length === 1 && bWeb[0].groupId === bGroup && bList.every((r) => r.source === 'web' || r.source === 'staff')
        && confirmed === false && declined === false && missing === false && still === 'pending',
      "requests A: sees none of B's (web or staff); cannot confirm or decline B's (false, like a missing id); B's stays pending",
      `A list ${aList.length} · B list ${bList.length} (${bWeb.length} web) · confirm ${confirmed} · decline ${declined} · missing ${missing} · B still ${still}`,
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

  // 30. Manage booking (plan/manage-booking.md Phase 8): B's request gets a
  //     proof, a payment row and a change request (seeded as the tools'
  //     service client, which is not under test). A's staff see none of them
  //     in the queue, the change requests or the stay's history, and cannot
  //     sign B's proof; a guest on A's chat token cannot find B's stay with
  //     B's own reference and email. Each with B's twin.
  {
    const proofPath = `${b.id}/incoming/${'0'.repeat(8)}-0000-4000-8000-${String(Date.now()).padStart(12, '0').slice(-12)}.png`;
    const up = await supabase.storage.from('payment-proofs').upload(proofPath, PNG, { contentType: 'image/png', upsert: false });
    if (up.error) throw new Error(`proof: ${up.error.message}`);
    proofObjects.push(proofPath);
    const { data: pay, error: payError } = await supabase.from('payments')
      .insert({ tenant_id: b.id, group_id: bGroup, method: 'GCash', claimed_amount: 1000, paid_on: REQ_DATE, proof_path: proofPath, idempotency_key: '11111111-2222-4333-8444-555555555555' })
      .select('id').single();
    if (payError) throw new Error(`payment: ${payError.message}`);
    const ch = await supabase.from('change_requests').insert({ tenant_id: b.id, group_id: bGroup, kind: 'cancel', refund_due: 0 });
    if (ch.error) throw new Error(`change: ${ch.error.message}`);
    const { data: bStay } = await supabase.from('stays').select('reference').eq('tenant_id', b.id).eq('group_id', bGroup).single();

    const [aPays, bPays, aChanges, bChanges, aHistory, bHistory, aProof, bProof] = await Promise.all([
      listPayments(a, 'all'), listPayments(b, 'all'),
      listChanges(a, 'all'), listChanges(b, 'all'),
      stayHistory(a, bGroup), stayHistory(b, bGroup),
      proofUrl(a, pay.id), proofUrl(b, pay.id),
    ]);
    const aGuest = await guestStay(chat(a), bStay.reference, contact(2).email);
    const bGuest = await guestStay(chat(b), bStay.reference, contact(2).email);
    check(
      aPays.length === 0 && bPays.length === 1 && aChanges.length === 0 && bChanges.length === 1
        && aHistory.length === 0 && bHistory.length > 0 && aProof === null && typeof bProof === 'string'
        && aGuest === null && bGuest?.reference === bStay.reference,
      "manage A: none of B's payments, change requests, history or proof; B's guest is not found on A's page; B sees all of it",
      `payments A ${aPays.length} B ${bPays.length} · changes A ${aChanges.length} B ${bChanges.length} · history A ${aHistory.length} B ${bHistory.length} · proof A ${aProof === null ? 'null' : 'SIGNED'} B ${bProof ? 'signed' : 'null'} · guest A ${aGuest?.reference ?? 'null'} B ${bGuest?.reference}`,
    );
  }

  // 31. Notifications (plan/notifications.md Phase 6, Rule 3): A's web
  //     request reaches no B-only member, and B's news reaches nobody in A.
  //     Northwind's operator joins B as STAFF for this run: a member of B
  //     only. Villa's operator has a device in A AND one in B, so a person
  //     in two tenants is told only by the tenant the event is in. Devices
  //     are seeded on the service client (not under test, as 30's proof);
  //     the package's device reads follow the mode. The drain's claim runs
  //     on CHAT tokens in both modes, as book/request's does: inside
  //     notify_claim() the tenant filter is the code wall, its token check
  //     the database's. The claim is called directly, not drainNotifications(),
  //     which would POST to the fake endpoints.
  {
    const KEYS = { p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4', auth: 'BTBZMqHH6r4Tts7J_aSIgg' };
    const endpoint = (who) => `https://fcm.googleapis.com/fcm/send/iso-${who}-${randomUUID()}`;
    const operatorId = await userIdByEmail(operatorEmail('villa'));
    const outsiderId = await userIdByEmail(operatorEmail('northwind'));
    if (!operatorId || !outsiderId) throw new Error('Needs the villa and northwind operators (member:operator)');
    // With --filters-only roomProbe() made no memberships; a device needs one (its foreign key).
    if (filtersOnly) await supabase.from('memberships').insert([a.id, b.id].map((tenant_id) => ({ user_id: operatorId, tenant_id, role: 'admin' })));
    await supabase.from('memberships').insert({ user_id: outsiderId, tenant_id: b.id, role: 'staff' });
    const devices = { a: endpoint('a-operator'), b: endpoint('b-operator'), outsider: endpoint('b-staff') };
    const seeded = await supabase.from('push_subscriptions').insert([
      { tenant_id: a.id, user_id: operatorId, endpoint: devices.a, ...KEYS },
      { tenant_id: b.id, user_id: operatorId, endpoint: devices.b, ...KEYS },
      { tenant_id: b.id, user_id: outsiderId, endpoint: devices.outsider, ...KEYS },
    ]);
    if (seeded.error) throw new Error(`devices: ${seeded.error.message}`);

    const own = await requestBooking(chat(a), { slotId: aNight.id, rooms: [{ unitId: aRoom.id, guests: 1 }], checkIn: REQ_DATE, nights: 1, ...contact(3) });
    const outboxOf = async (t) => (await supabase.from('notification_outbox').select('id, kind, reference, claimed_at, sent_at').eq('tenant_id', t.id).order('id')).data ?? [];
    const devicesOf = async (t) => (await supabase.from('push_subscriptions').select('endpoint, last_ok_at').eq('tenant_id', t.id)).data ?? [];
    const [aBox, bBox] = await Promise.all([outboxOf(a), outboxOf(b)]);

    // 31a. A's staff cannot read or remove B's devices, even the same
    //      person's; B's twin reads its own.
    const [aSeesB, aSeesOutsider, aRemovesB, aRemovesOutsider, aOwn, bOwn] = await Promise.all([
      deviceOf(a, devices.b), deviceOf(a, devices.outsider),
      removeDevice(a, devices.b), removeDevice(a, devices.outsider),
      deviceOf(a, devices.a), deviceOf(b, devices.b),
    ]);
    const bDevices = await devicesOf(b);
    check(
      aSeesB === null && aSeesOutsider === null && aRemovesB === false && aRemovesOutsider === false
        && aOwn?.kinds.length === 3 && bOwn?.kinds.length === 3 && bDevices.length === 2,
      "notify devices A: cannot read or remove B's (the same member's either); each reads its own; B keeps both",
      `A reads B ${aSeesB ? 'FOUND' : 'null'}, B-staff ${aSeesOutsider ? 'FOUND' : 'null'} · removes ${aRemovesB}/${aRemovesOutsider} · own A ${aOwn?.kinds.length ?? 'null'} B ${bOwn?.kinds.length ?? 'null'} · B devices ${bDevices.length}`,
    );

    // 31b. Each outbox holds only its own tenant's news: A's request in A, none in B.
    check(
      aBox.length === 1 && aBox[0].kind === 'request' && aBox[0].reference === own.reference
        && bBox.length > 0 && bBox.every((r) => r.reference !== own.reference),
      "notify outbox: A's request is one row in A and none in B",
      `A ${aBox.map((r) => `${r.kind} ${r.reference}`).join(', ')} · B ${bBox.map((r) => `${r.kind} ${r.reference}`).join(', ')}`,
    );

    // 31c. A's chat token cannot claim B's outbox (42501), and B's rows stay unclaimed.
    const cross = await chat(a).db.rpc('notify_claim', { p_tenant_id: b.id });
    const bUntouched = (await outboxOf(b)).every((r) => r.claimed_at === null && r.sent_at === null);
    check(
      cross.error?.code === '42501' && (cross.data ?? []).length === 0 && bUntouched,
      "notify claim A→B: refused, B's outbox untouched",
      `${cross.error?.code ?? 'NO ERROR'} ${cross.error?.message ?? ''} · rows ${(cross.data ?? []).length} · B unclaimed ${bUntouched}`,
    );

    // 31d. A's drain tells A's device only; B's tells B's two, never A's,
    //      and a proof only B's admin (Rule 3), never the staff member.
    const aClaim = (await chat(a).db.rpc('notify_claim', { p_tenant_id: a.id })).data ?? [];
    const bClaim = (await chat(b).db.rpc('notify_claim', { p_tenant_id: b.id })).data ?? [];
    const bEndpoints = new Set([devices.b, devices.outsider]);
    const proofs = bClaim.filter((r) => r.kind === 'proof');
    check(
      aClaim.length === 1 && aClaim[0].endpoint === devices.a && aClaim[0].reference === own.reference
        && bClaim.length > 0 && bClaim.every((r) => bEndpoints.has(r.endpoint) && r.reference !== own.reference)
        && bClaim.some((r) => r.endpoint === devices.outsider) && proofs.every((r) => r.endpoint === devices.b),
      "notify claim: A's request reaches A's device alone; B's news reaches B's devices, a proof only B's admin",
      `A → ${aClaim.map((r) => `${r.kind}@${r.endpoint === devices.a ? 'A-operator' : 'ELSEWHERE'}`).join(', ')} · B → ${bClaim.map((r) => `${r.kind}@${r.endpoint === devices.b ? 'B-operator' : r.endpoint === devices.outsider ? 'B-staff' : 'ELSEWHERE'}`).join(', ')}`,
    );

    // 31e. A's chat token cannot record B's results ("gone" would delete
    //      B's devices); B's own "ok" is recorded. The twin.
    const results = bClaim.map((r) => ({ outbox: r.outbox_id, subscription: r.subscription_id, result: 'gone' }));
    const crossDone = await chat(a).db.rpc('notify_done', { p_results: results });
    const bAfterCross = await devicesOf(b);
    const bBoxAfterCross = await outboxOf(b);
    const ownDone = await chat(b).db.rpc('notify_done', { p_results: results.map((r) => ({ ...r, result: 'ok' })) });
    const bAfterOwn = await devicesOf(b);
    const bSent = (await outboxOf(b)).filter((r) => bClaim.some((c) => c.outbox_id === r.id)).every((r) => r.sent_at !== null);
    check(
      !crossDone.error && bAfterCross.length === 2 && bBoxAfterCross.every((r) => r.sent_at === null)
        && !ownDone.error && bAfterOwn.every((d) => d.last_ok_at !== null) && bSent,
      "notify done A→B: B's devices and outbox untouched; B records its own",
      `after A: B devices ${bAfterCross.length}, B sent ${bBoxAfterCross.filter((r) => r.sent_at).length} · after B: ${ownDone.error?.message ?? 'ok'}, devices ok ${bAfterOwn.filter((d) => d.last_ok_at).length}/${bAfterOwn.length}, claimed rows sent ${bSent}`,
    );

    // 31f. The Notifications item (plan/notifications.md § 8): each tenant's
    //      feed holds only its own, and A cannot mark B's read. On STAFF
    //      tokens in both modes (the feed asks the token's tenant itself):
    //      the function's tenant filter is the code wall, RLS the other.
    const staffOf = async (t) => ({ id: t.id, slug: t.slug, db: (await staffClient(t.id, operatorId))?.db });
    const [aStaff, bStaff] = await Promise.all([staffOf(a), staffOf(b)]);
    const bIds = bBox.map((r) => r.id);
    const aFeed = await notificationFeed(aStaff);
    const bBefore = await notificationFeed(bStaff);
    const crossMarked = await markNotificationsRead(aStaff, bIds);
    const bAfter = await notificationFeed(bStaff);
    const ownMarked = await markNotificationsRead(bStaff, null);
    check(
      aFeed.items.length === 1 && aFeed.items[0].reference === own.reference && bBefore.items.every((i) => i.reference !== own.reference)
        && bBefore.items.length === bBox.length && crossMarked === 0 && bAfter.unread === bBefore.unread && ownMarked === bBefore.unread,
      "notify feed A: only A's own; A marks none of B's read; B's unread holds, and B marks its own",
      `A ${aFeed.items.map((i) => i.reference).join(',')} · B ${bBefore.items.length} (${bBefore.unread} unread) · A marks B's ${crossMarked} · B unread after ${bAfter.unread} · B marks ${ownMarked}`,
    );

    // 31g. "Turn off on all my devices" (R-51) in A removes the member's A
    //      device only: their B device and B's staff member's stay. Staff
    //      work follows the mode, so --filters-only proves the member and
    //      tenant filters alone.
    const [aCount, bCount] = await Promise.all([deviceCount(a, operatorId), deviceCount(b, operatorId)]);
    const removed = await removeAllDevices(a, operatorId);
    const left = (await supabase.from('push_subscriptions').select('endpoint').in('tenant_id', [a.id, b.id])).data?.map((r) => r.endpoint) ?? [];
    check(
      aCount === 1 && bCount === 1 && removed === 1 && !left.includes(devices.a) && left.includes(devices.b) && left.includes(devices.outsider),
      "notify devices: turning off all in A removes the member's A device only; their B device and B's staff device stay",
      `counts A ${aCount} B ${bCount} · removed ${removed} · left ${left.length} (A ${left.includes(devices.a)}, B ${left.includes(devices.b)}, B-staff ${left.includes(devices.outsider)})`,
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
  if (proofObjects.length) {
    const { data: removed } = await supabase.storage.from('payment-proofs').remove(proofObjects);
    if ((removed?.length ?? 0) !== proofObjects.length) console.log(`WARN  removed ${removed?.length ?? 0} of ${proofObjects.length} proof objects`);
  }
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
