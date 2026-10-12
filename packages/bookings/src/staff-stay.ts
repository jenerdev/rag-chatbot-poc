// staff-stay.ts — a stay booked by staff, on the booking page's rules (D-111).
//
// The staff form used to take one date, a name and an optional phone. A guest
// booked that way could not use Manage booking (it matches on email OR phone,
// D-104) and got no night-by-night price. Now the staff form is the booking
// page with a staff token:
//
//   quoteStaffStay()   the same night-by-night quote (priceStay(), shared with
//                      quoteRequest()), with the promo the staff member PICKED
//                      instead of a typed code
//   createStaffStay()  the same checks (parseRequest(): name, mobile AND
//                      email, check-in, nights, the horizon, guests per unit),
//                      then one insert of every unit × night, one stay, born
//                      pending (D-095), and an optional Walk in label
//
// What stays different from the page, on purpose: staff insert on their own
// token under the bookings insert policy, not through request_booking(), so
// no per-contact limit (staff are not strangers) and no source 'web'. The
// price is still the trigger's (plan Rule 2); nothing here sends one.
//
// Every query filters on tenant_id (CLAUDE.md rule 6). Callers have passed
// requireAdmin(..., 'bookings:read' or 'bookings:write').

import { randomUUID } from 'node:crypto';
import { listBookings, refuseRetiredSlot, requireConfig, writeError } from './bookings.js';
import { BookingInputError } from './errors.js';
import { priceStay, withDiscount } from './requests.js';
import type { BookingGroup, BookingTenant, PromoKind, RequestQuote } from './types.js';
import { addDays, localDate, optionalPositiveInt, parseRequest, type ParsedRequest } from './validate.js';

/** What the staff form sends: the booking page's fields, a picked promo, and Walk in. */
export interface NewStaffStay {
  slotId?: unknown;
  /** `[{ unitId, guests }]`; a whole-resort tenant sends one */
  rooms?: unknown;
  checkIn?: unknown;
  nights?: unknown;
  name?: unknown;
  phone?: unknown;
  email?: unknown;
  notes?: unknown;
  /** D-097: a promo the staff member picked; the trigger checks it and stores the discount */
  promoId?: unknown;
  /** D-111: the guest walked in. A label on the stay; it changes nothing else */
  walkIn?: unknown;
}

/** The staff form, checked: the page's rules in a staff member's words. */
async function parseStaffStay(tenant: BookingTenant, input: NewStaffStay, contact: 'given' | 'placeholder') {
  const config = await requireConfig(tenant);
  const request = parseRequest(
    contact === 'given' ? input : { ...input, name: 'Quote', phone: '09000000000', email: 'quote@example.com' },
    {
      today: localDate(config.timezone),
      bookingType: config.bookingType,
      maxNights: config.maxStayNights,
      maxAdvanceDays: config.maxAdvanceDays,
      byStaff: true,
    },
  );
  return { config, request, promoId: optionalPositiveInt(input.promoId, 'Promo') };
}

/**
 * The promo a staff member picked, checked against the whole stay: this
 * tenant's, still offered, covering every night. "No such promo." for
 * another tenant's id as for none. The trigger refuses the rest at insert
 * (its limit, D-097); this says the common cases first, in words.
 */
async function pickedPromo(
  tenant: BookingTenant,
  promoId: number,
  checkIn: string,
  lastNight: string,
): Promise<{ id: number; name: string; kind: PromoKind; value: number }> {
  const { data: p, error } = await tenant.db
    .from('promos')
    .select('id, name, kind, value, active, valid_from, valid_to')
    .eq('tenant_id', tenant.id)
    .eq('id', promoId)
    .maybeSingle();
  if (error) throw new Error(`Could not read the promo: ${error.message}`);
  if (!p) throw new BookingInputError('No such promo.');
  if (!p.active) throw new BookingInputError(`The promo "${p.name}" is no longer offered.`);
  if (checkIn < p.valid_from || lastNight > p.valid_to) {
    throw new BookingInputError(`The promo "${p.name}" covers stays from ${p.valid_from} to ${p.valid_to}.`);
  }
  return { id: p.id, name: p.name, kind: p.kind, value: p.value };
}

