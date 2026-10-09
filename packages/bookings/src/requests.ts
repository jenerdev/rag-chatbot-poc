// requests.ts — customer booking requests (plan/customer-booking.md).
//
// Two audiences, kept apart by what they may read:
//
//   the PUBLIC page, on a chat token:
//     bookingPage()     what can be booked, and its public prices
//     quoteRequest()    the price of a stay, read-only, holding nothing
//     requestBooking()  the ONE write a stranger can make, through the SQL
//                       function request_booking() (plan Rule 2)
//
//   STAFF, on a staff token (callers must have passed requireAdmin()):
//     listRequests()    web requests, one per group, with guest data
//     confirmRequest()  pending → confirmed, the whole group in one statement
//     declineRequest()  pending → cancelled, likewise
//
// A request holds nothing (plan § 2.5, D-070). Who gets a night is decided by
// bookings_no_overlap when staff CONFIRM, not by any read here: a confirm over
// a confirmed night is 23P01, the constraint's answer (CLAUDE.md trap 8).
//
// Every query filters on tenant_id and every .rpc() sends p_tenant_id
// (CLAUDE.md rule 6). The unit and slot ids come from a form, not from the
// model: the chatbot has no tool that reaches this file (D-037).

import { MAX_STAY_NIGHTS } from './constants.js';
import { expireDueStays } from './deadlines.js';
import { bookingsConfig, decisionNote, requireConfig, listSlots, RETIRED } from './bookings.js';
import { listCalendar } from './calendar.js';
import { BookingConflictError, BookingInputError, BookingLimitError, BookingsNotEnabledError } from './errors.js';
import type {
  BookingPage,
  BookingRequest,
  BookingStatus,
  BookingTenant,
  RequestLine,
  RequestQuote,
  RequestReceipt,
} from './types.js';
import { closedDays, closedError, refuseClosedDays } from './closed.js';
import { discountLines, optionalCode, promoForStay, promoMessage } from './promos.js';
import { addDays, lastBookingDate, localDate, pageSettings, parseRequest } from './validate.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Everything the public page shows, for a chat token. Only active units, and
 * only the slots each unit has a price for: a slot with no price is not
 * offered, because a page with no price is what this plan exists to avoid.
 *
 * A tenant with nothing priced gets BookingsNotEnabledError (404), the same
 * answer as a tenant without the application (plan § 2.8): a whole_resort
 * tenant whose unit has no rates has no page yet.
 */
export async function bookingPage(tenant: BookingTenant): Promise<BookingPage> {
  const config = await requireConfig(tenant);
  const [app, units, rates, slots] = await Promise.all([
    tenant.db.from('tenant_applications').select('config').eq('tenant_id', tenant.id).eq('application_key', 'bookings').single(),
    tenant.db
      .from('units')
      .select('id, name, description, capacity, standard_capacity, extra_person_rate, sort_order')
      .eq('tenant_id', tenant.id)
      .eq('active', true)
      .order('sort_order')
      .order('name'),
    tenant.db.from('unit_rates').select('unit_id, slot_id, weekday_price, weekend_price, holiday_price').eq('tenant_id', tenant.id),
    listSlots(tenant),
  ]);
  if (app.error) throw new Error(`Could not load the booking page settings: ${app.error.message}`);
  if (units.error) throw new Error(`Could not load units: ${units.error.message}`);
  if (rates.error) throw new Error(`Could not load rates: ${rates.error.message}`);

  const slotName = new Map(slots.map((s) => [s.id, s.name]));
  const slotOrder = new Map(slots.map((s, i) => [s.id, i]));
  const priced = units.data
    .map((u) => ({
      id: u.id,
      name: u.name,
      description: u.description,
      capacity: u.capacity,
      standardCapacity: u.standard_capacity,
      extraPersonRate: u.extra_person_rate,
      rates: rates.data
        .filter((r) => r.unit_id === u.id && slotName.has(r.slot_id))
        .sort((a, b) => (slotOrder.get(a.slot_id) ?? 0) - (slotOrder.get(b.slot_id) ?? 0))
        .map((r) => ({
          slotId: r.slot_id,
          slot: slotName.get(r.slot_id)!,
          weekdayPrice: r.weekday_price,
          weekendPrice: r.weekend_price,
          holidayPrice: r.holiday_price,
        })),
    }))
    .filter((u) => u.rates.length > 0);
  if (priced.length === 0) throw new BookingsNotEnabledError(tenant.slug);

  const offered = new Set(priced.flatMap((u) => u.rates.map((r) => r.slotId)));
  const today = localDate(config.timezone);
  const lastDate = lastBookingDate(today, config.maxAdvanceDays);
  const settings = pageSettings(app.data.config);
  return {
    bookingType: config.bookingType,
    timezone: config.timezone,
    currency: config.currency,
    today,
    lastDate,
    maxNights: config.maxStayNights,
    instructions: settings.instructions,
    guestHint: settings.guestHint,
    slots: slots.filter((s) => offered.has(s.id)),
    units: priced,
    calendar: await listCalendar(tenant, { from: today, to: lastDate }),
  };
}

