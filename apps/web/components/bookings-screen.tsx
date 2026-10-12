'use client';

// S-3 · Bookings. ONE list of stays, one row per reference (D-100): every web
// request and staff booking that has not ended, or the last 90 days too, with
// search, a status filter and (per_room) a room filter. A row opens the
// stay's own page (S-15, D-114), where every action is taken; this list has
// no buttons. Dates at a glance are the Calendar's (S-12).
//
// Rendered by app/t/[tenant]/admin/bookings/page.tsx, which has already
// checked on the server that the tenant exists and has the bookings
// application. Every route this screen calls is admin-only, so it starts the
// same way the knowledge-base screen does: is there a session for THIS tenant?
//
// What this screen does NOT do: decide whether a night is free. A pending
// stay holds nothing (D-070), so two can ask for the same night; `clash` warns
// before anyone presses Confirm, and the server's 409 at Confirm is the guard,
// shown as-is (trap 21). Nor does it add up a price: every amount is the
// server's (the quote before, the stored rows after).
//
// A per_room tenant (plan/booking-types.md Phase 4) gets rooms to tick in the
// form (several at once, one guest count each) and a room filter on the list.
//
// The New booking form (D-111) is the booking page with a staff token: a
// check-in and a number of nights, guests for every unit, the guest's name,
// mobile AND email (so the guest can use Manage booking), the same
// night-by-night price (StayLines, the page's own), and a Walk in label.
//
// The look (plan/ui-refresh.md Phase 7): "New booking" is a side panel opened
// beside the page title, and a stay booked there opens on its own page;
// search and the filters narrow the rows already loaded, on screen only.

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  Accommodation,
  BookingGroup,
  Promo,
  BookingRequest,
  BookingType,
  RequestQuote,
  SlotSummary,
  UnitSummary,
} from '@rag/bookings';
import { LoginForm, describeFailure } from '@/components/admin-login';
import { fetchRole } from '@/components/tenant-nav';
import { StaffFrame } from '@/components/staff-frame';
import type { NavFeatures } from '@/lib/nav-items';
import { isRole, type Role } from '@/lib/permissions';
import { formatMoney } from '@/lib/money';
import { Drawer } from '@/components/dialogs';
import { useNotice } from '@/components/toast';
import { Icon } from '@/components/icons';
import { EmptyState, LOADING, LoadState, failed, type Load } from '@/components/load-state';
import { StayLines } from '@/components/stay-lines';
import { CopyText } from '@/components/copy-button';
import { ListSearch } from '@/components/list-search';
import { PAGE_SIZE, matches } from '@/lib/search';

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
  /** D-111: the longest stay and the last check-in date, the limits the server checks (D-078) */
  maxNights: number;
  lastDate: string;
  /** inactive ones included, so the list can still name a retired room */
  units: UnitSummary[];
  slots: SlotSummary[];
  /** the active promos (D-097), for the form's picker; the automatic one is pre-selected */
  promos: Promo[];
}

type Auth = 'checking' | 'out' | 'in';

// "Show past" reaches this far back: stays whose last night was within it.
const PAST_DAYS = 90;

/** stay_payment()'s status, as a badge's words (manage booking § 4). */
const PAYMENT_LABEL: Record<string, string> = {
  unpaid: 'Unpaid',
  submitted: 'Proof to check',
  rejected: 'Proof rejected',
  partially_paid: 'Partly paid',
  paid: 'Paid',
  refunded: 'Refunded',
};

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

/** What a stay's status reads as on its row: a confirmed stay whose nights are over is completed. */
function stayState(stay: BookingRequest, today: string): { label: string; tone: string } {
  const checkOut = addDays(stay.checkIn, stay.nights);
  switch (stay.status) {
    case 'pending':
      return { label: 'Pending', tone: 'warn' };
    case 'confirmed':
      return checkOut <= today ? { label: 'Completed', tone: '' } : stay.checkIn <= today ? { label: 'Staying', tone: 'ok' } : { label: 'Confirmed', tone: 'ok' };
    case 'expired':
      return { label: 'Expired', tone: '' };
    default:
      return { label: 'Cancelled', tone: '' };
  }
}

/**
 * One stay: when, who, what, the stored total and its badges. The whole card
 * opens the stay's page (S-15): the guest's name is the link, stretched over
 * the card (a::after), so the copy buttons inside can sit above it. A button
 * inside a link is not valid HTML, and a screen reader hears one link.
 */
