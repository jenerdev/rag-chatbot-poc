'use client';

// S-3 · Bookings. Staff see a range of dates, every slot on each date as open
// or taken, and the bookings that start on that date. They can book a slot and
// cancel a booking.
//
// Rendered by app/t/[tenant]/admin/bookings/page.tsx, which has already
// checked on the server that the tenant exists and has the bookings
// application. Every route this screen calls is admin-only, so it starts the
// same way the knowledge-base screen does: is there a session for THIS tenant?
//
// What this screen does NOT do: decide whether a slot is free. It shows what
// check_availability says, and it attempts the booking. If the slot was taken
// in the meantime, the server's 409 is shown as-is. The rule lives in one
// place, the exclusion constraint (plan/bookings.md § 2.2).
//
// A per_room tenant (plan/booking-types.md Phase 4) gets three more things,
// and a whole-resort tenant sees none of them, so villa's screen is the one it
// was before: rooms to tick (several at once, one guest count each), a price
// from the server's quote, and a room filter. The price shown is ALWAYS the
// server's (the quote before, the stored price after); this screen never adds
// up a price of its own.
//
// Customer requests (plan/customer-booking.md Phase 4) come first: every
// request sent from the public booking page, one row per request (all its
// nights and units), with Confirm and Decline. A request holds nothing, so
// two can ask for the same night; confirming the second is refused by the
// server (409) and shown as-is. `clash` warns before anyone presses Confirm.

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  Accommodation,
  BookingGroup,
  BookingRequest,
  BookingSummary,
  BookingType,
  Quote,
  SlotAvailability,
  SlotSummary,
  UnitSummary,
} from '@rag/bookings';
import { BrandHeader } from '@/components/brand-header';
import { LoginForm, describeFailure } from '@/components/admin-login';
import { TenantNav, fetchRole } from '@/components/tenant-nav';
import type { NavFeatures } from '@/lib/nav-items';
import { isRole, type Role } from '@/lib/permissions';
import { formatMoney } from '@/lib/money';

export interface BookingsScreenProps {
  slug: string;
  businessName: string;
  logoUrl: string | null;
  bannerUrl: string | null;
  /** What the tenant has, for the header's links (lib/nav.ts). */
  nav: NavFeatures;
}

interface Setup {
  timezone: string;
  /** Today in the TENANT'S timezone, computed on the server, not from this browser's clock. */
  today: string;
  bookingType: BookingType;
  currency: string;
  /** inactive ones included, so the list can still name a retired room */
  units: UnitSummary[];
  slots: SlotSummary[];
}

type Auth = 'checking' | 'out' | 'in';
type Notice = { message: string; kind: 'ok' | 'error' } | null;

// How many days the screen shows at once. Under both server limits:
// availability allows 31, the admin list 92.
const RANGE_DAYS = 14;

/** YYYY-MM-DD plus n days. Done on UTC midnights, so no DST edge can shift the date. */
function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** "Sat 10 Oct". Formatted as UTC because the date string has no zone; it is a calendar date, not an instant. */
function dayLabel(date: string): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  });
}

/** "22:00:00" → "22h", "09:30:00" → "9h 30m". Anything else is shown as Postgres wrote it. */
function durationLabel(duration: string): string {
  const match = /^(\d{2}):(\d{2}):00$/.exec(duration);
  if (!match) return duration;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
}

