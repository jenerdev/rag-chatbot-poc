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
        <div className="range-head cal-head">
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
          <div className="range-nav">
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
            {/* One group, so the three always share a row (a phone included). */}
            <div className="cal-steps">
              <button type="button" disabled={!shown} onClick={() => date && go({ date: step(view, date, -1) })}>
                <Icon name="chevron-left" size={16} /> Previous {UNIT[view]}
              </button>
              <button type="button" disabled={!shown || shown.date === shown.today} onClick={() => shown && go({ date: shown.today })}>
                Today
              </button>
              <button type="button" disabled={!shown} onClick={() => date && go({ date: step(view, date, 1) })}>
                Next {UNIT[view]} <Icon name="chevron-right" size={16} />
              </button>
            </div>
          </div>
        </div>

        <CalendarLegend />

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
      </section>
    </StaffFrame>
  );
}

/** One room's slots on one date, as the Bookings screen's chips (reused, not redrawn). */
function SlotChips({ slots }: { slots: OccupancySlot[] }) {
  return (
    <span className="day-slots">
      {slots.map((s) => (
        <span key={s.slotId} className={`slot-chip ${s.state}`}>
          {s.slot}: {s.state}
          {s.pending > 0 && <span className="visually-hidden">, {pendingWords(s.pending)}</span>}
          {s.pending > 0 && (
            <span className="cal-pending sm" aria-hidden="true">
              {s.pending}
            </span>
          )}
        </span>
      ))}
    </span>
  );
}

/** The week: a column per date, a row per room, each cell its slots. Scrolls sideways inside itself on a phone, never the page. */
function WeekView({ data, perRoom, onPick }: { data: CalendarData; perRoom: boolean; onPick: (date: string) => void }) {
  const slots = data.slots ?? [];
  const rooms = [...new Map(slots.map((s) => [s.unitId, s.unit])).entries()];
  return (
    <div className="cal-week-scroll">
      <table className="cal-week">
        <caption className="visually-hidden">{periodTitle('week', data.date, data.from, data.to)}</caption>
        <thead>
          <tr>
            <th scope="col">{perRoom ? 'Room' : <span className="visually-hidden">Unit</span>}</th>
            {data.days.map((day) => (
              <th key={day.day} scope="col">
                <button
                  type="button"
                  className={dayClasses(day, data.today, 'cal-week-day')}
                  aria-label={sentence(day, data.today)}
                  onClick={() => onPick(day.day)}
                >
                  <span aria-hidden="true">{short(day.day, { weekday: 'short', day: 'numeric' })}</span>
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
        <tbody>
          {rooms.map(([unitId, name]) => (
            <tr key={unitId}>
              <th scope="row">{name}</th>
              {data.days.map((day) => (
                <td key={day.day} className={day.state === 'closed' ? 'closed' : undefined}>
                  <SlotChips slots={slots.filter((s) => s.day === day.day && s.unitId === unitId)} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {rooms.length === 0 && <p className="small muted">No active rooms or slots to show.</p>}
    </div>
  );
}

/** "Thu 26 Nov" — a booking's own date, when the stay began before the day shown. */
const since = (date: string) => short(date, { weekday: 'short', day: 'numeric', month: 'short' });

/** One booking at the front desk: who, how to reach them, how many, and its reference. No price (plan § 6). */
function BookingCard({ booking: b, day, slot }: { booking: DayBooking; day: string; slot: string }) {
  const earlier = b.date !== day || b.slot !== slot;
  return (
    <li className="cal-booking">
      <div className="cal-booking-head">
        <strong>{b.guestName}</strong>
        <span className={`badge ${b.status === 'confirmed' ? 'ok' : 'accent'}`}>{b.status}</span>
        {b.reference && <CopyText text={b.reference} what="reference" className="muted small request-ref" />}
        {b.clash && (
          <span className="badge danger">
            <Icon name="alert" size={14} /> would clash on Confirm
          </span>
        )}
      </div>
      <dl className="cal-booking-facts">
        {earlier && (
          <>
            <dt>Stay</dt>
            <dd>
              Since {since(b.date)} · {b.slot}
            </dd>
          </>
        )}
        {b.guestCount !== null && (
          <>
            <dt>Guests</dt>
            <dd>{b.guestCount}</dd>
          </>
        )}
        {b.guestPhone && (
          <>
            <dt>Phone</dt>
            <dd>
              <CopyText text={b.guestPhone} what="mobile number">
                <a href={`tel:${b.guestPhone}`}>{b.guestPhone}</a>
              </CopyText>
            </dd>
          </>
        )}
        {b.guestEmail && (
          <>
            <dt>Email</dt>
            <dd>
              <CopyText text={b.guestEmail} what="email">
                <a href={`mailto:${b.guestEmail}`}>{b.guestEmail}</a>
              </CopyText>
            </dd>
          </>
        )}
        <dt>From</dt>
        <dd>{b.source === 'web' ? 'The booking page' : 'Staff'}</dd>
        {b.notes && (
          <>
            <dt>Notes</dt>
            <dd className="cal-booking-notes">{b.notes}</dd>
          </>
        )}
      </dl>
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
      <ul className="cal-day-slots">
        {slots.map((s) => {
          const here = bookings.filter((b) => b.unitId === s.unitId && b.slotId === s.slotId).map((b) => b.booking);
          return (
            <li key={`${s.unitId}/${s.slotId}`}>
              <div className="cal-day-slot-head">
                <span className="cal-day-slot-name">
                  {s.unit} · {s.slot}
                </span>
                <span className={`slot-chip ${s.state}`}>{s.state}</span>
                {s.pending > 0 && <span className="badge accent">{pendingWords(s.pending)}</span>}
              </div>
              {here.length > 0 && (
                <ul className="cal-day-bookings">
                  {here.map((b) => (
                    <BookingCard key={b.id} booking={b} day={day.day} slot={s.slot} />
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