/**
 * The price of a staff stay, night by night: the booking page's quote
 * (priceStay()) with the picked promo. Contact details are not needed for a
 * price, so placeholders stand in for them, as in quoteRequest().
 */
export async function quoteStaffStay(tenant: BookingTenant, input: NewStaffStay): Promise<RequestQuote> {
  const { config, request, promoId } = await parseStaffStay(tenant, input, 'placeholder');
  const stay = await priceStay(tenant, request);
  const promo = promoId === null ? null : await pickedPromo(tenant, promoId, request.checkIn, stay.lastNight);
  return withDiscount(tenant, config.currency, request, stay, promo, null);
}

/** Every unit × night of a checked stay, night by night: the order the quote priced them in. */
function stayRows(request: ParsedRequest): { date: string; unitId: number; guests: number }[] {
  return Array.from({ length: request.nights }, (_, n) => addDays(request.checkIn, n)).flatMap((date) =>
    request.rooms.map((r) => ({ date, unitId: r.unitId, guests: r.guests })),
  );
}

/**
 * Book a stay for a guest: every unit × night in ONE insert, so one stay
 * with one reference (D-100), all saved or none (D-053). Born pending
 * (D-095); Confirm takes the nights. The price, the discount, the group's
 * reference and the stay row are all the triggers' (plan Rule 2, D-100).
 *
 * Postgres refuses what this cannot see: a night taken meanwhile (409, D-099),
 * a closed date (D-080), a promo past its limit (D-097). Their words come
 * through writeError(), the one map createBookings() uses.
 */
export async function createStaffStay(tenant: BookingTenant, input: NewStaffStay): Promise<BookingGroup> {
  const { request, promoId } = await parseStaffStay(tenant, input, 'given');
  if (input.walkIn !== undefined && input.walkIn !== null && typeof input.walkIn !== 'boolean') {
    throw new BookingInputError('Walk in is true or false.');
  }
  const walkIn = input.walkIn === true;
  const rows = stayRows(request);
  const lastNight = rows[rows.length - 1]!.date;

  // Said first, in words. The insert would be refused anyway, by
  // bookings_slot_active and the closed-date trigger.
  await refuseRetiredSlot(tenant, request.slotId);
  // priceStay() also refuses a day slot for several nights, a unit that is
  // not this tenant's and too many guests, each in words, before any insert.
  const stay = await priceStay(tenant, request);
  if (promoId !== null) await pickedPromo(tenant, promoId, request.checkIn, stay.lastNight);

  // One group id for the stay, sent, so every row shares it however many
  // there are; the reference is booking_reference()'s, filled by the trigger.
  const groupId = randomUUID();
  const { data, error } = await tenant.db
    .from('bookings')
    .insert(
      // Every row carries EVERY key (CLAUDE.md trap 15).
      rows.map((row) => ({
        tenant_id: tenant.id,
        unit_id: row.unitId,
        slot_id: request.slotId,
        booked_date: row.date,
        status: 'pending' as const,
        guest_name: request.name,
        guest_phone: request.phone,
        guest_email: request.email,
        guest_count: row.guests,
        notes: request.notes,
        group_id: groupId,
        promo_id: promoId,
        walk_in: walkIn,
      })),
    )
    .select('id');
  if (error) throw writeError(error, request.checkIn);

  const ids = new Set(data.map((row) => row.id));
  console.log(
    `[bookings] ${tenant.slug} staff stay ${[...ids].map((id) => `#${id}`).join(', ')}: ${request.checkIn} × ${request.nights} night(s), ` +
      `unit ${request.rooms.map((r) => r.unitId).join('+')}, slot ${request.slotId}, pending, group ${groupId}${walkIn ? ', walk in' : ''}`,
  );
  const bookings = (await listBookings(tenant, { from: request.checkIn, to: lastNight })).filter((b) => ids.has(b.id));
  if (bookings.length !== ids.size) throw new Error(`Bookings ${[...ids].join(', ')} were saved but could not be read back`);

  // The total is what was STORED, never this file's sum of a quote (Rule 2).
  const total = bookings.every((b) => b.price !== null) ? bookings.reduce((sum, b) => sum + (b.price ?? 0), 0) : null;
  return { groupId, bookings, total };
}