function BookingRow({
  booking,
  onCancel,
  busy,
  perRoom,
}: {
  booking: BookingSummary;
  onCancel: (booking: BookingSummary) => void;
  busy: boolean;
  /** per_room: show the room and the stored price. Null for whole_resort, so villa's row is unchanged. */
  perRoom: { currency: string } | null;
}) {
  const cancelled = booking.status === 'cancelled';
  return (
    <div className={`booking${cancelled ? ' cancelled' : ''}`}>
      <div className="booking-main">
        <span className="booking-slot">{perRoom ? `${booking.unit} · ${booking.slot}` : booking.slot}</span>
        <span className="booking-guest">{booking.guestName}</span>
        <span className="booking-meta">
          {[
            booking.guestCount ? `${booking.guestCount} guests` : null,
            booking.guestPhone,
            perRoom && booking.price !== null
              ? booking.extraGuestPrice
                ? `${formatMoney(booking.basePrice ?? 0, perRoom.currency)} + ${formatMoney(booking.extraGuestPrice, perRoom.currency)} extra guests = ${formatMoney(booking.price, perRoom.currency)}`
                : formatMoney(booking.price, perRoom.currency)
              : null,
            booking.source === 'web' ? `request ${booking.reference}` : perRoom && booking.groupId ? 'group booking' : null,
            booking.status === 'confirmed' ? null : booking.status,
          ]
            .filter(Boolean)
            .join(' · ')}
        </span>
        {!cancelled && (
          <button type="button" disabled={busy} onClick={() => onCancel(booking)}>
            Cancel
          </button>
        )}
      </div>
      {/* Notes are a React child, so whatever staff typed is escaped (CLAUDE.md § Conventions). */}
      {booking.notes && <div className="booking-notes">{booking.notes}</div>}
    </div>
  );
}

/** One customer request: who, what, when, the stored total, and the decision buttons. */
function RequestRow({
  request,
  currency,
  busy,
  onDecide,
}: {
  request: BookingRequest;
  currency: string;
  busy: boolean;
  onDecide: (request: BookingRequest, action: 'confirm' | 'decline') => void;
}) {
  const pending = request.status === 'pending';
  const nights = request.nights > 1 ? `${request.nights} nights from ` : '';
  return (
    <div className={`booking request${pending ? '' : ` ${request.status}`}`}>
      <div className="booking-main">
        <span className="booking-slot">{request.reference}</span>
        <span className="booking-guest">{request.guestName}</span>
        <span className="booking-meta">
          {[
            `${request.slot}, ${nights}${dayLabel(request.checkIn)}`,
            request.units.map((u) => `${u.unit}${u.guests ? ` (${u.guests})` : ''}`).join(', '),
            request.total !== null ? formatMoney(request.total, currency) : null,
            request.guestPhone,
            request.guestEmail,
            pending ? null : request.status,
          ]
            .filter(Boolean)
            .join(' · ')}
        </span>
        {pending && (
          <>
            <button type="button" className="primary" disabled={busy || request.clash || request.closed} onClick={() => onDecide(request, 'confirm')}>
              Confirm
            </button>
            <button type="button" disabled={busy} onClick={() => onDecide(request, 'decline')}>
              Decline
            </button>
          </>
        )}
      </div>
      {pending && request.clash && (
        <div className="booking-notes request-clash">A night of this request is already confirmed for another booking.</div>
      )}
      {pending && request.closed && (
        <div className="booking-notes request-clash">A night of this request is on a closed date. Decline it, or reopen the date on the Holidays screen.</div>
      )}
      {/* Customer-typed notes are a React child, so they are escaped. */}
      {request.notes && <div className="booking-notes">{request.notes}</div>}
    </div>
  );
}