/**
 * Does this tenant have a booking page? The bookings application AND at
 * least one active unit with a price: the same condition bookingPage() 404s
 * on, checked cheaply, for the chat's "Book" button (plan § 8 q5). False,
 * never an error, for a tenant without the application.
 */
export async function hasBookingPage(tenant: BookingTenant): Promise<boolean> {
  if (!(await bookingsConfig(tenant))) return false;
  const { data: units, error } = await tenant.db.from('units').select('id').eq('tenant_id', tenant.id).eq('active', true);
  if (error) throw new Error(`Could not load units: ${error.message}`);
  if (units.length === 0) return false;
  const { count, error: ratesError } = await tenant.db
    .from('unit_rates')
    .select('unit_id', { count: 'exact', head: true })
    .eq('tenant_id', tenant.id)
    .in(
      'unit_id',
      units.map((u) => u.id),
    );
  if (ratesError) throw new Error(`Could not load rates: ${ratesError.message}`);
  return (count ?? 0) > 0;
}

/**
 * The price of a stay, night by night, and whether it is still available.
 * Read-only: nothing is written and nothing is held.
 *
 * Every price is unit_quote(), the function the insert trigger stores from
 * (plan Rule 3), so the quote and the stored request cannot differ unless a
 * rate or the calendar changes in between. `available` reads
 * check_availability, which counts CONFIRMED bookings only, the same rows the
 * constraint holds.
 *
 * The contact fields are not needed for a quote, so placeholders stand in for
 * them in the shared validation.
 */