function StayRow({ stay, today, currency, href }: { stay: BookingRequest; today: string; currency: string; href: string }) {
  const pending = stay.status === 'pending';
  const state = stayState(stay, today);
  const checkOut = addDays(stay.checkIn, stay.nights);
  const live = pending || (stay.status === 'confirmed' && checkOut > today);
  return (
    <div className={`booking stay-row${live ? '' : ' decided'}`}>
      <div className="stay-when">
        <span className="stay-dates">
          {stay.nights > 1 ? `${dayLabel(stay.checkIn)} – ${dayLabel(checkOut)}` : dayLabel(stay.checkIn)}
        </span>
        <span className="small muted">
          {stay.slot}
          {stay.nights > 1 ? ` · ${stay.nights} nights` : ''}
        </span>
      </div>
      <div className="stay-who">
        <Link href={href} className="booking-guest stay-row-link" aria-label={`${stay.guestName}, ${stay.reference}, ${state.label}`}>
          {stay.guestName}
        </Link>
        <span className="booking-meta">
          <span>{stay.units.map((u) => `${u.unit}${u.guests ? ` (${u.guests})` : ''}`).join(', ')}</span>
          {stay.guestPhone && <CopyText text={stay.guestPhone} what="mobile number" />}
          {stay.guestEmail && <CopyText text={stay.guestEmail} what="email" />}
        </span>
        <span className="booking-badges">
          <CopyText text={stay.reference} what="reference" className="badge request-ref" />
          <span className={`badge ${state.tone}`}>{state.label}</span>
          {/* D-100: which door it came through. */}
          <span className={stay.source === 'web' ? 'badge accent' : 'badge'}>{stay.source === 'web' ? 'Web' : 'By staff'}</span>
          {stay.walkIn && <span className="badge">Walk in</span>}
          {/* manage booking § 4: the payment, from stay_payment(), and the deadline. */}
          {pending && stay.payment && (
            <span className={`badge ${stay.payment.enough ? 'ok' : stay.payment.status === 'submitted' ? 'warn' : ''}`}>
              {PAYMENT_LABEL[stay.payment.status] ?? stay.payment.status}
              {stay.payment.payBy && !stay.payment.enough
                ? ` · pay by ${new Date(stay.payment.payBy).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}`
                : ''}
            </span>
          )}
          {pending && (stay.clash || stay.closed) && (
            <span className="badge danger">
              <Icon name="alert" size={12} /> {stay.closed ? 'Closed date' : 'Clash'}
            </span>
          )}
        </span>
      </div>
      <div className="stay-end">
        {stay.total !== null && <strong className="stay-total">{formatMoney(stay.total, currency)}</strong>}
        <Icon name="chevron-right" size={18} />
      </div>
      {pending && stay.clash && <div className="booking-notes request-clash">A night of this stay is already taken by another booking.</div>}
      {pending && stay.closed && (
        <div className="booking-notes request-clash">A night of this stay is on a closed date. Decline it, or reopen the date on the Holidays screen.</div>
      )}
      {/* Typed notes are a React child, so they are escaped. */}
      {stay.notes && <div className="booking-notes">{stay.notes}</div>}
      {/* D-096: what staff wrote when they decided it. */}
      {stay.decisionNote && (
        <div className="booking-notes decision-note">
          {stay.status === 'cancelled' ? 'Cancelled' : stay.status === 'expired' ? 'Expired' : 'Confirmed'}: {stay.decisionNote}
        </div>
      )}
    </div>
  );
}

