'use client';

// S-12 · Calendar (plan/calendar.md, D-103). Every date's state at a glance,
// by month, week or day, from ONE route that returns calendar_days() (and,
// for a week or a day, calendar_slots()). This screen draws: it never counts,
// compares or rolls up (plan Rule 1). It writes nothing either: the Day view
// links to the Bookings screen, which confirms and cancels (§ 7 q4).
//
// The background is the date's ONE exclusive state (available, partly booked,
// fully booked, closed); a holiday or peak and the pending requests are
// markers on top, because a date can be all three at once (§ 4.1). Every
// state is also a word in the cell and a sentence for a screen reader
// (Rule 4); the legend shows each swatch beside its word.
//
// The view, date and room live in the address (?view=week&date=…&unit=…):
// moving pushes a history entry, so Back goes back a step, and a reload or a
// shared link lands on the same view.

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import type { DayBooking, DaySlotBooking, OccupancyDay, OccupancySlot } from '@rag/bookings';
import { LoginForm, describeFailure } from '@/components/admin-login';
import { CalendarLegend } from '@/components/calendar-legend';
import { DayMarkers, MonthGrid, dayClasses } from '@/components/month-grid';
import { fetchRole } from '@/components/tenant-nav';
import { StaffFrame } from '@/components/staff-frame';
import { CopyText } from '@/components/copy-button';
import { Icon } from '@/components/icons';
import { LOADING, LoadState, failed, type Load } from '@/components/load-state';
import { STATE_WORD, cellText, dayMarker, longDate, pendingWords, sentence } from '@/lib/calendar-labels';
import { VIEWS, monthOptions, step, type CalendarView } from '@/lib/calendar-range';
import type { NavFeatures } from '@/lib/nav-items';
import { isRole, type Role } from '@/lib/permissions';

export interface CalendarScreenProps {
  slug: string;
  businessName: string;
  logoUrl: string | null;
  bannerUrl: string | null;
  nav: NavFeatures;
  perRoom: boolean;
  /** Active rooms, names only, for the room select (per_room). */
  rooms: { id: number; name: string }[];
  initial: { view: CalendarView; date: string | null; unit: number | null };
}

type Auth = 'checking' | 'out' | 'in';

interface CalendarData {
  view: CalendarView;
  date: string;
  from: string;
  to: string;
  today: string;
  days: OccupancyDay[];
  slots: OccupancySlot[] | null;
  /** Day view only: every booking overlapping each slot, with its guest. */
  bookings: DaySlotBooking[] | null;
}

const VIEW_LABEL: Readonly<Record<CalendarView, string>> = {
  month: 'Month',
  week: 'Week',
  day: 'Day',
};
/** The step buttons name the step (the user, 2026-10-09): "Next month", "Previous day". */
const UNIT: Readonly<Record<CalendarView, string>> = {
  month: 'month',
  week: 'week',
  day: 'day',
};

const short = (date: string, options: Intl.DateTimeFormatOptions) =>
  new Date(`${date}T00:00:00Z`).toLocaleDateString('en-GB', {
    ...options,
    timeZone: 'UTC',
  });

/** "October 2026", "12 – 18 Oct 2026", "Friday 16 October 2026". */
function periodTitle(view: CalendarView, date: string, from: string, to: string): string {
  if (view === 'month') return short(date, { month: 'long', year: 'numeric' });
  if (view === 'day') return longDate(date);
  const sameMonth = from.slice(0, 7) === to.slice(0, 7);
  return `${sameMonth ? Number(from.slice(8)) : short(from, { day: 'numeric', month: 'short' })} – ${short(to, { day: 'numeric', month: 'short', year: 'numeric' })}`;
}

function query(view: CalendarView, date: string | null, unit: number | null): string {
  const params = new URLSearchParams({ view });
  if (date) params.set('date', date);
  if (unit !== null) params.set('unit', String(unit));
  return params.toString();
}