export async function quoteRequest(
  tenant: BookingTenant,
  input: { slotId?: unknown; rooms?: unknown; checkIn?: unknown; nights?: unknown; promoCode?: unknown },
): Promise<RequestQuote> {
  const code = optionalCode(input.promoCode);
  const config = await requireConfig(tenant);
  const today = localDate(config.timezone);
  const request = parseRequest(
    { ...input, name: 'Quote', phone: '09000000000', email: 'quote@example.com' },
    { today, bookingType: config.bookingType, maxNights: config.maxStayNights, maxAdvanceDays: config.maxAdvanceDays },
  );

  const [units, slot] = await Promise.all([
    tenant.db
      .from('units')
      .select('id, name, capacity')
      .eq('tenant_id', tenant.id)
      .eq('active', true)
      .in(
        'id',
        request.rooms.map((r) => r.unitId),
      ),
    tenant.db.from('slots').select('id, name, nightly, active').eq('tenant_id', tenant.id).eq('id', request.slotId).maybeSingle(),
  ]);
  if (units.error) throw new Error(`Could not load units: ${units.error.message}`);
  if (slot.error) throw new Error(`Could not load the slot: ${slot.error.message}`);
  // "Not yours" and "not there" are one message (CLAUDE.md conventions).
  if (!slot.data || units.data.length !== request.rooms.length) throw new BookingInputError('No such unit or slot.');
  if (!slot.data.active) throw new BookingInputError(RETIRED);
  if (request.nights > 1 && !slot.data.nightly) {
    throw new BookingInputError(`${slot.data.name} cannot be booked for several nights.`);
  }
  const unitById = new Map(units.data.map((u) => [u.id, u]));
  for (const { unitId, guests } of request.rooms) {
    const unit = unitById.get(unitId)!;
    if (unit.capacity !== null && guests > unit.capacity) throw new BookingInputError(`${unit.name} holds at most ${unit.capacity} guests.`);
  }

  const dates = Array.from({ length: request.nights }, (_, n) => addDays(request.checkIn, n));
  const lastNight = dates[dates.length - 1]!;
  // A stay that touches a closed date is refused before it is priced (D-080).
  await refuseClosedDays(tenant, dates);
  const [calendar, availability] = await Promise.all([
    listCalendar(tenant, { from: request.checkIn, to: lastNight }),
    tenant.db.rpc('check_availability', { p_tenant_id: tenant.id, p_from: request.checkIn, p_to: lastNight }),
  ]);
  if (availability.error) throw new Error(`Could not check availability: ${availability.error.message}`);
  const holiday = new Map(calendar.map((c) => [c.day, c.label]));
  const taken = new Set(
    availability.data.filter((r) => r.status === 'taken' && r.slot === slot.data!.name).map((r) => `${r.booked_date}|${r.unit}`),
  );

  const lines: RequestLine[] = [];
  let available = true;
  for (const date of dates) {
    for (const { unitId, guests } of request.rooms) {
      const unit = unitById.get(unitId)!;
      const { data, error } = await tenant.db.rpc('unit_quote', {
        p_tenant_id: tenant.id,
        p_unit_id: unitId,
        p_slot_id: request.slotId,
        p_date: date,
        p_guests: guests,
      });
      if (error) throw new Error(`Could not price ${unit.name}: ${error.message}`);
      const [q] = data;
      if (!q) throw new BookingInputError(`${unit.name} has no price for ${slot.data.name} yet.`);
      if (taken.has(`${date}|${unit.name}`)) available = false;
      lines.push({
        date,
        unitId,
        unit: unit.name,
        guests,
        basePrice: q.base_price,
        extraGuestPrice: q.extra_guest_price,
        surcharge: q.surcharge,
        discount: 0,
        price: q.price,
        holiday: holiday.get(date) ?? null,
      });
    }
  }

  // The promo (D-097), by the same two functions request_booking() uses, on
  // the same rows in the same order: the typed code, or the automatic one.
  // A code that does not apply changes nothing and says why (promoMessage);
  // the request would refuse it in the same words.
  const subtotal = lines.reduce((sum, l) => sum + l.price, 0);
  const found = await promoForStay(tenant, code, request.checkIn, lastNight, subtotal);
  const applied = found !== null && found.reason === null ? found : null;
  const discounts = await discountLines(tenant, applied?.id ?? null, lines.map((l) => l.price));
  lines.forEach((line, i) => {
    line.discount = discounts[i] ?? 0;
    line.price -= line.discount;
  });

  return {
    slotId: request.slotId,
    slot: slot.data.name,
    checkIn: request.checkIn,
    nights: request.nights,
    lines,
    total: lines.reduce((sum, l) => sum + l.price, 0),
    currency: config.currency,
    available,
    promo: applied ? { id: applied.id, name: applied.name, kind: applied.kind, value: applied.value } : null,
    discount: discounts.reduce((sum, d) => sum + d, 0),
    promoMessage: promoMessage(code, found),
  };
}

/**
 * Send a booking request: one `pending` row per unit per night, through
 * request_booking(), the only way a chat token can write a booking (plan
 * Rule 2). The function checks everything parseRequest() checks, and more
 * (the per-contact limit, a night already confirmed, the slot's start time);
 * this package checks first only to give the clearer message.
 *
 * The receipt is the STORED rows, as the function returns them. The total is
 * their sum, never a recomputation (plan Rule 3).
 */
