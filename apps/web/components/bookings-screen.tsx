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
//
// The look (plan/ui-refresh.md Phase 7): Requests first, as rows with badges;
// "New booking" is a side panel opened beside the page title; every decision
// (confirm, decline, cancel) asks in a dialog with an optional note instead
// of window.prompt (D-096), the same answer, so the calls are unchanged; the
// list can be narrowed by status, on screen only (the same rows are read).

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  Accommodation,
  BookingGroup,
  Promo,
  BookingRequest,
  BookingSummary,
  BookingType,
  Quote,
  SlotAvailability,
  SlotSummary,
  UnitSummary,
} from '@rag/bookings';
import { LoginForm, describeFailure } from '@/components/admin-login';
import { fetchRole } from '@/components/tenant-nav';
import { StaffFrame } from '@/components/staff-frame';
import type { NavFeatures } from '@/lib/nav-items';
import { isRole, type Role } from '@/lib/permissions';
import { formatMoney } from '@/lib/money';
import { Drawer, useConfirmDialog } from '@/components/dialogs';
import { useNotice } from '@/components/toast';
import { Icon } from '@/components/icons';

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
  /** the active promos (D-097), for the form's picker; the automatic one is pre-selected */
  promos: Promo[];
}

type Auth = 'checking' | 'out' | 'in';

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
  onConfirm,
  busy,
  perRoom,
}: {
  booking: BookingSummary;
  onCancel: (booking: BookingSummary) => void;
  /** D-095: a staff booking is born pending; this is the button that takes the span. */
  onConfirm: (booking: BookingSummary) => void;
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
            // D-100: every stay has a reference; "group booking" means several rows, not "has a group".
            booking.reference ? `ref ${booking.reference}` : null,
            perRoom && booking.groupSize > 1 ? 'group booking' : null,
            // D-097: the promo it got, and this night's share of the discount (part of the price shown).
            booking.promoName ? `promo ${booking.promoName}${perRoom && booking.discount ? ` −${formatMoney(booking.discount, perRoom.currency)}` : ''}` : null,
          ]
            .filter(Boolean)
            .join(' · ')}
        </span>
        <span className="booking-badges">
          {booking.source === 'web' && <span className="badge accent">Web</span>}
          {booking.status === 'pending' && <span className="badge warn">Pending</span>}
          {cancelled && <span className="badge">Cancelled</span>}
          {booking.status === 'pending' && booking.clash && (
            <span className="badge danger">
              <Icon name="alert" size={12} /> Clash
            </span>
          )}
        </span>
        <span className="booking-actions">
          {booking.status === 'pending' && (
            // D-099: disabled on a clash is the courtesy; the server's 409 at Confirm is the guard (trap 21).
            <button type="button" className="primary sm" disabled={busy || booking.clash} onClick={() => onConfirm(booking)}>
              Confirm
            </button>
          )}
          {!cancelled && (
            <button type="button" className="sm" disabled={busy} onClick={() => onCancel(booking)}>
              Cancel
            </button>
          )}
        </span>
      </div>
      {/* D-099: the Requests section's warning, on a pending staff booking whose night is already confirmed. Cancel is what staff do with it. */}
      {booking.status === 'pending' && booking.clash && (
        <div className="booking-notes request-clash">A night of this booking is already confirmed for another booking.</div>
      )}
      {/* Notes are a React child, so whatever staff typed is escaped (CLAUDE.md § Conventions). */}
      {booking.notes && <div className="booking-notes">{booking.notes}</div>}
      {/* D-096: what staff wrote when they confirmed or cancelled it. */}
      {booking.decisionNote && (
        <div className="booking-notes decision-note">
          {booking.status === 'cancelled' ? 'Cancelled' : 'Confirmed'}: {booking.decisionNote}
        </div>
      )}
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
        <span className="badge request-ref">{request.reference}</span>
        <span className="booking-guest">{request.guestName}</span>
        <span className="booking-meta">
          {[
            `${request.slot}, ${nights}${dayLabel(request.checkIn)}`,
            request.units.map((u) => `${u.unit}${u.guests ? ` (${u.guests})` : ''}`).join(', '),
            request.total !== null ? formatMoney(request.total, currency) : null,
            request.guestPhone,
            request.guestEmail,
          ]
            .filter(Boolean)
            .join(' · ')}
        </span>
        <span className="booking-badges">
          {/* D-100: which door it came through; both are decided here. */}
          <span className={request.source === 'web' ? 'badge accent' : 'badge'}>{request.source === 'web' ? 'Web' : 'By staff'}</span>
          {!pending && <span className={request.status === 'confirmed' ? 'badge ok' : 'badge'}>{request.status === 'confirmed' ? 'Confirmed' : 'Declined'}</span>}
          {pending && (request.clash || request.closed) && (
            <span className="badge danger">
              <Icon name="alert" size={12} /> {request.closed ? 'Closed date' : 'Clash'}
            </span>
          )}
        </span>
        {pending && (
          <span className="booking-actions">
            <button type="button" className="primary sm" disabled={busy || request.clash || request.closed} onClick={() => onDecide(request, 'confirm')}>
              Confirm
            </button>
            <button type="button" className="sm" disabled={busy} onClick={() => onDecide(request, 'decline')}>
              Decline
            </button>
          </span>
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
      {/* D-096: what staff wrote when they decided it. */}
      {request.decisionNote && (
        <div className="booking-notes decision-note">
          {request.status === 'cancelled' ? 'Declined' : 'Confirmed'}: {request.decisionNote}
        </div>
      )}
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
  const [busy, setBusy] = useState(false);

  // The form.
  const [unitId, setUnitId] = useState<number | null>(null);
  const [slotId, setSlotId] = useState<number | null>(null);
  const [date, setDate] = useState('');
  const [guestName, setGuestName] = useState('');
  const [guestPhone, setGuestPhone] = useState('');
  const [guestCount, setGuestCount] = useState('');
  const [notes, setNotes] = useState('');
  // D-097: the promo picked for this booking; '' = none. The automatic promo
  // covering today is pre-selected once the setup arrives (plan § 2.5).
  const [promoId, setPromoId] = useState<string>('');

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

  // The decisions' dialog (D-096's note), the New booking panel, and the
  // list's status filter, which only narrows what is drawn.
  const { ask, dialog } = useConfirmDialog();
  const [formOpen, setFormOpen] = useState(false);
  const { notice, setNotice } = useNotice(formOpen);
  const [statusFilter, setStatusFilter] = useState<'all' | 'pending' | 'confirmed' | 'cancelled'>('all');

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
        // D-097: the automatic promo covering today is pre-selected, "None" one click away (plan § 2.5).
        const automatic = (body as Setup).promos?.find((p) => p.code === null && p.validFrom <= body.today && p.validTo >= body.today);
        setPromoId(automatic ? String(automatic.id) : '');
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
          body: JSON.stringify({ rooms: chosenRooms, slotId, date, promoId: promoId === '' ? null : Number(promoId) }),
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
  }, [api, chosenRooms, date, perRoom, promoId, slotId, unauthorized]);

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
        const who = { slotId, date, guestName, guestPhone: guestPhone || null, notes: notes || null, promoId: promoId === '' ? null : Number(promoId) };
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
        setFormOpen(false);
        void load();
      } catch (error) {
        // A 409 lands here with the server's own sentence: "That slot on …
        // overlaps an existing booking.", or since D-099 the trigger's
        // "taken on <date>: <unit> is already confirmed for that slot". It
        // is not rephrased.
        setNotice({ message: await describeFailure(error as Error, response), kind: 'error' });
      } finally {
        setBusy(false);
      }
    },
    [api, chosenRooms, date, guestCount, guestName, guestPhone, load, notes, perRoom, setup, slotId, unauthorized, unitId],
  );

  const cancel = useCallback(
    async (booking: BookingSummary) => {
      // D-096: the dialog is both the confirmation and the note. Back or
      // Escape aborts; the action with nothing typed cancels with no note.
      const note = await ask({
        title: 'Cancel this booking?',
        body: `${booking.slot} on ${dayLabel(booking.date)} for ${booking.guestName}. The slot is free again once it is cancelled.`,
        noteLabel: 'Reason',
        actionLabel: 'Cancel booking',
        backLabel: 'Keep it',
        danger: true,
      });
      if (note === null) return;
      setNotice(null);
      setBusy(true);
      let response: Response | null = null;
      try {
        response = await fetch(`${api}/bookings/${booking.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'cancel', note }),
        });
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
    [api, ask, load, unauthorized],
  );

  // D-095: confirm a pending staff booking. The server's 409 (another
  // confirmed booking holds the span) arrives with its own sentence.
  const confirmOne = useCallback(
    async (booking: BookingSummary) => {
      const note = await ask({
        title: 'Confirm this booking?',
        body: `${booking.slot} on ${dayLabel(booking.date)} for ${booking.guestName}. Confirming takes the slot.`,
        noteLabel: 'Note',
        actionLabel: 'Confirm',
      });
      if (note === null) return;
      setNotice(null);
      setBusy(true);
      let response: Response | null = null;
      try {
        response = await fetch(`${api}/bookings/${booking.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'confirm', note }),
        });
        if (response.status === 401) return unauthorized();
        if (!response.ok) throw new Error('failed');
        setNotice({ message: `Confirmed ${booking.slot} on ${dayLabel(booking.date)} for ${booking.guestName}. The slot is now taken.`, kind: 'ok' });
        void load();
      } catch (error) {
        setNotice({ message: await describeFailure(error as Error, response), kind: 'error' });
        void load();
      } finally {
        setBusy(false);
      }
    },
    [api, ask, load, unauthorized],
  );

  const decide = useCallback(
    async (req: BookingRequest, action: 'confirm' | 'decline') => {
      const what = `${req.reference} for ${req.guestName}`;
      // D-096: the dialog is both the confirmation and the note.
      const note = await ask(
        action === 'confirm'
          ? { title: `Confirm ${req.reference}?`, body: `${req.guestName}: ${req.slot} from ${dayLabel(req.checkIn)}. Confirming books the dates; then contact the guest.`, noteLabel: 'Note', actionLabel: 'Confirm' }
          : { title: `Decline ${req.reference}?`, body: `${req.guestName}: ${req.slot} from ${dayLabel(req.checkIn)}.`, noteLabel: 'Reason', actionLabel: 'Decline', danger: true },
      );
      if (note === null) return;
      setNotice(null);
      setBusy(true);
      let response: Response | null = null;
      try {
        response = await fetch(`${api}/bookings/requests/${req.groupId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action, note }),
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
    [api, ask, load, unauthorized],
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

  const frame = { slug, businessName, logoUrl, bannerUrl, features: nav, current: 'bookings' as const, title: 'Bookings', session: { auth, role, onLogout: logout } };
  const newBooking = (
    <button type="button" className="primary" onClick={() => setFormOpen(true)}>
      <Icon name="plus" size={16} /> New booking
    </button>
  );

  if (auth !== 'in') {
    return (
      <>
        <StaffFrame {...frame}>
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
        </StaffFrame>
      </>
    );
  }

  if (!setup || !from || !to) {
    return (
      <>
        <StaffFrame {...frame}>
          <div className="small">{loadMessage}</div>
        </StaffFrame>
      </>
    );
  }

  return (
    <>
      <StaffFrame {...frame} actions={newBooking}>
        {dialog}

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
              Every stay waiting for a decision: sent from the booking page, or made here by staff. A request does not hold its
              dates: the first one you confirm gets them.
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

        <Drawer open={formOpen} title="New booking" onClose={() => setFormOpen(false)}>
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
              {setup.promos.length > 0 && (
                <div className="field">
                  <label htmlFor="promo">
                    Promo <span className="muted">(optional)</span>
                  </label>
                  {/* The discount is the database's; the quote below previews it (D-097). */}
                  <select id="promo" value={promoId} onChange={(e) => setPromoId(e.target.value)}>
                    <option value="">None</option>
                    {setup.promos.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                        {p.code ? ` (${p.code})` : ' (automatic)'}
                        {p.maxUses !== null ? ` · ${p.uses}/${p.maxUses} used` : ''}
                      </option>
                    ))}
                  </select>
                </div>
              )}
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
                    {quote.quote.discount > 0 && (
                      <div className="quote-line quote-discount">
                        <span>Promo: {quote.quote.promo?.name}</span>
                        <span>−{formatMoney(quote.quote.discount, quote.quote.currency)}</span>
                      </div>
                    )}
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
            {/* A refusal while the panel is open is said here, beside the form, not as a toast (useNotice). */}
            {notice?.kind === 'error' && formOpen && (
              <div className="notice error drawer-notice" role="alert">
                {notice.message}
              </div>
            )}
          </form>
        </Drawer>

        <section className="card">
          <div className="range-head">
            <h2>
              {dayLabel(from)} – {dayLabel(to)}
            </h2>
            <div className="range-nav">
              <div className="segmented" role="group" aria-label="Show bookings">
                {(['all', 'pending', 'confirmed', 'cancelled'] as const).map((f) => (
                  <button key={f} type="button" aria-pressed={statusFilter === f} onClick={() => setStatusFilter(f)}>
                    {f === 'all' ? 'All' : f === 'pending' ? 'Pending' : f === 'confirmed' ? 'Confirmed' : 'Cancelled'}
                  </button>
                ))}
              </div>
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
                {dayBookings.filter((b) => statusFilter === 'all' || b.status === statusFilter).map((b) => (
                  <BookingRow key={b.id} booking={b} busy={busy} onCancel={cancel} onConfirm={confirmOne} perRoom={perRoom ? { currency: setup.currency } : null} />
                ))}
              </div>
            ))
          )}
        </section>
      </StaffFrame>
    </>
  );
}