export function CalendarScreen({ slug, businessName, logoUrl, bannerUrl, nav, perRoom, rooms, initial }: CalendarScreenProps) {
  const api = `/api/t/${slug}`;
  const [auth, setAuth] = useState<Auth>('checking');
  const [role, setRole] = useState<Role | null>(null);
  const [view, setView] = useState<CalendarView>(initial.view);
  // null until the route says what today is: the TENANT's today, not this browser's.
  const [date, setDate] = useState<string | null>(initial.date);
  const [unit, setUnit] = useState<number | null>(initial.unit);
  const [data, setData] = useState<CalendarData | null>(null);
  const [loadState, setLoadState] = useState<Load>(LOADING);

  const unauthorized = useCallback(() => {
    setAuth('out');
    setData(null);
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const body = await (await fetch(`${api}/admin/session`)).json();
        setAuth(body.admin === true ? 'in' : 'out');
        setRole(isRole(body.role) ? body.role : null);
      } catch {
        setAuth('out');
      }
    })();
  }, [api]);

  const load = useCallback(async () => {
    let response: Response | null = null;
    try {
      response = await fetch(`${api}/calendar?${query(view, date, unit)}`);
      if (response.status === 401) return unauthorized();
      if (!response.ok) throw new Error('failed');
      const body: CalendarData = await response.json();
      setData(body);
      if (date === null) setDate(body.date);
    } catch (error) {
      setData(null);
      setLoadState(failed(await describeFailure(error as Error, response)));
    }
  }, [api, view, date, unit, unauthorized]);

  useEffect(() => {
    if (auth === 'in') void load();
  }, [auth, load]);

  // Keep the address in step: a push per move, so Back retraces them.
  const go = useCallback(
    (next: { view?: CalendarView; date?: string | null; unit?: number | null }) => {
      const v = next.view ?? view;
      const d = next.date === undefined ? date : next.date;
      const u = next.unit === undefined ? unit : next.unit;
      setLoadState(LOADING);
      setData(null);
      setView(v);
      setDate(d);
      setUnit(u);
      window.history.pushState(null, '', `${window.location.pathname}?${query(v, d, u)}`);
    },
    [view, date, unit],
  );

  useEffect(() => {
    const onPop = () => {
      const params = new URLSearchParams(window.location.search);
      const v = params.get('view');
      setData(null);
      setView(VIEWS.includes(v as CalendarView) ? (v as CalendarView) : 'month');
      setDate(params.get('date'));
      const u = Number(params.get('unit'));
      setUnit(Number.isInteger(u) && u > 0 ? u : null);
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const logout = useCallback(async () => {
    await fetch(`${api}/admin/session`, { method: 'DELETE' }).catch(() => undefined);
    unauthorized();
  }, [api, unauthorized]);

  const frame = {
    slug,
    businessName,
    logoUrl,
    bannerUrl,
    features: nav,
    current: 'calendar' as const,
    title: 'Calendar',
    session: { auth, role, onLogout: logout },
  };

  if (auth !== 'in') {
    return (
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
    );
  }

  const shown = data && date ? data : null;

  return (
    <StaffFrame {...frame}>
      <section className="card">
        {/* One row: the period between its two arrows, Today, then the view and the room. */}
        <div className="cal-toolbar">
          <div className="cal-period">
            <button type="button" className="icon-button" aria-label={`Previous ${UNIT[view]}`} disabled={!shown} onClick={() => date && go({ date: step(view, date, -1) })}>
              <Icon name="chevron-left" size={18} />
            </button>
            {view === 'month' ? (
              // The month view's title IS the month picker (the user, 2026-10-09:
              // a label beside a dropdown saying the same was redundant). A year
              // either side of the tenant's today; picking one opens it whole.
              <select
                className="cal-month-select"
                aria-label="Month"
                disabled={!shown}
                value={shown ? shown.date.slice(0, 7) : ''}
                onChange={(e) => go({ date: `${e.target.value}-01` })}
              >
                {shown ? (
                  monthOptions(shown.today, shown.date).map((m) => (
                    <option key={m} value={m}>
                      {short(`${m}-01`, { month: 'long', year: 'numeric' })}
                    </option>
                  ))
                ) : (
                  <option value="">…</option>
                )}
              </select>
            ) : (
              <h2 aria-live="polite">{shown ? periodTitle(view, shown.date, shown.from, shown.to) : '…'}</h2>
            )}
            <button type="button" className="icon-button" aria-label={`Next ${UNIT[view]}`} disabled={!shown} onClick={() => date && go({ date: step(view, date, 1) })}>
              <Icon name="chevron-right" size={18} />
            </button>
            <button type="button" className="sm" disabled={!shown || shown.date === shown.today} onClick={() => shown && go({ date: shown.today })}>
              Today
            </button>
          </div>
          <div className="cal-filters">
            <div className="segmented" role="group" aria-label="View">
              {VIEWS.map((v) => (
                <button key={v} type="button" aria-pressed={view === v} onClick={() => go({ view: v })}>
                  {VIEW_LABEL[v]}
                </button>
              ))}
            </div>
            {perRoom && rooms.length > 1 && (
              <select
                aria-label="Show room"
                value={unit ?? ''}
                onChange={(e) =>
                  go({
                    unit: e.target.value === '' ? null : Number(e.target.value),
                  })
                }
              >
                <option value="">All rooms</option>
                {rooms.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </select>
            )}
          </div>
        </div>

        {!shown ? (
          <LoadState
            load={loadState}
            what="calendar"
            rows={5}
            onRetry={() => {
              setLoadState(LOADING);
              void load();
            }}
          />
        ) : view === 'month' ? (
          <MonthGrid
            days={shown.days}
            month={shown.date.slice(0, 7)}
            today={shown.today}
            caption={periodTitle('month', shown.date, shown.from, shown.to)}
            onPick={(d) => go({ view: 'day', date: d })}
          />
        ) : view === 'week' ? (
          <WeekView data={shown} perRoom={perRoom} onPick={(d) => go({ view: 'day', date: d })} />
        ) : (
          <DayView data={shown} slug={slug} />
        )}

        {/* The key under the grid: the grid is what people came for; every cell says its state in words too. */}
        {shown && view !== 'day' && <CalendarLegend />}
      </section>
    </StaffFrame>
  );
}

/** A slot's state on a date, as one word: what the cell says (the colour says it too, never alone). */
const SLOT_WORD: Record<OccupancySlot['state'], string> = { taken: 'Booked', open: 'Open', closed: 'Closed' };

/**
 * The week (regrouped 2026-10-12): a column per date, and per room a row
 * for each of its slots, under the room's name, so a slot is named once at
 * the start of its row instead of in every cell. Each cell is one block in
 * the slot's state, with one word and the pending count, and opens the Day
 * view of its date. Today's column is tinted, the weekend's dates marked;
 * the room and slot column stays put while the table scrolls sideways on a
 * phone, inside itself, never the page.
 */
function WeekView({ data, perRoom, onPick }: { data: CalendarData; perRoom: boolean; onPick: (date: string) => void }) {
  const slots = data.slots ?? [];
  const rooms = [...new Map(slots.map((s) => [s.unitId, s.unit])).entries()];
  const weekend = (day: string) => [0, 6].includes(new Date(`${day}T00:00:00Z`).getUTCDay());
  const colClass = (day: string) => [day === data.today ? 'today-col' : '', weekend(day) ? 'weekend-col' : ''].filter(Boolean).join(' ') || undefined;
  return (
    <div className="cal-week-scroll">
      <table className="cal-week">
        <caption className="visually-hidden">{periodTitle('week', data.date, data.from, data.to)}</caption>
        <thead>
          <tr>
            <th scope="col" className="cal-week-corner">
              {perRoom ? 'Room and slot' : <span className="visually-hidden">Slot</span>}
            </th>
            {data.days.map((day) => (
              <th key={day.day} scope="col" className={colClass(day.day)}>
                <button type="button" className={dayClasses(day, data.today, 'cal-week-day')} aria-label={sentence(day, data.today)} onClick={() => onPick(day.day)}>
                  <span className="cal-week-weekday" aria-hidden="true">
                    {short(day.day, { weekday: 'short' })}
                  </span>
                  <strong className="cal-week-date" aria-hidden="true">
                    {short(day.day, { day: 'numeric' })}
                  </strong>
                  {cellText(day) && (
                    <span className="cal-word" aria-hidden="true">
                      {cellText(day)}
                    </span>
                  )}
                  <span className="cal-markers" aria-hidden="true">
                    <DayMarkers day={day} />
                  </span>
                </button>
              </th>
            ))}
          </tr>
        </thead>
        {rooms.map(([unitId, name]) => {
          const roomSlots = [...new Map(slots.filter((s) => s.unitId === unitId).map((s) => [s.slotId, s.slot])).entries()];
          return (
            <tbody key={unitId} className="cal-week-room">
              <tr className="cal-week-room-head">
                <th scope="rowgroup" colSpan={data.days.length + 1}>
                  {name}
                </th>
              </tr>
              {roomSlots.map(([slotId, slotName]) => (
                <tr key={slotId}>
                  <th scope="row" className="cal-week-slot">
                    {slotName}
                  </th>
                  {data.days.map((day) => {
                    const cell = slots.find((s) => s.day === day.day && s.unitId === unitId && s.slotId === slotId);
                    if (!cell) return <td key={day.day} className={colClass(day.day)} />;
                    return (
                      <td key={day.day} className={colClass(day.day)}>
                        <button
                          type="button"
                          className={`wk-cell ${cell.state}`}
                          aria-label={`${name}, ${slotName}, ${short(day.day, { weekday: 'long', day: 'numeric', month: 'long' })}: ${SLOT_WORD[cell.state].toLowerCase()}${cell.pending > 0 ? `, ${pendingWords(cell.pending)}` : ''}. Open the day.`}
                          onClick={() => onPick(day.day)}
                        >
                          <span aria-hidden="true">{SLOT_WORD[cell.state]}</span>
                          {cell.pending > 0 && (
                            <span className="cal-pending sm" aria-hidden="true">
                              {cell.pending}
                            </span>
                          )}
                        </button>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          );
        })}
      </table>
      {rooms.length === 0 && <p className="small muted">No active rooms or slots to show.</p>}
    </div>
  );
}

/** "Thu 26 Nov" — a booking's own date, when the stay began before the day shown. */
const since = (date: string) => short(date, { weekday: 'short', day: 'numeric', month: 'short' });

/** One booking at the front desk: who, how to reach them, how many, and its reference. No price (plan § 6). */
/**
 * One booking on the day, once however many of the room's slots it covers:
 * who, its state, its reference, since when, how many, the contacts, and a
 * link to its page (S-15), where it is acted on.
 */
function BookingRow({ booking: b, day, slug }: { booking: DayBooking; day: string; slug: string }) {
  const earlier = b.date !== day;
  return (
    <li className="cal-booking">
      <div className="cal-booking-head">
        <strong>{b.guestName}</strong>
        <span className={`badge ${b.status === 'confirmed' ? 'ok' : 'warn'}`}>{b.status === 'confirmed' ? 'Confirmed' : 'Pending'}</span>
        {b.reference && <CopyText text={b.reference} what="reference" className="badge request-ref" />}
        {b.source === 'web' && <span className="badge">Booking page</span>}
        {b.clash && (
          <span className="badge danger">
            <Icon name="alert" size={14} /> would clash on Confirm
          </span>
        )}
        {b.reference && (
          <Link className="button sm cal-booking-open" href={`/t/${slug}/admin/bookings/${b.reference}`}>
            Open booking <Icon name="chevron-right" size={14} />
          </Link>
        )}
      </div>
      <p className="cal-booking-line">
        {/* The booking's OWN slot ("Night since Fri 27 Nov"), not the slots it reaches on this day: those are the chips above. */}
        {[earlier ? `${b.slot} since ${since(b.date)}` : `${b.slot}, starts today`, b.guestCount !== null ? `${b.guestCount} guest${b.guestCount === 1 ? '' : 's'}` : null]
          .filter(Boolean)
          .join(' · ')}
      </p>
      {(b.guestPhone || b.guestEmail) && (
        <p className="cal-booking-contact">
          {b.guestPhone && (
            <CopyText text={b.guestPhone} what="mobile number">
              <a href={`tel:${b.guestPhone}`}>{b.guestPhone}</a>
            </CopyText>
          )}
          {b.guestEmail && (
            <CopyText text={b.guestEmail} what="email">
              <a href={`mailto:${b.guestEmail}`}>{b.guestEmail}</a>
            </CopyText>
          )}
        </p>
      )}
      {/* Typed notes are a React child, so they are escaped. */}
      {b.notes && <p className="cal-booking-notes">{b.notes}</p>}
    </li>
  );
}

/**
 * The day: its state, then each room and slot with every booking that
 * overlaps it (the server's calendar_bookings(): a stay that began the night
 * before is listed too, marked "Since …"). Read-only; Bookings acts on them.
 */
function DayView({ data, slug }: { data: CalendarData; slug: string }) {
  const day = data.days[0];
  const slots = data.slots ?? [];
  const bookings = data.bookings ?? [];
  if (!day) return null;
  const marker = dayMarker(day);
  // Bookings starts at today and goes forward; a past date opens it at today.
  const bookingsHref = `/t/${slug}/admin/bookings${day.day >= data.today ? `?from=${day.day}` : ''}`;

  return (
    <div className="cal-dayview">
      <div className={dayClasses(day, data.today, 'cal-day-summary')}>
        <strong>{STATE_WORD[day.state]}</strong>
        {(day.state === 'partial' || day.state === 'full') && (
          <span>
            {day.taken} of {day.sellable} taken
          </span>
        )}
        {day.state === 'closed' && day.label && <span>{day.label}</span>}
        {marker && (
          <span className={`badge ${marker.kind === 'holiday' ? 'warn' : 'accent'}`}>
            <Icon name={marker.kind === 'holiday' ? 'star' : 'flame'} size={14} /> {marker.text}
          </span>
        )}
        {day.pending > 0 && <span className="badge accent">{pendingWords(day.pending)}</span>}
        {!day.bookable && day.state !== 'closed' && <span className="muted">{day.day < data.today ? 'In the past' : 'Beyond the booking window'}</span>}
        <Link className="button sm" href={bookingsHref}>
          Open in Bookings <Icon name="chevron-right" size={14} />
        </Link>
      </div>

      {slots.length === 0 && <p className="small muted">No active rooms or slots to show.</p>}
      {/* By room: each room once, its slots as chips, then each booking once
          (a stay covering two slots is one guest, not two cards). */}
      <ul className="cal-day-rooms">
        {[...new Set(slots.map((s) => s.unitId))].map((unitId) => {
          const roomSlots = slots.filter((s) => s.unitId === unitId);
          const here = bookings.filter((b) => b.unitId === unitId);
          const once = [...new Map(here.map((b) => [b.booking.id, b.booking])).values()];
          return (
            <li key={unitId} className="cal-day-room">
              <div className="cal-day-room-head">
                <h3>{roomSlots[0]!.unit}</h3>
                <span className="cal-day-room-slots">
                  {roomSlots.map((s) => (
                    <span key={s.slotId} className={`slot-chip ${s.state}`}>
                      {s.slot}: {s.state}
                    </span>
                  ))}
                </span>
              </div>
              {once.length === 0 ? (
                <p className="small muted">No bookings.</p>
              ) : (
                <ul className="cal-day-bookings">
                  {once.map((b) => (
                    <BookingRow
                      key={b.id}
                      booking={b}
                      day={day.day}
                      slug={slug}
                    />
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