export async function requestBooking(
  tenant: BookingTenant,
  input: {
    slotId?: unknown;
    rooms?: unknown;
    checkIn?: unknown;
    nights?: unknown;
    name?: unknown;
    phone?: unknown;
    email?: unknown;
    notes?: unknown;
    /** a promo code the customer typed (D-097); resolved by request_booking() under the lock */
    promoCode?: unknown;
  },
): Promise<RequestReceipt> {
  const config = await requireConfig(tenant);
  const promoCode = optionalCode(input.promoCode);
  const request = parseRequest(input, {
    today: localDate(config.timezone),
    bookingType: config.bookingType,
    maxNights: config.maxStayNights,
    maxAdvanceDays: config.maxAdvanceDays,
  });

  // Said first, in words; the bookings trigger refuses it anyway (D-080).
  await refuseClosedDays(
    tenant,
    Array.from({ length: request.nights }, (_, n) => addDays(request.checkIn, n)),
  );

  const { data, error } = await tenant.db.rpc('request_booking', {
    p_tenant_id: tenant.id,
    p_slot_id: request.slotId,
    p_unit_ids: request.rooms.map((r) => r.unitId),
    p_guests: request.rooms.map((r) => r.guests),
    p_check_in: request.checkIn,
    p_nights: request.nights,
    p_name: request.name,
    p_phone: request.phone,
    p_email: request.email,
    p_notes: request.notes,
    p_promo_code: promoCode,
  });
  if (error) throw requestError(error);
  if (!data || data.length === 0) throw new Error('The request was saved but nothing came back');

  const first = data[0]!;
  const calendar = await listCalendar(tenant, { from: request.checkIn, to: addDays(request.checkIn, request.nights - 1) });
  const holiday = new Map(calendar.map((c) => [c.day, c.label]));
  // The function returns unit names; the ids are the ones sent, matched by
  // name through this tenant's units (tenant-scoped, rule 6).
  const { data: units, error: unitsError } = await tenant.db
    .from('units')
    .select('id, name')
    .eq('tenant_id', tenant.id)
    .in(
      'id',
      request.rooms.map((r) => r.unitId),
    );
  if (unitsError) throw new Error(`Could not load units: ${unitsError.message}`);
  const idByName = new Map(units.map((u) => [u.name, u.id]));

  const lines: RequestLine[] = data.map((r) => ({
    date: r.booked_date,
    unitId: idByName.get(r.unit) ?? 0,
    unit: r.unit,
    guests: r.guests,
    basePrice: r.base_price,
    extraGuestPrice: r.extra_guest_price,
    surcharge: r.surcharge,
    discount: r.discount ?? 0,
    price: r.price,
    holiday: holiday.get(r.booked_date) ?? null,
  }));
  const settings = await pageSettingsOf(tenant);
  console.log(
    `[bookings] ${tenant.slug} request ${first.reference}: ${request.checkIn} × ${request.nights} night(s), ` +
      `${request.rooms.length} unit(s), ${lines.length} row(s), pending`,
  );
  return {
    reference: first.reference,
    slot: first.slot,
    checkIn: request.checkIn,
    nights: request.nights,
    startsAt: first.starts_at,
    endsAt: data[data.length - 1]!.ends_at,
    lines,
    total: lines.reduce((sum, l) => sum + l.price, 0),
    discount: lines.reduce((sum, l) => sum + l.discount, 0),
    currency: config.currency,
    instructions: settings.instructions,
  };
}

/**
 * Every stay, a web request or a staff booking (D-100), whose first night is
 * on or after `from` (default: today), one per group, newest first, any
 * status. STAFF ONLY: guest data.
 *
 * `clash` says a night is now CONFIRMED for another booking of the same unit,
 * so confirming would be refused. It is read from check_availability, which
 * counts confirmed rows only; a pending request itself never counts.
 */
