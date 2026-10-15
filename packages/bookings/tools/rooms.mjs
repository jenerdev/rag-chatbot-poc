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

import { randomBytes, randomUUID } from 'node:crypto';
import { mintTenantToken, scopedClient, staffClient } from '@rag/db';
import { asOperator, supabase } from '@rag/db/service';
import {
  addImage,
  addUnitRoom,
  deleteUnitRoom,
  updateUnitRoom,
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
  cancelBooking,
  confirmBooking,
  createBookings,
  createPromo,
  deletePromo,
  listPromos,
  retirePromo,
  updatePromo,
  createSlot,
  deleteSlot,
  listSlots,
  listSlotsAdmin,
  updateSlot,
  listAccommodations,
  listBookings,
  listImages,
  listUnits,
  localDate,
  MAX_IMAGE_BYTES,
  PerRoomOnlyError,
  quote,
  moveImage,
  moveOptions,
  moveStay,
  removeImage,
  stayHistory,
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
  const probe = { id: probeRow.id, slug: probeRow.slug, db: (await staffClient(probeRow.id, userId))?.db ?? null };
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
    status: 'confirmed', // D-095: a seeded booking must take the span
  });
  check(
    group.bookings.length === 2 && group.groupId !== null && group.bookings.every((b) => b.groupId === group.groupId) && group.total === monday.total,
    'two rooms booked as one group; the stored total equals the quote',
    `group ${group.groupId} · ${group.bookings.map((b) => `#${b.id} ${b.unit} ${b.price}`).join(', ')} · total ${group.total}`,
  );

  // 4b. D-095: a booking with no status named is PENDING, and holds nothing:
  //     a second pending one on the same room and night is allowed. Confirming
  //     the first takes the night (the whole group, one statement); confirming
  //     the second is then the 409 bookings_no_overlap raises; a chat token
  //     cannot confirm anything. The date is a week after MONDAY, used nowhere else.
  {
    const weekLater = (() => {
      const d = new Date(`${MONDAY}T00:00:00Z`);
      d.setUTCDate(d.getUTCDate() + 7);
      return d.toISOString().slice(0, 10);
    })();
    const chatProbe = { id: probe.id, slug: probe.slug, db: scopedClient(mintTenantToken({ tenantId: probe.id })) };
    const first = await createBookings(probe, { rooms: [{ unitId: garden.id, guestCount: 1 }, { unitId: family.id, guestCount: 2 }], slotId: night.id, date: weekLater, guestName: 'Pending A' });
    const second = await createBookings(probe, { unitId: garden.id, guestCount: 1, slotId: night.id, date: weekLater, guestName: 'Pending B' });
    const bothPending = first.bookings.every((b) => b.status === 'pending') && second.bookings[0].status === 'pending';
    const confirmedFirst = await confirmBooking(probe, first.bookings[0].id, '  Paid in full  ');
    const firstRows = (await listBookings(probe, { from: weekLater, to: weekLater })).filter((b) => b.groupId === first.groupId);
    const afterFirst = firstRows.map((b) => b.status).join(',');
    const confirmSecond = await thrown(() => confirmBooking(probe, second.bookings[0].id));
    const chatConfirm = await thrown(() => confirmBooking(chatProbe, first.bookings[1].id));
    check(
      bothPending && confirmedFirst === true && afterFirst === 'confirmed,confirmed' && confirmSecond instanceof BookingConflictError && chatConfirm !== undefined,
      'D-095: born pending, holding nothing; Confirm takes the whole group; the clash is a 409 at confirm; a chat token cannot confirm',
      `pending ${bothPending} · first ${confirmedFirst} → ${afterFirst} · second ${confirmSecond?.constructor?.name} · chat ${chatConfirm?.constructor?.name ?? chatConfirm}`,
    );
    // 4c. D-096: the note on the decision, trimmed, on every row of the group;
    //     a cancel with a reason keeps it; too long is refused in words.
    const noteOnBoth = firstRows.map((b) => b.decisionNote).join('|');
    const cancelledSecond = await cancelBooking(probe, second.bookings[0].id, 'Guest changed plans');
    const secondRow = (await listBookings(probe, { from: weekLater, to: weekLater })).find((b) => b.id === second.bookings[0].id);
    const tooLong = await thrown(() => cancelBooking(probe, first.bookings[0].id, 'x'.repeat(501)));
    check(
      noteOnBoth === 'Paid in full|Paid in full' && cancelledSecond === true && secondRow?.status === 'cancelled' && secondRow?.decisionNote === 'Guest changed plans' && tooLong instanceof BookingInputError,
      'D-096: the decision note is stored trimmed on the whole group, shown on a cancel, and bounded',
      `confirm "${noteOnBoth}" · cancel ${secondRow?.status} "${secondRow?.decisionNote}" · 501 chars: ${tooLong?.constructor?.name}`,
    );

    // 4d. D-099 (plan/staff-clash.md): a pending booking cannot be BORN on a
    //     span already confirmed for that unit. The day after weekLater, used
    //     nowhere else. Two pendings may share a night (Rule 3); once one is
    //     confirmed, a third pending is refused by the trigger with words that
    //     name the date and the unit (23P01, the constraint's code, Rule 2);
    //     a several-rooms insert with one clashing room writes no row (§ 2.3);
    //     a CONFIRMED insert on that night is still the constraint's refusal.
    //     The words are asserted on a RAW insert on the staff token, wall 2
    //     alone; the package's own sentence is Phase 2's.
    {
      const d8 = (() => {
        const d = new Date(`${weekLater}T00:00:00Z`);
        d.setUTCDate(d.getUTCDate() + 1);
        return d.toISOString().slice(0, 10);
      })();
      const p1 = await createBookings(probe, { unitId: garden.id, guestCount: 1, slotId: night.id, date: d8, guestName: 'Pending C' });
      const p2 = await createBookings(probe, { unitId: garden.id, guestCount: 1, slotId: night.id, date: d8, guestName: 'Pending D' });
      const twoPending = p1.bookings[0].status === 'pending' && p2.bookings[0].status === 'pending';
      const confirmedP1 = await confirmBooking(probe, p1.bookings[0].id);
      const raw = await probe.db
        .from('bookings')
        .insert({ tenant_id: probe.id, unit_id: garden.id, slot_id: night.id, booked_date: d8, status: 'pending', guest_name: 'Pending E', guest_phone: '0', guest_count: 1, source: 'staff' })
        .select('id');
      const words = /^taken on \d{4}-\d{2}-\d{2}: Garden Room is already confirmed for that slot$/.test(raw.error?.message ?? '');
      const viaPackage = await thrown(() => createBookings(probe, { unitId: garden.id, guestCount: 1, slotId: night.id, date: d8, guestName: 'Pending F' }));
      const family8Before = (await listBookings(probe, { from: d8, to: d8 })).filter((b) => b.unit === 'Family Room').length;
      const group8 = await thrown(() => createBookings(probe, { rooms: [{ unitId: family.id, guestCount: 1 }, { unitId: garden.id, guestCount: 1 }], slotId: night.id, date: d8, guestName: 'Group X' }));
      const family8After = (await listBookings(probe, { from: d8, to: d8 })).filter((b) => b.unit === 'Family Room').length;
      const confirmedInsert = await thrown(() => createBookings(probe, { unitId: garden.id, guestCount: 1, slotId: night.id, date: d8, guestName: 'Pending G', status: 'confirmed' }));
      const rows8 = await listBookings(probe, { from: d8, to: d8 });
      const p2Row = rows8.find((b) => b.id === p2.bookings[0].id);
      const p1Row = rows8.find((b) => b.id === p1.bookings[0].id);
      check(
        twoPending && confirmedP1 === true && raw.error?.code === '23P01' && words && viaPackage instanceof BookingConflictError
          && group8 instanceof BookingConflictError && family8After === family8Before && confirmedInsert instanceof BookingConflictError && p2Row?.status === 'pending',
        'D-099: two pendings may share a night; once one is confirmed, a pending insert is refused in words (23P01), a group with one clashing room writes no row, a confirmed insert is still the constraint\'s, the other pending stays',
        `pending ${twoPending} · confirm ${confirmedP1} · raw ${raw.error?.code} "${raw.error?.message}" · package ${viaPackage?.constructor?.name} · group ${group8?.constructor?.name}, Family rows ${family8Before} → ${family8After} · confirmed ${confirmedInsert?.constructor?.name} · P2 ${p2Row?.status}`,
      );
      // 4e. D-099, the package (Phase 2): the trigger's words pass through
      //     createBookings() unchanged, the constraint's own refusal keeps the
      //     generic sentence, and the staff list says `clash` on the pending
      //     row that shares the confirmed night, false on the confirmed one.
      check(
        /^taken on \d{4}-\d{2}-\d{2}: Garden Room is already confirmed for that slot$/.test(viaPackage?.message ?? '')
          && /overlaps an existing booking/.test(confirmedInsert?.message ?? '') && p2Row?.clash === true && p1Row?.clash === false,
        'D-099: the trigger\'s words reach the caller; the constraint\'s refusal keeps the sentence; the list flags the clashing pending row',
        `package "${viaPackage?.message}" · constraint "${confirmedInsert?.message}" · P2 clash ${p2Row?.clash} · P1 clash ${p1Row?.clash}`,
      );
      // 4f. D-100 (plan/staff-requests.md): every staff booking has a group
      //     and a reference of the web shape, from the fill trigger. The
      //     2-room booking `first` has ONE reference on both rows (a BEFORE
      //     ROW trigger sees the rows before it in the same statement,
      //     § 2.1); the single `second` has its own group and a different
      //     reference; P1 and P2 (single, same night) differ from each other.
      {
        const shape = /^[A-Z]{3}-[A-Z2-9]{6}$/;
        const firstRefs = [...new Set(firstRows.map((b) => b.reference))];
        const secondRow = (await listBookings(probe, { from: weekLater, to: weekLater })).find((b) => b.id === second.bookings[0].id);
        const refs = [firstRefs[0], secondRow?.reference, p1Row?.reference, p2Row?.reference];
        check(
          firstRows.length === 2 && firstRefs.length === 1 && shape.test(firstRefs[0] ?? '')
            && !!secondRow?.groupId && secondRow.groupId !== first.groupId && shape.test(secondRow?.reference ?? '')
            && shape.test(p1Row?.reference ?? '') && shape.test(p2Row?.reference ?? '') && new Set(refs).size === 4,
          'D-100: a 2-room staff booking has ONE reference; single staff bookings each have a group and their own reference, all of the web shape',
          `2-room ${firstRefs.join('/')} (${firstRows.length} rows) · single ${secondRow?.reference} group ${secondRow?.groupId ? 'set' : 'NULL'} · P1 ${p1Row?.reference} · P2 ${p2Row?.reference}`,
        );
        // 4g. D-100, Phase 2: staff stays are in listRequests() with their
        //     source and the clash; declineRequest() cancels one (P2, the
        //     clashing pending); confirmRequest() confirms a fresh one on the
        //     day after; a web request still says 'web' (check 25 proves that).
        const d9 = (() => {
          const d = new Date(`${d8}T00:00:00Z`);
          d.setUTCDate(d.getUTCDate() + 1);
          return d.toISOString().slice(0, 10);
        })();
        const fresh = await createBookings(probe, { unitId: garden.id, guestCount: 1, slotId: night.id, date: d9, guestName: 'Pending H' });
        const freshRow = (await listBookings(probe, { from: d9, to: d9 })).find((b) => b.id === fresh.bookings[0].id);
        const inRequests = await listRequests(probe, { from: d8 });
        const p2Req = inRequests.find((r) => r.groupId === p2Row?.groupId);
        const freshReq = inRequests.find((r) => r.groupId === freshRow?.groupId);
        const declined = await declineRequest(probe, p2Row?.groupId, 'Double booked');
        const confirmed = await confirmRequest(probe, freshRow?.groupId, 'Paid');
        const after = await listBookings(probe, { from: d8, to: d9 });
        const p2After = after.find((b) => b.id === p2.bookings[0].id);
        const freshAfter = after.find((b) => b.id === fresh.bookings[0].id);
        check(
          p2Req?.source === 'staff' && p2Req.clash === true && p2Req.reference === p2Row?.reference
            && freshReq?.source === 'staff' && freshReq.clash === false && freshReq.units.length === 1
            && declined === true && p2After?.status === 'cancelled' && p2After?.decisionNote === 'Double booked'
            && confirmed === true && freshAfter?.status === 'confirmed' && freshAfter?.decisionNote === 'Paid',
          'D-100: staff stays are requests too: listed with source and clash, declined and confirmed by group with the note',
          `P2 ${p2Req?.source} clash ${p2Req?.clash} ${p2Req?.reference} → decline ${declined} ${p2After?.status} "${p2After?.decisionNote}" · fresh ${freshReq?.source} clash ${freshReq?.clash} → confirm ${confirmed} ${freshAfter?.status} "${freshAfter?.decisionNote}"`,
        );
      }
    }
  }

  // 5. The same room again is a 409. Then a group that clashes on ONE room:
  //    Garden is booked alone on Tuesday first, so Family + Garden on Tuesday
  //    must fail, and must leave no Family row behind (one statement, D-053).
  const again = await thrown(() => createBookings(probe, { unitId: garden.id, guestCount: 1, slotId: night.id, date: MONDAY, guestName: 'Second', status: 'confirmed' }));
  const blocker = await createBookings(probe, { unitId: garden.id, guestCount: 1, slotId: night.id, date: TUESDAY, guestName: 'Blocker', status: 'confirmed' });
  const clash = await thrown(() =>
    createBookings(probe, {
      rooms: [{ unitId: family.id, guestCount: 1 }, { unitId: garden.id, guestCount: 1 }],
      slotId: night.id,
      date: TUESDAY,
      guestName: 'Clash',
      status: 'confirmed', // D-095: only a confirmed booking can clash
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
  const fits = await createBookings(probe, { unitId: garden.id, guestCount: 2, slotId: night.id, date: FRIDAY, guestName: 'Fits', status: 'confirmed' });
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
      && keys === 'capacity,date,dayPrice,extraGuestPrice,extraPersonRate,price,rateKind,slot,standardCapacity,status,total,unit',
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
    const booked = await createBookings(probe, { unitId: quad.id, guestCount: 3, slotId: night.id, date: MONDAY, guestName: 'Three', status: 'confirmed' });
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

    // --- promos (plan/promos.md Phase 2, D-097) ---------------------------------
    // Through the package only: the screens and the page will call nothing else.
    // Dates: stays two to five weeks after THU, inside a promo valid from THU
    // for 60 days; a distinct contact per request (3 open per contact).
    {
      const P_FROM = THU;
      const P_TO = next(THU, 60);
      const promoStay = (n, overrides = {}) => stay({ checkIn: next(THU, 7 * n), nights: 2, ...contact(50 + n), ...overrides });
      const tenPct = (q) => q.lines.reduce((sum, l) => sum + Math.round((l.basePrice + l.extraGuestPrice + l.surcharge) * 0.1), 0);

      // 21a. createPromo validates in words; listPromos lists with 0 uses;
      //      a duplicate code is refused in words; retired ones need `all`.
      const bad = await Promise.all([
        thrown(() => createPromo(probe, { name: 'x', kind: 'half', value: 1, validFrom: P_FROM, validTo: P_TO })),
        thrown(() => createPromo(probe, { name: 'x', kind: 'percent', value: 12345, validFrom: P_FROM, validTo: P_TO })),
        thrown(() => createPromo(probe, { name: 'x', kind: 'fixed', value: 100, validFrom: P_TO, validTo: P_FROM })),
        thrown(() => createPromo(probe, { name: 'x', kind: 'fixed', value: 100, validFrom: P_FROM, validTo: P_TO, code: 'a b' })),
        thrown(() => createPromo(probe, { name: 'x', kind: 'fixed', value: 100, validFrom: P_FROM, validTo: P_TO, maxUses: 0 })),
      ]);
      const ten = await createPromo(probe, { name: 'Ten percent', kind: 'percent', value: 1000, validFrom: P_FROM, validTo: P_TO, code: ' ten-10 ' });
      const dup = await thrown(() => createPromo(probe, { name: 'again', kind: 'fixed', value: 1, validFrom: P_FROM, validTo: P_TO, code: 'TEN-10' }));
      const listed = await listPromos(probe);
      check(
        bad.every((e) => e instanceof BookingInputError) && ten.code === 'ten-10' && ten.uses === 0 && dup instanceof BookingInputError && /already used/.test(dup.message)
          && listed.length === 1 && listed[0].id === ten.id,
        'promos: five bad inputs refused in words; created with the code trimmed; a duplicate code refused; listed with 0 uses',
        `${bad.map(described).join(' | ')} · code "${ten.code}" · dup: ${described(dup)} · listed ${listed.length}`,
      );

      // 21b. quoteRequest on the chat token: the code takes 10 % off every
      //      night (rounded), the total is net, the promo is named; a wrong
      //      code and one outside its dates change nothing and say why.
      const plain = await quoteRequest(chat, promoStay(2));
      const coded = await quoteRequest(chat, promoStay(2, { promoCode: 'TEN-10' }));
      const wrong = await quoteRequest(chat, promoStay(2, { promoCode: 'NOPE-9' }));
      const outside = await quoteRequest(chat, promoStay(2, { checkIn: next(P_TO, 1), promoCode: 'TEN-10' }));
      check(
        coded.promo?.id === ten.id && coded.discount === tenPct(plain) && coded.total === plain.total - coded.discount
          && coded.lines.every((l, i) => l.discount === Math.round(plain.lines[i].price * 0.1) && l.price === plain.lines[i].price - l.discount)
          && wrong.promo === null && wrong.discount === 0 && wrong.total === plain.total && wrong.promoMessage === 'No such promo code.'
          && outside.promo === null && outside.discount === 0 && /covers stays from/.test(outside.promoMessage ?? ''),
        'quoteRequest: the code takes 10 % off each night and the total; a wrong code and one outside its dates change nothing and say why',
        `plain ${plain.total} · coded ${coded.total} (−${coded.discount}, "${coded.promo?.name}") · wrong "${wrong.promoMessage}" · outside "${outside.promoMessage}"`,
      );

      // 21c. requestBooking with the code: the receipt's discount is the
      //      quote's, the stored rows carry promo and discount, the staff list
      //      names the promo; uses becomes 1.
      const receipt = await requestBooking(chat, promoStay(2, { promoCode: 'ten-10' }));
      const storedRows = (await listBookings(probe, { from: next(THU, 14), to: next(THU, 15) })).filter((b) => b.guestName === 'Rooms Probe' && b.promoId === ten.id);
      const usesAfter = (await listPromos(probe)).find((p) => p.id === ten.id)?.uses;
      check(
        receipt.discount === coded.discount && receipt.total === coded.total && receipt.lines.every((l, i) => l.discount === coded.lines[i].discount)
          && storedRows.length === 2 && storedRows.every((b, i) => b.promoName === 'Ten percent' && b.discount === coded.lines[i].discount) && usesAfter === 1,
        "requestBooking with the code: the receipt equals the quote; the rows carry the promo's name and discount; uses 1",
        `receipt −${receipt.discount} = ${receipt.total} · stored ${storedRows.map((b) => `${b.promoName}/${b.discount}`).join(', ')} · uses ${usesAfter}`,
      );

      // 21d. Staff: a fixed ₱500 promo with max_uses 1, picked by id. quote()
      //      puts it on the FIRST room only; createBookings stores the same;
      //      a second staff booking with it is a 409 in words; retired, a
      //      quote refuses it; deletePromo refuses a used promo in words and
      //      deletes an unused one; an edited value leaves the stored
      //      discount alone (Rule 4).
      const five = await createPromo(probe, { name: 'Five hundred off', kind: 'fixed', value: 50000, validFrom: P_FROM, validTo: P_TO, maxUses: 1 });
      const staffDate = next(THU, 21);
      const sq = await quote(probe, { rooms: [{ unitId: garden.id, guestCount: 1 }, { unitId: family.id, guestCount: 2 }], slotId: night.id, date: staffDate, promoId: five.id });
      const sb = await createBookings(probe, { rooms: [{ unitId: garden.id, guestCount: 1 }, { unitId: family.id, guestCount: 2 }], slotId: night.id, date: staffDate, guestName: 'Promo Staff', promoId: five.id });
      const sbRows = (await listBookings(probe, { from: staffDate, to: staffDate })).filter((b) => b.groupId === sb.groupId);
      const limit = await thrown(() => createBookings(probe, { unitId: garden.id, guestCount: 1, slotId: night.id, date: next(THU, 28), guestName: 'Over limit', promoId: five.id }));
      const retired = await retirePromo(probe, ten.id);
      const retiredQuote = await thrown(() => quote(probe, { unitId: garden.id, guestCount: 1, slotId: night.id, date: staffDate, promoId: ten.id }));
      const retiredRequest = await quoteRequest(chat, promoStay(4, { promoCode: 'TEN-10' }));
      const deleteUsed = await thrown(() => deletePromo(probe, five.id));
      const unused = await createPromo(probe, { name: 'Unused', kind: 'fixed', value: 1, validFrom: P_FROM, validTo: P_TO });
      const deletedUnused = await deletePromo(probe, unused.id);
      await updatePromo(probe, ten.id, { value: 5000 });
      const keptRows = (await listBookings(probe, { from: next(THU, 14), to: next(THU, 15) })).filter((b) => b.promoId === ten.id);
      check(
        sq.discount === 50000 && sq.lines[0].discount === 50000 && sq.lines[1].discount === 0 && sq.total === sq.lines.reduce((s, l) => s + l.price, 0)
          && sbRows.map((b) => b.discount).join(',') === '50000,0' && sb.total === sq.total
          && limit instanceof BookingConflictError && /limit/.test(limit.message)
          && retired === true && retiredQuote instanceof BookingInputError && /no longer offered/.test(retiredQuote.message)
          && retiredRequest.promo === null && retiredRequest.promoMessage === 'No such promo code.'
          && deleteUsed instanceof BookingInputError && /Retire it/.test(deleteUsed.message) && deletedUnused === true
          && keptRows.map((b) => b.discount).join(',') === coded.lines.map((l) => l.discount).join(','),
        'staff promos: a fixed amount on the first room, stored the same; the limit is a 409; retired is refused; delete only when unused; an edit leaves stored discounts alone',
        `quote ${sq.lines.map((l) => l.discount).join(',')} = ${sq.total} · stored ${sbRows.map((b) => b.discount).join(',')} · limit ${described(limit)} · retired quote ${described(retiredQuote)} · retired code "${retiredRequest.promoMessage}" · delete used ${described(deleteUsed)} · unused ${deletedUnused} · kept ${keptRows.map((b) => b.discount).join(',')}`,
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

    // 23b. Each row says WHICH rate its price is (D-082), from rate_kind(),
    //      the branch unit_price() took, so the label and the price agree:
    //      Thursday weekday, Friday weekend, the peak and the plain holiday
    //      both at the holiday_price that 23 left set. And the DAY price
    //      (D-083) carries the peak's ₱4,000 surcharge from 22, and equals
    //      what the booking page quotes for that night, guests aside.
    {
      const on = async (day) => (await checkRoomAvailability(chat, { from: day, unit: 'Hall' }))[0];
      const rows = await Promise.all([THU, FRI, PEAK, HOLIDAY].map(on));
      const got = rows.map((r) => `${r?.rateKind} ${r?.price} ${r?.dayPrice}`).join(', ');
      const line = (await quoteRequest(chat, stay({ checkIn: PEAK, nights: 1 }))).lines[0];
      check(
        got === 'weekday 1600000 1600000, weekend 2000000 2000000, peak 2500000 2900000, holiday 2500000 2500000'
          && line.price - line.extraGuestPrice === rows[2]?.dayPrice,
        'rate kind and day price: each row names its rate, and the day price has the surcharge the page quotes',
        `${got} · page ${line.price} - extra ${line.extraGuestPrice}`,
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

    // 26b. D-099, the customer's door, wall 2 ALONE: request_booking() called
    //      directly on the chat token for the nights confirmed in 26 (the
    //      package refuses up front in 26; this skips that). The function's
    //      OWN availability check answers first, 23P01 "That date is no longer
    //      available", before any insert the trigger would see; either way the
    //      door is refused in SQL and no row is written. The first run of this
    //      check expected the trigger's words and learned the function's come
    //      first (Phase 1).
    {
      const before = (await listBookings(probe, { from: THU, to: FRI })).length;
      const direct = await chat.db.rpc('request_booking', {
        p_tenant_id: probe.id, p_slot_id: night.id, p_unit_ids: [hall.id], p_guests: [32], p_check_in: THU, p_nights: 2,
        p_name: 'Rooms Probe', p_phone: '09170009999', p_email: 'rooms-probe-9999@example.com', p_notes: null, p_promo_code: null,
      });
      const after = (await listBookings(probe, { from: THU, to: FRI })).length;
      const refusedInSql = direct.error?.code === '23P01' && /no longer available|^taken on \d{4}-\d{2}-\d{2}: Hall is already confirmed/.test(direct.error?.message ?? '');
      check(
        refusedInSql && after === before,
        'D-099: request_booking() on a confirmed night is refused in SQL (its own check first, the trigger behind it): 23P01, nothing saved',
        `${direct.error?.code} "${direct.error?.message}" · rows ${before} → ${after}`,
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

    // 30–33 are closed dates (D-080, schema-closed-days.sql). CLOSED is a
    //        Tuesday with nothing on it; BUSY is a Wednesday that gets a
    //        confirmed booking first. Every refusal has its twin.
    const CLOSED = firstOf(300, [2]);
    const BUSY = next(CLOSED, 1);
    const PENDING = firstOf(320, [4]);
    const code = async (fn) => {
      const { error } = await fn();
      return error ? `${error.code} ${error.message}` : 'ok';
    };

    // 30. A date with a confirmed booking cannot be closed (the message
    //     counts them); an empty date can, with no surcharge; a closed date
    //     with a surcharge is refused by the table too.
    {
      await createBookings(probe, { unitId: garden.id, guestCount: 1, slotId: night.id, date: BUSY, guestName: 'Busy', status: 'confirmed' });
      const busy = await thrown(() => setCalendarDay(probe, { day: BUSY, kind: 'closed', label: 'Probe closed' }));
      const closed = await setCalendarDay(probe, { day: CLOSED, kind: 'closed', label: 'Probe maintenance' });
      const pricey = await thrown(() => setCalendarDay(probe, { day: CLOSED, kind: 'closed', label: 'x', surcharge: 100 }));
      const tableSurcharge = await code(() =>
        supabase.from('rate_calendar').update({ surcharge: 100 }).eq('tenant_id', probe.id).eq('day', CLOSED),
      );
      check(
        busy instanceof BookingInputError && /has 1 confirmed booking\. Cancel or move it/.test(busy.message)
          && closed.kind === 'closed' && closed.surcharge === 0
          && pricey instanceof BookingInputError && tableSurcharge.startsWith('23514'),
        'closing: a date with a confirmed booking is refused; an empty one closes; no surcharge on a closed date',
        `${described(busy)} · ${closed.day} ${closed.kind} · ${described(pricey)} · table: ${tableSurcharge.slice(0, 60)}`,
      );
    }

    // 31. Nothing lands on a closed date. Staff through the package get the
    //     reason in words; the SAME insert straight into the table, on the
    //     staff token and on service_role, meets the trigger alone (wall 2).
    //     Twin: the day after is bookable.
    {
      const staff = await thrown(() => createBookings(probe, { unitId: garden.id, guestCount: 1, slotId: night.id, date: CLOSED, guestName: 'Closed' }));
      const row = { tenant_id: probe.id, unit_id: garden.id, slot_id: night.id, booked_date: CLOSED, status: 'confirmed', guest_name: 'Raw', guest_count: 1 };
      const rawStaff = await code(() => probe.db.from('bookings').insert(row));
      const rawService = await code(() => supabase.from('bookings').insert(row));
      const dayAfter = await createBookings(probe, { unitId: family.id, guestCount: 2, slotId: night.id, date: next(CLOSED, 2), guestName: 'Twin', status: 'confirmed' });
      check(
        staff instanceof BookingInputError && staff.message === `Closed on ${CLOSED} (Probe maintenance). Choose another date.`
          && rawStaff.startsWith('23514 closed on') && rawService.startsWith('23514 closed on') && dayAfter.bookings.length === 1,
        'closed date: staff refused in words; a raw insert on the staff token and on service_role meets the trigger; the day after books',
        `${described(staff)} · staff raw: ${rawStaff} · service raw: ${rawService} · twin ${dayAfter.bookings[0]?.date}`,
      );
    }

    // 32. A customer: the quote and the request are refused in words, and
    //     request_booking() called straight on the chat token meets the
    //     trigger (wall 2). The availability says 'closed' on that date
    //     only. Twin: a stay that ends the night before is quoted.
    {
      const quoteClosed = await thrown(() => quoteRequest(chat, stay({ checkIn: next(CLOSED, -1), nights: 2 })));
      const requestClosed = await thrown(() => requestBooking(chat, stay({ checkIn: CLOSED, nights: 1, ...contact(6) })));
      const raw = await code(() =>
        chat.db.rpc('request_booking', {
          p_tenant_id: probe.id, p_slot_id: night.id, p_unit_ids: [hall.id], p_guests: [32], p_check_in: CLOSED, p_nights: 1,
          p_name: 'Rooms Probe', p_phone: '09170000007', p_email: 'rooms-probe-7@example.com', p_notes: null,
        }),
      );
      const rows = await checkRoomAvailability(chat, { from: next(CLOSED, -1), to: next(CLOSED, 1), slot: 'Night' });
      const byDay = (d) => [...new Set(rows.filter((r) => r.date === d).map((r) => r.status))].join('/');
      const twin = await quoteRequest(chat, stay({ checkIn: next(CLOSED, -2), nights: 2 }));
      check(
        quoteClosed instanceof BookingInputError && quoteClosed.message.startsWith(`Closed on ${CLOSED}`)
          && requestClosed instanceof BookingInputError && raw.startsWith('23514 closed on')
          && byDay(CLOSED) === 'closed' && byDay(next(CLOSED, -1)) !== 'closed' && twin.lines.length === 2,
        "customer: a closed date is refused by quote, request and request_booking() itself; availability says 'closed' that day only",
        `${described(quoteClosed)} · ${described(requestClosed)} · rpc: ${raw.slice(0, 50)} · ${next(CLOSED, -1)} ${byDay(next(CLOSED, -1))}, ${CLOSED} ${byDay(CLOSED)} · twin ${twin.lines.length} lines`,
      );
    }

    // 33. A request made BEFORE its date was closed: staff see `closed`, its
    //     confirm is refused in words and changes nothing, and decline works.
    //     Reopening the date (remove) makes it bookable again.
    {
      const pending = await requestBooking(chat, stay({ checkIn: PENDING, nights: 1, ...contact(8) }));
      await setCalendarDay(probe, { day: PENDING, kind: 'closed', label: 'Probe late closure' });
      const find = async () => (await listRequests(probe, { from: PENDING })).find((r) => r.reference === pending.reference);
      const listed = await find();
      const confirm = await thrown(() => confirmRequest(probe, listed.groupId));
      const still = (await find()).status;
      const declined = await declineRequest(probe, listed.groupId);
      const reopened = await removeCalendarDay(probe, CLOSED);
      const afterReopen = await createBookings(probe, { unitId: garden.id, guestCount: 1, slotId: night.id, date: CLOSED, guestName: 'Reopened', status: 'confirmed' });
      check(
        listed.closed && !listed.clash && confirm instanceof BookingInputError && /Decline this request, or reopen the date/.test(confirm.message)
          && still === 'pending' && declined && reopened && afterReopen.bookings.length === 1,
        'a request on a date closed later: flagged, confirm refused in words, decline works; reopening makes the date bookable',
        `closed ${listed.closed} · ${described(confirm)} · still ${still} · declined ${declined} · reopened ${reopened} · booked ${afterReopen.bookings[0]?.date}`,
      );
    }
  }

  // 34–37. Slots managed by the tenant (D-090), on the probe's ADMIN token.
  //        Each rule twice: the package's words first, then the same write
  //        raw, which only Postgres can refuse (the trigger holds alone).
  {
    const chat = { id: probe.id, slug: probe.slug, db: scopedClient(mintTenantToken({ tenantId: probe.id })) };
    // Clear of every other check's dates (30–33 book around day 300).
    const FAR = firstOf(420, [3]);

    // 34. Create, a duplicate name refused, and the chat token cannot write.
    const created = await createSlot(probe, { name: 'Probe Day', startTime: '08:00', minutes: 540 });
    const dup = await thrown(() => createSlot(probe, { name: 'Probe Day', startTime: '09:00', minutes: 60 }));
    const chatInsert = await chat.db.from('slots').insert({ tenant_id: probe.id, name: 'Chat slot', start_time: '10:00', duration: '1 hour' }).select('id');
    const chatUpdate = await chat.db.from('slots').update({ name: 'Hijacked' }).eq('id', created.id).select('id');
    const villaSlot = (await listSlots(villa))[0];
    const acrossTenants = await updateSlot(probe, villaSlot.id, { name: 'Hijacked' });
    const listed = (await listSlotsAdmin(probe)).find((s) => s.id === created.id);
    check(
      listed?.minutes === 540 && listed.active && !listed.booked && dup instanceof BookingInputError
        && chatInsert.error !== null && (chatUpdate.data ?? []).length === 0 && acrossTenants === null,
      'slots: an admin creates one; a duplicate name is a 400; a chat token writes nothing; another tenant\'s slot is "not there"',
      `${listed?.name} ${listed?.startTime} ${listed?.minutes}min · dup: ${described(dup)} · chat insert: ${chatInsert.error?.code ?? 'ACCEPTED'} · chat update ${chatUpdate.data?.length ?? chatUpdate.error?.code} rows · villa's: ${acrossTenants}`,
    );

    // 35. An upcoming booking fixes its times: refused in words, and raw on the
    //     admin token AND on service_role (the trigger alone). The name changes.
    await setRates(probe, garden.id, [{ slotId: created.id, weekdayPrice: 200000, weekendPrice: 250000 }]);
    const booked = await createBookings(probe, { unitId: garden.id, guestCount: 1, slotId: created.id, date: FAR, guestName: 'Slot probe', status: 'confirmed' });
    const moveWords = await thrown(() => updateSlot(probe, created.id, { startTime: '09:00' }));
    const rawStaff = await probe.db.from('slots').update({ duration: '10 hours' }).eq('id', created.id);
    const rawService = await supabase.from('slots').update({ start_time: '07:00' }).eq('id', created.id);
    const renamed = await updateSlot(probe, created.id, { name: 'Probe Day Tour', startTime: '08:00', minutes: 540 });
    const afterRename = (await listSlotsAdmin(probe)).find((s) => s.id === created.id);
    check(
      booked.bookings.length === 1 && moveWords instanceof BookingInputError && /1 upcoming booking/.test(moveWords.message)
        && rawStaff.error?.code === '23514' && rawService.error?.code === '23514'
        && renamed !== null && afterRename?.name === 'Probe Day Tour' && afterRename.startTime === '08:00' && afterRename.upcoming === 1,
      'slots: an upcoming booking fixes the times (words, and the trigger on staff and service_role); the name still changes',
      `${described(moveWords)} · raw staff ${rawStaff.error?.code ?? 'ACCEPTED'} · raw service ${rawService.error?.code ?? 'ACCEPTED'} · now "${afterRename?.name}" ${afterRename?.startTime}, ${afterRename?.upcoming} upcoming`,
    );

    // 36. A booked slot cannot be deleted: retire it. Retired, it is gone from
    //     every OFFER (listSlots, availability) and takes no new booking,
    //     refused in words and raw on service_role; its booking keeps its name.
    const deleteWords = await thrown(() => deleteSlot(probe, created.id));
    const retired = await updateSlot(probe, created.id, { active: false });
    const offered = (await listSlots(probe)).map((s) => s.name);
    const history = (await listSlots(probe, { retired: true })).map((s) => s.name);
    const availability = [...new Set((await checkRoomAvailability(chat, { from: FAR })).map((r) => r.slot))];
    const newWords = await thrown(() => createBookings(probe, { unitId: family.id, guestCount: 1, slotId: created.id, date: FAR, guestName: 'After retire' }));
    const rawInsert = await supabase.from('bookings').insert({ tenant_id: probe.id, unit_id: family.id, slot_id: created.id, booked_date: FAR, guest_name: 'Raw', status: 'confirmed', guest_count: 1 });
    const keeps = (await listBookings(probe, { from: FAR, to: FAR })).find((b) => b.id === booked.bookings[0].id)?.slot;
    check(
      deleteWords instanceof BookingInputError && /Retire it/.test(deleteWords.message) && retired !== null
        && !offered.includes('Probe Day Tour') && history.includes('Probe Day Tour') && !availability.includes('Probe Day Tour')
        && newWords instanceof BookingInputError && /no longer offered/.test(newWords.message)
        && rawInsert.error?.code === '23514' && keeps === 'Probe Day Tour',
      'slots: a booked slot is retired, not deleted; retired, it is offered nowhere and takes no booking (words, and the trigger on service_role); its booking keeps it',
      `delete: ${described(deleteWords)} · offered [${offered}] · history [${history}] · availability [${availability}] · new: ${described(newWords)} · raw ${rawInsert.error?.code ?? 'ACCEPTED'} · booking's slot "${keeps}"`,
    );

    // 37. Offered again, it books again. A slot never booked is deleted, and
    //     its rates go with it (counted).
    await updateSlot(probe, created.id, { active: true });
    const back = (await listSlots(probe)).map((s) => s.name).includes('Probe Day Tour');
    const spare = await createSlot(probe, { name: 'Probe Spare', startTime: '18:00', minutes: 120, nightly: true });
    await setRates(probe, garden.id, [{ slotId: spare.id, weekdayPrice: 100000, weekendPrice: 100000 }]);
    const removed = await deleteSlot(probe, spare.id);
    const { count: rateRows } = await supabase.from('unit_rates').select('slot_id', { count: 'exact', head: true }).eq('slot_id', spare.id);
    const gone = await deleteSlot(probe, spare.id);
    check(
      back && removed && rateRows === 0 && gone === false,
      'slots: a retired slot is offered again; one never booked is deleted with its rates; deleting it twice is "not there"',
      `offered again ${back} · deleted ${removed} · rate rows left ${rateRows} · again ${gone}`,
    );
  }

  // 38–41. Room moves (D-133, plan/room-types.md Phase 3): a type of two
  //         rooms, through moveOptions() and moveStay() on the staff token.
  {
    const twin = await createAccommodation(probe, { name: 'Twin', capacity: 2, sortOrder: 9 });
    await setRates(probe, twin.id, [{ slotId: night.id, weekdayPrice: 300000, weekendPrice: 300000 }]);
    const { data: second, error: secondError } = await probe.db.from('unit_rooms').insert({ tenant_id: probe.id, unit_id: twin.id, name: 'Twin 2', sort_order: 1 }).select('id').single();
    if (secondError) throw new Error(`second room: ${secondError.message}`);
    const { data: rooms } = await probe.db.from('unit_rooms').select('id, name').eq('tenant_id', probe.id).eq('unit_id', twin.id).order('sort_order');
    const [one, two] = rooms;
    const N1 = day(200);
    const N2 = day(201);
    const N3 = day(205);
    const put = async (rows) => {
      const { data, error } = await probe.db
        .from('bookings')
        .insert(rows.map((r) => ({ tenant_id: probe.id, unit_id: twin.id, slot_id: night.id, guest_name: 'Move Probe', guest_count: 2, status: 'confirmed', ...r })))
        .select('id, room_id, group_id, price');
      if (error) throw new Error(`insert: ${error.message}`);
      return data;
    };
    const stayGroup = randomUUID();
    const stay = await put([{ booked_date: N1, group_id: stayGroup, room_id: one.id }, { booked_date: N2, group_id: stayGroup, room_id: one.id }]);
    const [blocker] = await put([{ booked_date: N2, room_id: two.id }]);
    // Any of villa's booking ids, read on the tool's service client: asked for as the probe, it must be "not there".
    const villaBooking = (await supabase.from('bookings').select('id').eq('tenant_id', villa.id).limit(1).maybeSingle()).data?.id ?? -1;

    // 38
    const blocked = await moveOptions(probe, stay[0].id);
    await cancelBooking(probe, blocker.id);
    const open = await moveOptions(probe, stay[0].id);
    const foreign = await moveOptions(probe, villaBooking);
    const shape = (o) => o?.rooms.map((r) => `${r.name}${r.current ? '*' : ''}:${r.free ? 'free' : 'busy'}`).join(',');
    check(
      blocked?.nights.join(',') === `${N1},${N2}` && shape(blocked) === 'Twin*:busy,Twin 2:busy' && shape(open) === 'Twin*:busy,Twin 2:free' && foreign === null,
      "room moves: the options list the type's rooms; a room confirmed for another stay on one night is busy, free once that is cancelled; another tenant's booking is null",
      `blocked ${shape(blocked)} · after cancel ${shape(open)} · nights ${open?.nights.join(',')} · villa's ${foreign}`,
    );

    // 39
    const moved = await moveStay(probe, stay[0].id, two.id, 'Guest asked for the room by the pool');
    const { data: after } = await probe.db.from('bookings').select('id, room_id, price').eq('tenant_id', probe.id).eq('group_id', stayGroup).order('booked_date');
    const history = await stayHistory(probe, stayGroup);
    const event = history.find((e) => e.kind === 'room');
    check(
      moved === 2 && after.every((r) => r.room_id === two.id) && after.map((r) => r.price).join(',') === stay.map((r) => r.price).join(',') &&
        event?.from === 'Twin' && event?.to === 'Twin 2' && event?.note === 'Guest asked for the room by the pool' && event?.actor === 'staff',
      'room moves: both nights move in one call, the price stays, and the history says from where to where and why',
      `moved ${moved} · rooms ${after.map((r) => r.room_id).join(',')} (to ${two.id}) · prices ${after.map((r) => r.price).join(',')} · event ${event ? `${event.from} → ${event.to} "${event.note}" by ${event.actor}` : 'none'}`,
    );

    // 40
    const same = await thrown(() => moveStay(probe, stay[0].id, two.id, 'again'));
    const otherType = await thrown(() => moveStay(probe, stay[0].id, garden.id, 'wrong type'));
    const silent = await thrown(() => moveStay(probe, stay[0].id, one.id, '   '));
    await put([{ booked_date: N1, room_id: one.id }]);
    const taken = await thrown(() => moveStay(probe, stay[0].id, one.id, 'back again'));
    const notOurs = await moveStay(probe, villaBooking, one.id, 'not ours');
    check(
      same instanceof BookingInputError && otherType instanceof BookingInputError && silent instanceof BookingInputError &&
        taken instanceof BookingConflictError && taken.message === `taken on ${N1}: Twin is already confirmed for that slot` && notOurs === null,
      "room moves: the same room, a room of another type and no note are 400s; a room confirmed on one of the nights is a 409 in words; another tenant's booking is null",
      `same ${described(same)} · other type ${described(otherType)} · no note ${described(silent)} · taken ${described(taken)} · villa's ${notOurs}`,
    );

    // 41
    const [pending] = await put([{ booked_date: N3, room_id: one.id, status: 'pending' }]);
    await put([{ booked_date: N3, room_id: two.id }]);
    const viaPackage = await thrown(() => moveStay(probe, pending.id, two.id, 'onto a confirmed room'));
    const raw = await probe.db.from('bookings').update({ room_id: two.id }).eq('tenant_id', probe.id).eq('id', pending.id).select('id');
    check(
      viaPackage instanceof BookingConflictError && raw.error?.code === '23P01',
      'room moves: a pending booking is not moved onto a room confirmed that night, through moveStay() (409) or a raw update (23P01)',
      `package ${described(viaPackage)} · raw ${raw.error?.code ?? 'MOVED'} ${raw.error?.message ?? ''}`,
    );

    // 42. The Rooms screen's calls (D-133, Phase 4): a type's rooms are
    //     listed; add, rename, retire and delete, each refusal in words.
    const listed = (await listAccommodations(probe)).find((a) => a.id === twin.id)?.rooms.map((r) => r.name).join(',');
    const thirdId = await addUnitRoom(probe, twin.id, 'Twin 3');
    const dupe = await thrown(() => addUnitRoom(probe, twin.id, 'Twin 3'));
    const foreignType = await addUnitRoom(probe, villaRoom.id, 'Not ours');
    const renamed = await updateUnitRoom(probe, twin.id, thirdId, { name: 'Twin by the pool' });
    const retired = await updateUnitRoom(probe, twin.id, thirdId, { active: false });
    const busyRetire = await thrown(() => updateUnitRoom(probe, twin.id, two.id, { active: false }));
    const bookedDelete = await thrown(() => deleteUnitRoom(probe, twin.id, two.id));
    const deleted = await deleteUnitRoom(probe, twin.id, thirdId);
    const again = await deleteUnitRoom(probe, twin.id, thirdId);
    const afterRooms = (await listAccommodations(probe)).find((a) => a.id === twin.id)?.rooms.map((r) => `${r.name}${r.active ? '' : ' (retired)'}`).join(',');
    check(
      listed === 'Twin,Twin 2' && typeof thirdId === 'number' && dupe instanceof BookingInputError && foreignType === null && renamed && retired &&
        busyRetire instanceof BookingInputError && /upcoming bookings/.test(busyRetire.message) &&
        bookedDelete instanceof BookingInputError && /has bookings/.test(bookedDelete.message) && deleted && !again && afterRooms === 'Twin,Twin 2',
      "type rooms: listed with the type; a room is added, renamed, retired and deleted; a duplicate name, a room with upcoming bookings and a booked room's delete are 400s in words; another tenant's type is null",
      `listed ${listed} · dupe ${described(dupe)} · villa's ${foreignType} · busy ${described(busyRetire)} · booked ${described(bookedDelete)} · deleted ${deleted}/${again} · after ${afterRooms}`,
    );
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