export function BookingsScreen({ slug, businessName, logoUrl, bannerUrl, nav }: BookingsScreenProps) {
  const api = `/api/t/${slug}`;
  const [auth, setAuth] = useState<Auth>('checking');
  // What this member is, from the session check. Hides the tabs a role cannot
  // open (the routes behind them refuse anyway, with a 403 that names why).
  const [role, setRole] = useState<Role | null>(null);
  const [setup, setSetup] = useState<Setup | null>(null);
  const [from, setFrom] = useState<string | null>(null);
  const [availability, setAvailability] = useState<SlotAvailability[] | null>(null);
  const [bookings, setBookings] = useState<BookingSummary[] | null>(null);
  const [loadMessage, setLoadMessage] = useState('Loading…');
  const [notice, setNotice] = useState<Notice>(null);
  const [busy, setBusy] = useState(false);

  // The form.
  const [unitId, setUnitId] = useState<number | null>(null);
  const [slotId, setSlotId] = useState<number | null>(null);
  const [date, setDate] = useState('');
  const [guestName, setGuestName] = useState('');
  const [guestPhone, setGuestPhone] = useState('');
  const [guestCount, setGuestCount] = useState('');
  const [notes, setNotes] = useState('');

  // per_room only. The ticked rooms, each with its own guest count (capacity
  // is checked per room, plan/booking-types.md Phase 2), the server's quote
  // for them, and the list's room filter.
  const [rooms, setRooms] = useState<Accommodation[]>([]);
  const [chosen, setChosen] = useState<Record<number, string>>({});
  const [quote, setQuote] = useState<{ quote: Quote | null; message: string | null }>({ quote: null, message: null });
  const [roomFilter, setRoomFilter] = useState<number | null>(null);

  // Customer requests from the public booking page, from today on.
  const [requests, setRequests] = useState<BookingRequest[] | null>(null);
  const [showDecided, setShowDecided] = useState(false);

  const unauthorized = useCallback(() => {
    setAuth('out');
    setSetup(null);
    setAvailability(null);
    setBookings(null);
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const response = await fetch(`${api}/admin/session`);
        const body = await response.json();
        setAuth(body.admin === true ? 'in' : 'out');
        setRole(isRole(body.role) ? body.role : null);
      } catch {
        setAuth('out');
      }
    })();
  }, [api]);

  // Once logged in: units, slots, and the tenant's today. The range starts at
  // today, and the form defaults to the first unit, the first slot and today.
  useEffect(() => {
    if (auth !== 'in') return;
    void (async () => {
      let response: Response | null = null;
      try {
        response = await fetch(`${api}/bookings/setup`);
        if (response.status === 401) return unauthorized();
        if (!response.ok) throw new Error('failed');
        const body: Setup = await response.json();
        setSetup(body);
        setFrom(body.today);
        setDate(body.today);
        setUnitId(body.units.find((u) => u.active)?.id ?? null);
        setSlotId(body.slots[0]?.id ?? null);
        if (body.bookingType === 'per_room') {
          // Capacities for the room list. Staff-only, like everything here.
          const r = await fetch(`${api}/accommodations`);
          if (r.status === 401) return unauthorized();
          if (r.ok) setRooms(await r.json());
        }
      } catch (error) {
        setLoadMessage(await describeFailure(error as Error, response));
      }
    })();
  }, [api, auth, unauthorized]);

  const to = from ? addDays(from, RANGE_DAYS - 1) : null;

  // Availability and bookings for the range, in parallel. They are two calls
  // on purpose: availability is the shape the chatbot will see, with no guest
  // data, and the bookings list is the admin-only one that has it.
  const load = useCallback(async () => {
    if (!from || !to) return;
    let response: Response | null = null;
    try {
      const range = `from=${from}&to=${to}`;
      const [a, b, r] = await Promise.all([
        fetch(`${api}/bookings/availability?${range}`),
        fetch(`${api}/bookings?${range}${roomFilter === null ? '' : `&unit=${roomFilter}`}`),
        fetch(`${api}/bookings/requests`),
      ]);
      if (a.status === 401 || b.status === 401 || r.status === 401) return unauthorized();
      response = !a.ok ? a : !b.ok ? b : r;
      if (!a.ok || !b.ok || !r.ok) throw new Error('failed');
      setAvailability(await a.json());
      setBookings(await b.json());
      setRequests(await r.json());
    } catch (error) {
      setAvailability(null);
      setBookings(null);
      setLoadMessage(await describeFailure(error as Error, response));
    }
  }, [api, from, roomFilter, to, unauthorized]);

  useEffect(() => {
    void load();
  }, [load]);

  const perRoom = setup?.bookingType === 'per_room';
  const chosenRooms = useMemo(
    () =>
      Object.entries(chosen).map(([id, guests]) => ({
        unitId: Number(id),
        guestCount: guests === '' ? null : Number(guests),
      })),
    [chosen],
  );

  // The server's price for what is ticked, re-asked whenever it changes. Its
  // total is what the booking will store, because both come from unit_price().
  useEffect(() => {
    if (!perRoom || chosenRooms.length === 0 || slotId === null || !date) {
      setQuote({ quote: null, message: null });
      return;
    }
    let stale = false;
    void (async () => {
      let response: Response | null = null;
      try {
        response = await fetch(`${api}/bookings/quote`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          // The guests go too: the extra-guest fee is part of the price, and
          // the server refuses a party above a room's maximum here, before
          // anyone presses Book.
          body: JSON.stringify({ rooms: chosenRooms, slotId, date }),
        });
        if (response.status === 401) return unauthorized();
        if (!response.ok) throw new Error('failed');
        const body: Quote = await response.json();
        if (!stale) setQuote({ quote: body, message: null });
      } catch (error) {
        const message = await describeFailure(error as Error, response);
        if (!stale) setQuote({ quote: null, message });
      }
    })();
    return () => {
      stale = true;
    };
  }, [api, chosenRooms, date, perRoom, slotId, unauthorized]);

  const logout = useCallback(async () => {
    await fetch(`${api}/admin/session`, { method: 'DELETE' }).catch(() => undefined);
    unauthorized();
  }, [api, unauthorized]);

  const book = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();
      setNotice(null);
      setBusy(true);
      let response: Response | null = null;
      try {
        const who = { slotId, date, guestName, guestPhone: guestPhone || null, notes: notes || null };
        response = await fetch(`${api}/bookings`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(
            perRoom
              ? { ...who, rooms: chosenRooms }
              : { ...who, unitId, guestCount: guestCount === '' ? null : Number(guestCount) },
          ),
        });
        if (response.status === 401) return unauthorized();
        if (!response.ok) throw new Error('failed');
        if (perRoom && setup) {
          const group: BookingGroup = await response.json();
          const [first] = group.bookings;
          setNotice({
            message:
              `Booked ${group.bookings.map((b) => b.unit).join(', ')} (${first?.slot}) on ${first ? dayLabel(first.date) : date} ` +
              `for ${first?.guestName}. Total ${formatMoney(group.total ?? 0, setup.currency)}.`,
            kind: 'ok',
          });
          setChosen({});
        } else {
          const created: BookingSummary = await response.json();
          setNotice({ message: `Booked ${created.slot} on ${dayLabel(created.date)} for ${created.guestName}.`, kind: 'ok' });
        }
        setGuestName('');
        setGuestPhone('');
        setGuestCount('');
        setNotes('');
        void load();
      } catch (error) {
        // A 409 lands here with the server's own sentence: "That slot on …
        // overlaps an existing booking." It is not rephrased.
        setNotice({ message: await describeFailure(error as Error, response), kind: 'error' });
      } finally {
        setBusy(false);
      }
    },
    [api, chosenRooms, date, guestCount, guestName, guestPhone, load, notes, perRoom, setup, slotId, unauthorized, unitId],
  );

  const cancel = useCallback(
    async (booking: BookingSummary) => {
      if (!window.confirm(`Cancel ${booking.slot} on ${dayLabel(booking.date)} for ${booking.guestName}?`)) return;
      setNotice(null);
      setBusy(true);
      let response: Response | null = null;
      try {
        response = await fetch(`${api}/bookings/${booking.id}`, { method: 'DELETE' });
        if (response.status === 401) return unauthorized();
        if (!response.ok) throw new Error('failed');
        setNotice({ message: `Cancelled ${booking.slot} on ${dayLabel(booking.date)}. The slot is free again.`, kind: 'ok' });
        void load();
      } catch (error) {
        setNotice({ message: `Could not cancel: ${await describeFailure(error as Error, response)}`, kind: 'error' });
      } finally {
        setBusy(false);
      }
    },
    [api, load, unauthorized],
  );

  const decide = useCallback(
    async (req: BookingRequest, action: 'confirm' | 'decline') => {
      const what = `${req.reference} for ${req.guestName}`;
      if (action === 'decline' && !window.confirm(`Decline ${what}?`)) return;
      setNotice(null);
      setBusy(true);
      let response: Response | null = null;
      try {
        response = await fetch(`${api}/bookings/requests/${req.groupId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action }),
        });
        if (response.status === 401) return unauthorized();
        if (!response.ok) throw new Error('failed');
        setNotice({
          message:
            action === 'confirm'
              ? `Confirmed ${what}. The dates are now booked; contact the guest at ${req.guestPhone ?? req.guestEmail}.`
              : `Declined ${what}.`,
          kind: 'ok',
        });
        void load();
      } catch (error) {
        // A 409 arrives with the server's own sentence and is not rephrased.
        setNotice({ message: await describeFailure(error as Error, response), kind: 'error' });
        void load();
      } finally {
        setBusy(false);
      }
    },
    [api, load, unauthorized],
  );

  // The room filter by name, because availability rows carry the unit's name.
  const filteredName = roomFilter === null ? null : (setup?.units.find((u) => u.id === roomFilter)?.name ?? null);

  // Group both lists by date, in range order.
  const days = useMemo(() => {
    if (!from || !availability || !bookings) return [];
    return Array.from({ length: RANGE_DAYS }, (_, i) => {
      const day = addDays(from, i);
      return {
        day,
        slots: availability.filter((a) => a.date === day && (filteredName === null || a.unit === filteredName)),
        bookings: bookings.filter((b) => b.date === day),
      };
    });
  }, [availability, bookings, filteredName, from]);

  // Active units only: a retired room is not offered in the form or shown as
  // a chip. Villa has one, so none of the per-unit UI appears for it.
  const activeUnits = setup?.units.filter((u) => u.active) ?? [];
  const multipleUnits = activeUnits.length > 1;

  const header = (
    <BrandHeader businessName={businessName} logoUrl={logoUrl} bannerUrl={bannerUrl} subtitle="Bookings">
      <TenantNav slug={slug} features={nav} current="bookings" session={{ auth, role, onLogout: logout }} />
    </BrandHeader>
  );

  if (auth !== 'in') {
    return (
      <>
        {header}
        <main>
          {auth === 'checking' ? (
            <div className="small muted">Checking your session…</div>
          ) : (
            <LoginForm
              api={api}
              slug={slug}
              onLoggedIn={() => {
                setAuth('in');
                void fetchRole(api).then(setRole);
              }}
            />
          )}
        </main>
      </>
    );
  }

  if (!setup || !from || !to) {
    return (
      <>
        {header}
        <main>
          <div className="small">{loadMessage}</div>
        </main>
      </>
    );
  }

  return (
    <>
      {header}

      <main>
        <div className={notice ? `notice ${notice.kind}` : 'notice hidden'}>{notice?.message}</div>

        {requests && requests.length > 0 && (
          <section className="card">
            <div className="range-head">
              <h2>Requests</h2>
              <div className="range-nav">
                <Link className="button" href={`/t/${slug}/book`}>
                  Booking page
                </Link>
                {requests.some((r) => r.status !== 'pending') && (
                  <button type="button" onClick={() => setShowDecided((v) => !v)}>
                    {showDecided ? 'Hide decided' : 'Show decided'}
                  </button>
                )}
              </div>
            </div>
            <p className="small muted">
              Sent from the booking page. A request does not hold its dates: the first one you confirm gets them.
            </p>
            {requests.filter((r) => r.status === 'pending').length === 0 && (
              <div className="small muted">No requests waiting.</div>
            )}
            {requests
              .filter((r) => r.status === 'pending' || showDecided)
              .map((r) => (
                <RequestRow key={r.groupId} request={r} currency={setup.currency} busy={busy} onDecide={decide} />
              ))}
          </section>
        )}

        <section className="card">
          <h2>New booking</h2>
          <form onSubmit={book}>
            {perRoom && (
              <div className="field">
                <label>Rooms</label>
                {rooms.filter((r) => r.active).length === 0 && (
                  <div className="small muted">
                    No rooms yet. Add them on the <Link href={`/t/${slug}/admin/accommodations`}>Rooms</Link> screen.
                  </div>
                )}
                <div className="room-picks">
                  {rooms
                    .filter((r) => r.active)
                    .map((r) => {
                      const picked = chosen[r.id] !== undefined;
                      return (
                        <div key={r.id} className={`room-pick${picked ? ' picked' : ''}`}>
                          <label>
                            <input
                              type="checkbox"
                              checked={picked}
                              onChange={(e) =>
                                setChosen((current) => {
                                  const next = { ...current };
                                  if (e.target.checked) next[r.id] = '';
                                  else delete next[r.id];
                                  return next;
                                })
                              }
                            />{' '}
                            {r.name}
                            {r.capacity !== null && <span className="muted"> · up to {r.capacity}</span>}
                            {r.standardCapacity !== null && r.extraPersonRate !== null && r.extraPersonRate > 0 && (
                              <span className="muted">
                                {' '}
                                · {r.standardCapacity} included, +{formatMoney(r.extraPersonRate, setup.currency)} each extra
                              </span>
                            )}
                            {r.rates.length === 0 && <span className="muted"> · no rate yet</span>}
                          </label>
                          {picked && (
                            <input
                              type="number"
                              min={1}
                              max={r.capacity ?? undefined}
                              step={1}
                              placeholder="guests"
                              aria-label={`Guests in ${r.name}`}
                              value={chosen[r.id]}
                              onChange={(e) => setChosen((current) => ({ ...current, [r.id]: e.target.value }))}
                            />
                          )}
                        </div>
                      );
                    })}
                </div>
              </div>
            )}

            <div className="field-row">
              {!perRoom && multipleUnits && (
                <div className="field">
                  <label htmlFor="unit">Unit</label>
                  <select id="unit" value={unitId ?? ''} onChange={(e) => setUnitId(Number(e.target.value))}>
                    {activeUnits.map((u) => (
                      <option key={u.id} value={u.id}>
                        {u.name}
                      </option>
                    ))}
                  </select>
                </div>
              )}
              <div className="field">
                <label htmlFor="slot">Slot</label>
                <select id="slot" value={slotId ?? ''} onChange={(e) => setSlotId(Number(e.target.value))}>
                  {setup.slots.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name} — {s.startTime}, {durationLabel(s.duration)}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label htmlFor="date">Date</label>
                <input type="date" id="date" required min={setup.today} value={date} onChange={(e) => setDate(e.target.value)} />
              </div>
            </div>

            <div className="field-row">
              <div className="field grow">
                <label htmlFor="guest-name">Guest name</label>
                <input type="text" id="guest-name" required value={guestName} onChange={(e) => setGuestName(e.target.value)} />
              </div>
              <div className="field">
                <label htmlFor="guest-phone">
                  Phone <span className="muted">(optional)</span>
                </label>
                <input type="text" id="guest-phone" value={guestPhone} onChange={(e) => setGuestPhone(e.target.value)} />
              </div>
              {!perRoom && (
                <div className="field narrow">
                  <label htmlFor="guest-count">
                    Guests <span className="muted">(optional)</span>
                  </label>
                  <input
                    type="number"
                    id="guest-count"
                    min={1}
                    step={1}
                    value={guestCount}
                    onChange={(e) => setGuestCount(e.target.value)}
                  />
                </div>
              )}
            </div>

            <div className="field">
              <label htmlFor="notes">
                Notes <span className="muted">(optional)</span>
              </label>
              <input type="text" id="notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
            </div>

            {perRoom && (quote.quote || quote.message) && (
              <div className={`quote${quote.message ? ' error' : ''}`}>
                {quote.quote ? (
                  <>
                    {/* Each room: its rate, then its extra guests, then its total,
                        separately (request § 3). Every number is the server's. */}
                    {quote.quote.lines.map((l) => (
                      <div key={l.unitId} className="quote-line">
                        <span>{l.unit}</span>
                        <span>
                          {formatMoney(l.basePrice, quote.quote!.currency)}
                          {l.extraGuestPrice > 0 &&
                            ` + ${l.extraGuests} extra guest${l.extraGuests === 1 ? '' : 's'} ${formatMoney(l.extraGuestPrice, quote.quote!.currency)}`}
                          {' = '}
                          {formatMoney(l.price, quote.quote!.currency)}
                        </span>
                      </div>
                    ))}
                    <div className="quote-line quote-total">
                      <strong>Total</strong>
                      <strong>{formatMoney(quote.quote.total, quote.quote.currency)}</strong>
                    </div>
                  </>
                ) : (
                  quote.message
                )}
              </div>
            )}

            <div className="form-footer">
              <span className="small muted">
                Times are in {setup.timezone}. Today there is {dayLabel(setup.today)}.
              </span>
              <button
                type="submit"
                className="primary"
                // per_room: every ticked room needs its guest count (the
                // database requires one), and a quote must have come back.
                disabled={
                  busy ||
                  slotId === null ||
                  (perRoom
                    ? chosenRooms.length === 0 || chosenRooms.some((r) => r.guestCount === null) || quote.quote === null
                    : unitId === null)
                }
              >
                {busy ? 'Saving…' : 'Book'}
              </button>
            </div>
          </form>
        </section>

        <section className="card">
          <div className="range-head">
            <h2>
              {dayLabel(from)} – {dayLabel(to)}
            </h2>
            <div className="range-nav">
              {perRoom && (
                <select aria-label="Show room" value={roomFilter ?? ''} onChange={(e) => setRoomFilter(e.target.value === '' ? null : Number(e.target.value))}>
                  <option value="">All rooms</option>
                  {setup.units.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.name}
                      {u.active ? '' : ' (retired)'}
                    </option>
                  ))}
                </select>
              )}
              <button type="button" disabled={from <= setup.today} onClick={() => setFrom(addDays(from, -RANGE_DAYS))}>
                ← Earlier
              </button>
              <button type="button" disabled={from === setup.today} onClick={() => setFrom(setup.today)}>
                Today
              </button>
              <button type="button" onClick={() => setFrom(addDays(from, RANGE_DAYS))}>
                Later →
              </button>
            </div>
          </div>

          {availability === null || bookings === null ? (
            <div className="small">{loadMessage}</div>
          ) : (
            days.map(({ day, slots, bookings: dayBookings }) => (
              <div key={day} className="day">
                <div className="day-head">
                  <span className="day-label">{dayLabel(day)}</span>
                  <span className="day-slots">
                    {slots.map((s) => (
                      <span
                        key={`${s.unit}/${s.slot}`}
                        className={`slot-chip ${s.status}`}
                        title={
                          s.status === 'closed'
                            ? 'Closed on the Holidays screen — nothing can be booked'
                            : s.status === 'taken'
                              ? 'Overlaps a booking — maybe one from another day'
                              : 'Free to book'
                        }
                      >
                        {multipleUnits || perRoom ? `${s.unit} · ` : ''}
                        {s.slot}: {s.status}
                      </span>
                    ))}
                  </span>
                </div>
                {dayBookings.map((b) => (
                  <BookingRow key={b.id} booking={b} busy={busy} onCancel={cancel} perRoom={perRoom ? { currency: setup.currency } : null} />
                ))}
              </div>
            ))
          )}
        </section>
      </main>
    </>
  );
}