export async function listRequests(tenant: BookingTenant, range: { from?: unknown } = {}): Promise<BookingRequest[]> {
  const { timezone } = await requireConfig(tenant);
  await expireDueStays(tenant);
  const today = localDate(timezone);
  const from = range.from === undefined || range.from === null || range.from === '' ? today : String(range.from);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from)) throw new BookingInputError(`"${from}" is not a date. Use YYYY-MM-DD.`);

  const { data, error } = await tenant.db
    .from('bookings')
    .select('id, group_id, reference, source, unit_id, slot_id, booked_date, status, guest_name, guest_phone, guest_email, guest_count, notes, decision_note, price, created_at')
    .eq('tenant_id', tenant.id)
    // D-100: every source. A staff booking is a group with a reference too and
    // waits for the same decision; the row says which door it came through.
    // A stay that began up to MAX_STAY_NIGHTS before `from` still has rows
    // after it; they are read so its group is whole, then dropped below.
    .gte('booked_date', addDays(from, -MAX_STAY_NIGHTS))
    .order('booked_date')
    .order('id');
  if (error) throw new Error(`Could not load requests: ${error.message}`);

  const [unitsRes, slots] = await Promise.all([
    tenant.db.from('units').select('id, name').eq('tenant_id', tenant.id),
    listSlots(tenant, { retired: true }),
  ]);
  if (unitsRes.error) throw new Error(`Could not load units: ${unitsRes.error.message}`);
  const unitName = new Map(unitsRes.data.map((u) => [u.id, u.name]));
  const slotName = new Map(slots.map((s) => [s.id, s.name]));

  const groups = new Map<string, typeof data>();
  for (const row of data) {
    if (!row.group_id) continue;
    groups.set(row.group_id, [...(groups.get(row.group_id) ?? []), row]);
  }
  const requests = [...groups.entries()]
    .map(([groupId, rows]) => ({ groupId, rows, checkIn: rows[0]!.booked_date }))
    .filter((g) => g.checkIn >= from);
  if (requests.length === 0) return [];

  // One availability read for the whole span, not one per request.
  const last = requests.reduce((max, g) => (g.rows[g.rows.length - 1]!.booked_date > max ? g.rows[g.rows.length - 1]!.booked_date : max), from);
  const spanDays = Math.round((Date.parse(`${last}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
  const taken = new Set<string>();
  const closed = await closedDays(tenant, from, last);
  // check_availability refuses a range over 366 days; requests stay inside it
  // (365 days ahead), but a very old "from" could not, so it is chunked.
  for (let start = 0; start <= spanDays; start += 300) {
    const p_from = addDays(from, start);
    const p_to = addDays(from, Math.min(start + 299, spanDays));
    const { data: rows, error: availError } = await tenant.db.rpc('check_availability', { p_tenant_id: tenant.id, p_from, p_to });
    if (availError) throw new Error(`Could not check availability: ${availError.message}`);
    for (const r of rows) if (r.status === 'taken') taken.add(`${r.booked_date}|${r.unit}|${r.slot}`);
  }

  const list = requests
    .map(({ groupId, rows, checkIn }) => {
      const first = rows[0]!;
      const unitIds = [...new Set(rows.map((r) => r.unit_id))];
      const dates = [...new Set(rows.map((r) => r.booked_date))];
      const slot = slotName.get(first.slot_id) ?? '(unknown slot)';
      const status = first.status as BookingStatus;
      return {
        groupId,
        reference: first.reference ?? '',
        source: first.source as 'staff' | 'web',
        status,
        guestName: first.guest_name,
        guestPhone: first.guest_phone,
        guestEmail: first.guest_email,
        notes: first.notes,
        decisionNote: first.decision_note,
        createdAt: first.created_at,
        slotId: first.slot_id,
        slot,
        checkIn,
        nights: dates.length,
        units: unitIds.map((unitId) => ({
          unitId,
          unit: unitName.get(unitId) ?? '(unknown unit)',
          guests: rows.find((r) => r.unit_id === unitId)?.guest_count ?? null,
        })),
        bookingIds: rows.map((r) => r.id),
        total: rows.every((r) => r.price !== null) ? rows.reduce((sum, r) => sum + (r.price ?? 0), 0) : null,
        // Only a pending request can clash; a confirmed one IS the taken night.
        clash: status === 'pending' && rows.some((r) => taken.has(`${r.booked_date}|${unitName.get(r.unit_id)}|${slot}`)),
        closed: status === 'pending' && rows.some((r) => closed.has(r.booked_date)),
      };
    })
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return withPayment(tenant, list);
}

/**
 * Each request's payment (plan/manage-booking.md § 4): stay_payment()'s
 * status, once per stay (never re-derived here), and the stay's pay_by.
 * Only PENDING stays are asked: a decided one's payment is on S-14.
 */
async function withPayment(tenant: BookingTenant, list: Omit<BookingRequest, 'payment'>[]): Promise<BookingRequest[]> {
  const pending = list.filter((r) => r.status === 'pending').map((r) => r.groupId);
  if (pending.length === 0) return list.map((r) => ({ ...r, payment: null }));
  const { data: stays, error } = await tenant.db.from('stays').select('group_id, pay_by, required_amount').eq('tenant_id', tenant.id).in('group_id', pending);
  if (error) throw new Error(`Could not load the stays: ${error.message}`);
  const tracked = new Map(stays.filter((s) => s.required_amount !== null).map((s) => [s.group_id, s.pay_by]));
  const money = new Map(
    await Promise.all(
      [...tracked.keys()].map(async (g) => {
        const { data, error: rpcError } = await tenant.db.rpc('stay_payment', { p_tenant_id: tenant.id, p_group_id: g });
        if (rpcError) throw new Error(`Could not load a payment: ${rpcError.message}`);
        return [g, data as { status: string; enough: boolean }] as const;
      }),
    ),
  );
  return list.map((r) => {
    const m = money.get(r.groupId);
    return { ...r, payment: m ? { status: m.status, enough: m.enough, payBy: tracked.get(r.groupId) ?? null } : null };
  });
}

/**
 * Confirm a whole request: every night, every unit, in ONE update, so a stay
 * can never end up half confirmed (plan § 2.6). If any night is already
 * confirmed for another booking, bookings_no_overlap refuses the statement
 * (23P01) and nothing changes.
 *
 * `false` means "not yours, not there, or already declined", deliberately one
 * answer. Confirming a confirmed request is `true`: the outcome asked for holds.
 */
export async function confirmRequest(tenant: BookingTenant, groupId: unknown, note?: unknown): Promise<boolean> {
  return decide(tenant, groupId, 'confirmed', note);
}

/** Decline a request: pending → cancelled, the whole group. Same answers as confirmRequest. */
export async function declineRequest(tenant: BookingTenant, groupId: unknown, note?: unknown): Promise<boolean> {
  return decide(tenant, groupId, 'cancelled', note);
}

/** `note` (D-096): what staff wrote with the decision, on every row of the group. */
async function decide(tenant: BookingTenant, groupId: unknown, to: 'confirmed' | 'cancelled', note?: unknown): Promise<boolean> {
  await requireConfig(tenant);
  if (typeof groupId !== 'string' || !UUID.test(groupId)) throw new BookingInputError('That is not a request id.');
  const decision = decisionNote(note);

  const { data, error } = await tenant.db
    .from('bookings')
    .update({ status: to, decision_note: decision })
    .eq('tenant_id', tenant.id)
    .eq('group_id', groupId)
    // D-100: any source; a staff stay is decided here like a web request.
    .in('status', ['pending', to])
    .select('id');
  if (error?.code === '23P01') {
    throw new BookingConflictError('A night of this request was confirmed for another booking. Decline it, or cancel the other booking first.');
  }
  const closedNight = error ? closedError(error) : null;
  if (closedNight) throw new BookingInputError(`${closedNight.message.replace(' Choose another date.', '')} Decline this request, or reopen the date first.`);
  // manage-booking § 9 q3: a tracked stay with nothing verified needs a note.
  if (error?.code === '23514' && /No payment has been verified/.test(error.message)) throw new BookingInputError(error.message);
  if (error) throw new Error(`Could not ${to === 'confirmed' ? 'confirm' : 'decline'} the request: ${error.message}`);

  if (data.length > 0) console.log(`[bookings] ${tenant.slug} request ${groupId} → ${to} (${data.length} row(s))`);
  return data.length > 0;
}

/** The booking page settings (instructions, guest hint), read from the config. */
async function pageSettingsOf(tenant: BookingTenant) {
  const { data, error } = await tenant.db
    .from('tenant_applications')
    .select('config')
    .eq('tenant_id', tenant.id)
    .eq('application_key', 'bookings')
    .single();
  if (error) throw new Error(`Could not load the booking page settings: ${error.message}`);
  return pageSettings(data.config);
}

/**
 * request_booking()'s errors, mapped once. Only the codes it raises on
 * purpose are translated (schema-customer-booking.sql § 11); anything else
 * propagates as a plain Error, so a real fault is never dressed up as input.
 */
function requestError(error: { code?: string; message: string }): Error {
  const closed = closedError(error);
  if (closed) return closed;
  if (error.code === '23514' && /slot retired/.test(error.message)) return new BookingInputError(RETIRED);
  if (error.code === '22023') return new BookingInputError(error.message);
  if (error.code === '23P01') return new BookingConflictError('That date is no longer available. Please choose another.');
  if (error.code === '54000') return new BookingLimitError(error.message);
  // A promo whose uses ran out between the quote and the request (D-097): a
  // conflict in the database's own words, like a night taken meanwhile.
  if (error.code === '23514' && /promo/.test(error.message)) return new BookingConflictError(error.message);
  // A unit that is not this tenant's, inactive, or gone: one answer.
  if (error.code === '23503') return new BookingInputError('No such unit or slot.');
  if (error.code === '23514' && /holds at most/.test(error.message)) return new BookingInputError('That is more guests than the room holds.');
  return new Error(`Could not send the request: ${error.message}`);
}