export function BookingsScreen({ slug, businessName, logoUrl, bannerUrl, nav }: BookingsScreenProps) {
  const api = `/api/t/${slug}`;
  const router = useRouter();
  const [auth, setAuth] = useState<Auth>('checking');
  // What this member is, from the session check. Hides the tabs a role cannot
  // open (the routes behind them refuse anyway, with a 403 that names why).
  const [role, setRole] = useState<Role | null>(null);
  const [setup, setSetup] = useState<Setup | null>(null);
  // Where the list starts: today, or the date the Calendar's day view links to (?from=).
  const [from, setFrom] = useState<string | null>(null);
  const [loadState, setLoadState] = useState<Load>(LOADING);
  const [busy, setBusy] = useState(false);

  // The form.
  const [unitId, setUnitId] = useState<number | null>(null);
  const [slotId, setSlotId] = useState<number | null>(null);
  const [date, setDate] = useState('');
  const [nights, setNights] = useState('1');
  const [guestName, setGuestName] = useState('');
  const [guestPhone, setGuestPhone] = useState('');
  const [guestEmail, setGuestEmail] = useState('');
  const [guestCount, setGuestCount] = useState('');
  const [notes, setNotes] = useState('');
  // D-111: a label on the stay, nothing more (still pending, still paid).
  const [walkIn, setWalkIn] = useState(false);
  // D-097: the promo picked for this booking; '' = none. The automatic promo
  // covering today is pre-selected once the setup arrives (plan § 2.5).
  const [promoId, setPromoId] = useState<string>('');

  // per_room: the ticked rooms, each with its own guest count (capacity is
  // checked per room, plan/booking-types.md Phase 2), and the list's room
  // filter. Both types: the server's quote for the stay (D-111).
  const [rooms, setRooms] = useState<Accommodation[] | null>(null);
  const [chosen, setChosen] = useState<Record<number, string>>({});
  const [quote, setQuote] = useState<{ quote: RequestQuote | null; message: string | null }>({ quote: null, message: null });
  // While a price is being asked the footer shows a placeholder, never the
  // last price, which may no longer be true (the booking page's rule).
  const [quotePending, setQuotePending] = useState(false);
  const [roomFilter, setRoomFilter] = useState<number | null>(null);

  // Every stay that has not ended (or, with Show past, ended in the last
  // PAST_DAYS), one per reference; filtered on screen, never re-asked for it.
  const [stays, setStays] = useState<BookingRequest[] | null>(null);
  const [showPast, setShowPast] = useState(false);
  const [search, setSearch] = useState('');
  const [shown, setShown] = useState(PAGE_SIZE);

  // The decisions' dialog (D-096's note), the New booking panel, and the
  // list's status filter, which only narrows what is drawn.
  const [formOpen, setFormOpen] = useState(false);
  const { notice, setNotice } = useNotice(formOpen);
  const [statusFilter, setStatusFilter] = useState<'all' | 'pending' | 'confirmed' | 'cancelled' | 'expired'>('all');

  const unauthorized = useCallback(() => {
    setAuth('out');
    setSetup(null);
    setStays(null);
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
  // Named, not an anonymous effect, so a failed load's Retry runs it again
  // (plan/ui-components.md Phase 2, trap 4).
  const loadSetup = useCallback(async () => {
    let response: Response | null = null;
    try {
      response = await fetch(`${api}/bookings/setup`);
      if (response.status === 401) return unauthorized();
      if (!response.ok) throw new Error('failed');
      const body: Setup = await response.json();
      setSetup(body);
      // ?from=YYYY-MM-DD opens the list at that date (the calendar's Day view
      // links here, plan/calendar.md § 4.2): the stays still running then.
      const asked = new URLSearchParams(window.location.search).get('from');
      setFrom(asked && /^\d{4}-\d{2}-\d{2}$/.test(asked) && asked > body.today ? asked : body.today);
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
        setRooms(r.ok ? await r.json() : []);
      }
    } catch (error) {
      setLoadState(failed(await describeFailure(error as Error, response)));
    }
  }, [api, unauthorized]);

  useEffect(() => {
    if (auth === 'in') void loadSetup();
  }, [auth, loadSetup]);

  // The stays, one call: the list route has every stay as one row, with its
  // payment, clash and walk-in already worked out on the server.
  const listFrom = from && setup ? (showPast ? addDays(from < setup.today ? from : setup.today, -PAST_DAYS) : from) : null;
  const load = useCallback(async () => {
    if (!listFrom) return;
    let response: Response | null = null;
    try {
      response = await fetch(`${api}/bookings/requests?from=${listFrom}`);
      if (response.status === 401) return unauthorized();
      if (!response.ok) throw new Error('failed');
      setStays(await response.json());
    } catch (error) {
      setStays(null);
      setLoadState(failed(await describeFailure(error as Error, response)));
    }
  }, [api, listFrom, unauthorized]);

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
  // What the stay books, in the booking page's shape, `[{ unitId, guests }]`;
  // null until every unit has its guests (the page's rule, D-111).
  const stayRooms = useMemo(() => {
    const picked = perRoom ? chosenRooms : unitId === null ? [] : [{ unitId, guestCount: guestCount === '' ? null : Number(guestCount) }];
    if (picked.length === 0 || picked.some((r) => r.guestCount === null)) return null;
    return picked.map((r) => ({ unitId: r.unitId, guests: r.guestCount as number }));
  }, [chosenRooms, guestCount, perRoom, unitId]);
  // Why Book is not ready yet, in words, instead of a silently disabled button.
  const missing =
    slotId === null
      ? 'Choose a slot'
      : !date
        ? 'Choose a date'
        : perRoom && chosenRooms.length === 0
          ? 'Choose a room'
          : stayRooms === null
            ? perRoom
              ? 'Enter the guests for each room'
              : 'Enter the number of guests'
            : null;
  // A day slot is one date; a nightly one takes a number of nights.
  const nightly = setup?.slots.find((s) => s.id === slotId)?.nightly ?? false;
  const nightCount = nightly && nights !== '' ? Number(nights) : 1;

  // The server's price for the stay, night by night, re-asked whenever it
  // changes: the booking page's quote (D-111). Its total is what the booking
  // will store, because both come from unit_quote().
  useEffect(() => {
    if (stayRooms === null || slotId === null || !date) {
      setQuote({ quote: null, message: null });
      setQuotePending(false);
      return;
    }
    let stale = false;
    setQuote({ quote: null, message: null });
    setQuotePending(true);
    void (async () => {
      let response: Response | null = null;
      try {
        response = await fetch(`${api}/bookings/quote`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          // The guests go too: the extra-guest fee is part of the price, and
          // the server refuses a party above a room's maximum here, before
          // anyone presses Book.
          body: JSON.stringify({ rooms: stayRooms, slotId, checkIn: date, nights: nightCount, promoId: promoId === '' ? null : Number(promoId) }),
        });
        if (response.status === 401) return unauthorized();
        if (!response.ok) throw new Error('failed');
        const body: RequestQuote = await response.json();
        if (!stale) setQuote({ quote: body, message: null });
      } catch (error) {
        const message = await describeFailure(error as Error, response);
        if (!stale) setQuote({ quote: null, message });
      } finally {
        if (!stale) setQuotePending(false);
      }
    })();
    return () => {
      stale = true;
    };
  }, [api, date, nightCount, promoId, slotId, stayRooms, unauthorized]);

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
        response = await fetch(`${api}/bookings`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            slotId,
            rooms: stayRooms,
            checkIn: date,
            nights: nightCount,
            name: guestName,
            phone: guestPhone,
            email: guestEmail,
            notes: notes || null,
            promoId: promoId === '' ? null : Number(promoId),
            walkIn,
          }),
        });
        if (response.status === 401) return unauthorized();
        if (!response.ok) throw new Error('failed');
        // One stay, one reference (D-100); the total is what was STORED.
        const group: BookingGroup = await response.json();
        const [first] = group.bookings;
        const span = nightCount > 1 ? `${nightCount} nights from ${dayLabel(date)}` : dayLabel(date);
        const units = perRoom ? `${[...new Set(group.bookings.map((b) => b.unit))].join(', ')}, ` : '';
        setNotice({
          message:
            `Booked ${first?.reference ?? ''} for ${first?.guestName}: ${units}${first?.slot}, ${span}.` +
            (group.total !== null && setup ? ` Total ${formatMoney(group.total, setup.currency)}.` : ''),
          kind: 'ok',
        });
        setChosen({});
        setGuestName('');
        setGuestPhone('');
        setGuestEmail('');
        setGuestCount('');
        setNotes('');
        setNights('1');
        setWalkIn(false);
        setFormOpen(false);
        // The new stay opens on its own page, where it is confirmed (D-114).
        if (first?.reference) router.push(`/t/${slug}/admin/bookings/${first.reference}`);
        else void load();
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
    [api, date, guestEmail, guestName, guestPhone, load, nightCount, notes, perRoom, promoId, router, setNotice, setup, slotId, slug, stayRooms, unauthorized, walkIn],
  );

  // The list as drawn: status, room and search narrow what was loaded; then
  // by check-in, the soonest first. Counts per status for the filter's labels.
  const visible = useMemo(() => {
    if (!stays) return [];
    return stays
      .filter((st) => statusFilter === 'all' || st.status === statusFilter)
      .filter((st) => roomFilter === null || st.units.some((u) => u.unitId === roomFilter))
      .filter((st) => matches([st.reference, st.guestName, st.guestPhone ?? '', st.guestEmail ?? '', st.units.map((u) => u.unit).join(' ')].join(' '), search))
      .sort((a, b) => (a.checkIn === b.checkIn ? (a.createdAt < b.createdAt ? -1 : 1) : a.checkIn < b.checkIn ? -1 : 1));
  }, [roomFilter, search, statusFilter, stays]);
  const countOf = (status: 'pending' | 'confirmed' | 'cancelled' | 'expired') => stays?.filter((st) => st.status === status).length ?? 0;

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

  if (!setup || !from) {
    return (
      <>
        <StaffFrame {...frame}>
          <LoadState load={loadState} what="setup" onRetry={() => { setLoadState(LOADING); void loadSetup(); }} />
        </StaffFrame>
      </>
    );
  }

  return (
    <>
      <StaffFrame {...frame} actions={newBooking}>
        <section className="card stays">
          <div className="range-head">
            <h2>Stays</h2>
            <div className="range-nav">
              <Link className="button" href={`/t/${slug}/admin/calendar`}>
                <Icon name="calendar" size={16} /> Calendar
              </Link>
              <Link className="button" href={`/t/${slug}/book`}>
                Booking page
              </Link>
            </div>
          </div>
          <div className="stays-toolbar">
            <ListSearch value={search} onChange={(v) => { setSearch(v); setShown(PAGE_SIZE); }} label="Search reference, guest, phone, email" />
            <div className="segmented" role="group" aria-label="Show stays">
              {(['all', 'pending', 'confirmed', 'cancelled', 'expired'] as const).map((f) => (
                <button key={f} type="button" aria-pressed={statusFilter === f} onClick={() => { setStatusFilter(f); setShown(PAGE_SIZE); }}>
                  {f === 'all' ? 'All' : f === 'pending' ? 'Pending' : f === 'confirmed' ? 'Confirmed' : f === 'expired' ? 'Expired' : 'Cancelled'}
                  {f !== 'all' && countOf(f) > 0 && <span className="segment-count">{countOf(f)}</span>}
                </button>
              ))}
            </div>
            {perRoom && (
              <select aria-label="Show room" value={roomFilter ?? ''} onChange={(e) => { setRoomFilter(e.target.value === '' ? null : Number(e.target.value)); setShown(PAGE_SIZE); }}>
                <option value="">All rooms</option>
                {setup.units.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name}
                    {u.active ? '' : ' (retired)'}
                  </option>
                ))}
              </select>
            )}
            <label className="check-line stays-past">
              <input type="checkbox" checked={showPast} onChange={(e) => { setShowPast(e.target.checked); setShown(PAGE_SIZE); }} /> Show the last {PAST_DAYS} days
            </label>
          </div>
          <p className="small muted">
            {from > setup.today ? `Stays running on or after ${dayLabel(from)}. ` : ''}A pending stay does not hold its dates: the first one you confirm gets them.
          </p>

          {stays === null ? (
            <LoadState load={loadState} what="stays" rows={5} onRetry={() => { setLoadState(LOADING); void load(); }} />
          ) : visible.length === 0 ? (
            stays.length === 0 ? (
              <EmptyState icon="calendar" title="No stays yet" action={newBooking}>
                A request from the booking page, or a booking made here, appears in this list.
              </EmptyState>
            ) : (
              <EmptyState icon="search" title="No stays match" compact>
                Change the search or the filters.
              </EmptyState>
            )
          ) : (
            <>
              {visible.slice(0, shown).map((st) => (
                <StayRow key={st.groupId} stay={st} today={setup.today} currency={setup.currency} href={`/t/${slug}/admin/bookings/${st.reference}`} />
              ))}
              {visible.length > shown && (
                <div className="list-more">
                  <span>
                    Showing {shown} of {visible.length}
                  </span>
                  <button type="button" className="sm" onClick={() => setShown((n) => n + PAGE_SIZE)}>
                    Show {Math.min(PAGE_SIZE, visible.length - shown)} more
                  </button>
                </div>
              )}
            </>
          )}
        </section>

        <Drawer open={formOpen} title="New booking" onClose={() => setFormOpen(false)}>
          {/* Three sections in the order a booking is taken: when, who, anything
              else. The price depends on the first, so it comes first. The footer
              stays in view with the server's total and the one Book button. */}
          <form onSubmit={book} className="booking-form">
            <fieldset className="form-section">
              <legend>Stay</legend>
              <div className="field-row">
                <div className="field grow">
                  <label htmlFor="slot">Slot</label>
                  <select id="slot" value={slotId ?? ''} onChange={(e) => setSlotId(Number(e.target.value))}>
                    {setup.slots.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name} — {s.startTime}, {durationLabel(s.duration)}
                      </option>
                    ))}
                  </select>
                </div>
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
              </div>
              <div className="field-row">
                <div className="field">
                  <label htmlFor="date">{nightly ? 'Check-in' : 'Date'}</label>
                  <input
                    type="date"
                    id="date"
                    required
                    min={setup.today}
                    max={setup.lastDate}
                    value={date}
                    onChange={(e) => setDate(e.target.value)}
                  />
                </div>
                {nightly && (
                  <div className="field narrow">
                    <label htmlFor="nights">Nights</label>
                    <input
                      type="number"
                      id="nights"
                      required
                      min={1}
                      max={setup.maxNights}
                      step={1}
                      value={nights}
                      onChange={(e) => setNights(e.target.value)}
                    />
                  </div>
                )}
                {!perRoom && (
                  <div className="field narrow">
                    <label htmlFor="guest-count">Guests</label>
                    <input
                      type="number"
                      id="guest-count"
                      required
                      min={1}
                      step={1}
                      value={guestCount}
                      onChange={(e) => setGuestCount(e.target.value)}
                    />
                  </div>
                )}
              </div>
              {/* Calendar arithmetic only, for reading back; the server prices the nights. */}
              {date && (
                <p className="hint stay-span">
                  <Icon name="calendar" size={14} />
                  {nightly
                    ? `${nightCount} night${nightCount === 1 ? '' : 's'}: ${dayLabel(date)} to ${dayLabel(addDays(date, nightCount))}`
                    : dayLabel(date)}
                  {' · '}times in {setup.timezone}
                </p>
              )}

              {perRoom && (
                <div className="field rooms-field">
                  <span className="field-label" id="rooms-label">
                    Rooms
                  </span>
                  {/* null until the rooms arrive: "no rooms" is said only once it is true. */}
                  {rooms === null ? (
                    <div className="quote-skeleton" role="status" aria-label="Loading rooms">
                      <span />
                      <span />
                    </div>
                  ) : (
                    rooms.filter((r) => r.active).length === 0 && (
                      <div className="small muted">
                        No rooms yet. Add them on the <Link href={`/t/${slug}/admin/accommodations`}>Rooms</Link> screen.
                      </div>
                    )
                  )}
                  <div className="room-picks" role="group" aria-labelledby="rooms-label">
                    {(rooms ?? [])
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
                              />
                              <span className="room-pick-text">
                                <span className="room-pick-name">{r.name}</span>
                                <span className="small muted">
                                  {[
                                    r.capacity !== null ? `up to ${r.capacity}` : null,
                                    r.standardCapacity !== null && r.extraPersonRate !== null && r.extraPersonRate > 0
                                      ? `${r.standardCapacity} included, +${formatMoney(r.extraPersonRate, setup.currency)} each extra`
                                      : null,
                                    r.rates.length === 0 ? 'no rate yet' : null,
                                  ]
                                    .filter(Boolean)
                                    .join(' · ')}
                                </span>
                              </span>
                            </label>
                            {picked && (
                              <label className="room-pick-guests">
                                <span className="small muted">Guests</span>
                                <input
                                  type="number"
                                  min={1}
                                  max={r.capacity ?? undefined}
                                  step={1}
                                  required
                                  aria-label={`Guests in ${r.name}`}
                                  value={chosen[r.id]}
                                  onChange={(e) => setChosen((current) => ({ ...current, [r.id]: e.target.value }))}
                                />
                              </label>
                            )}
                          </div>
                        );
                      })}
                  </div>
                </div>
              )}
            </fieldset>

            <fieldset className="form-section">
              <legend>Guest</legend>
              <div className="field">
                <label htmlFor="guest-name">Name</label>
                <input type="text" id="guest-name" required autoComplete="off" value={guestName} onChange={(e) => setGuestName(e.target.value)} />
              </div>
              {/* D-111: both, as on the booking page, so the guest can find the stay on Manage booking with either. */}
              <div className="field-row">
                <div className="field">
                  <label htmlFor="guest-phone">Mobile number</label>
                  <input
                    type="tel"
                    id="guest-phone"
                    required
                    autoComplete="off"
                    placeholder="0917 123 4567"
                    value={guestPhone}
                    onChange={(e) => setGuestPhone(e.target.value)}
                  />
                </div>
                <div className="field">
                  <label htmlFor="guest-email">Email</label>
                  <input
                    type="email"
                    id="guest-email"
                    required
                    autoComplete="off"
                    placeholder="name@example.com"
                    value={guestEmail}
                    onChange={(e) => setGuestEmail(e.target.value)}
                  />
                </div>
              </div>
              <p className="hint">The guest finds this booking on Manage booking with its reference and either of these.</p>
              <div className={`option-card${walkIn ? ' picked' : ''}`}>
                <label>
                  <input type="checkbox" checked={walkIn} onChange={(e) => setWalkIn(e.target.checked)} />
                  <span className="room-pick-text">
                    <span className="room-pick-name">Walk in</span>
                    <span className="small muted">The guest is here in person, so there is no deadline to pay. Confirm it once they have paid.</span>
                  </span>
                </label>
                {/* A walk-in usually starts today; one click, never automatic. */}
                {walkIn && date !== setup.today && (
                  <button type="button" className="sm" onClick={() => setDate(setup.today)}>
                    Check in today
                  </button>
                )}
              </div>
            </fieldset>

            <fieldset className="form-section">
              <legend>Extras</legend>
              {setup.promos.length > 0 && (
                <div className="field">
                  <label htmlFor="promo">
                    Promo <span className="muted">(optional)</span>
                  </label>
                  {/* The discount is the database's; the quote previews it (D-097). */}
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
              <div className="field">
                <label htmlFor="notes">
                  Notes <span className="muted">(optional)</span>
                </label>
                <textarea id="notes" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
              </div>
            </fieldset>

            {/* The booking page's breakdown (D-111): each night's rate, extra guests,
                holiday surcharge and promo, then the total. Every number is the server's. */}
            <section className="form-section price-section" aria-labelledby="price-heading" aria-live="polite">
              <h3 id="price-heading">Price</h3>
              {quotePending ? (
                <div className="quote-skeleton" role="status" aria-label="Getting the price">
                  <span />
                  <span />
                  <span />
                </div>
              ) : quote.quote ? (
                <div className={quote.quote.available ? 'quote' : 'quote error'}>
                  {!quote.quote.available && (
                    <div className="quote-warning">A night in this stay is already booked. Confirming it would be refused.</div>
                  )}
                  <StayLines
                    lines={quote.quote.lines}
                    currency={quote.quote.currency}
                    total={quote.quote.total}
                    discount={quote.quote.discount}
                    promoName={quote.quote.promo?.name ?? null}
                  />
                </div>
              ) : quote.message ? (
                <div className="quote error">{quote.message}</div>
              ) : (
                <p className="small muted">{missing ?? 'The price appears here.'}</p>
              )}
            </section>

            {/* A refusal while the panel is open is said here, above the button, not as a toast (useNotice). */}
            {notice?.kind === 'error' && formOpen && (
              <div className="notice error drawer-notice" role="alert">
                {notice.message}
              </div>
            )}

            <div className="drawer-footer">
              <div className="drawer-footer-total">
                {quote.quote && !quotePending ? (
                  <>
                    <span className="small muted">Total</span>
                    <strong>{formatMoney(quote.quote.total, quote.quote.currency)}</strong>
                  </>
                ) : (
                  <span className="small muted">{quotePending ? 'Getting the price…' : (missing ?? (quote.message ? 'Fix the stay to see a price' : ''))}</span>
                )}
              </div>
              <button type="button" onClick={() => setFormOpen(false)}>
                Cancel
              </button>
              <button
                type="submit"
                className="primary"
                // Every unit needs its guests, and a quote must have come back
                // (D-111). The server checks everything again.
                disabled={busy || slotId === null || stayRooms === null || quote.quote === null || quotePending}
              >
                {busy ? 'Saving…' : 'Book'}
              </button>
            </div>
          </form>
        </Drawer>

      </StaffFrame>
    </>
  );
}
