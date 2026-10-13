'use client';

// S-11 · Dashboard (plan/dashboard.md, D-098). One page that says how the
// business is doing, from ONE JSON the database computed (tenant_dashboard):
// this screen draws and links; it never adds, divides or re-buckets a
// figure (plan Rule 1). A tenant without bookings sees the first three
// cards; a staff member sees everything but Revenue, which the function
// withholds (null) by role; every count that is a to-do links to the screen
// that does it. The charts are inline SVG (bar-chart.tsx), no library.
//
// The look (plan/ui-refresh.md Phase 6, regrouped 2026-10-12): the to-dos
// first, as ONE "Needs attention" card that lists only what is waiting, each
// a link to the screen that does it, or says "All clear"; a count is never
// shown as a zero tile beside the one that matters. A chart with nothing in
// it is a sentence, not an empty plot. The window is a segmented control.

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import type { TenantDashboard } from '@rag/pipeline';
import { LoginForm, describeFailure } from '@/components/admin-login';
import { fetchRole } from '@/components/tenant-nav';
import { StaffFrame } from '@/components/staff-frame';
import { BarChart, SplitBar } from '@/components/bar-chart';
import { Icon } from '@/components/icons';
import { LOADING, LoadState, failed, type Load } from '@/components/load-state';
import type { NavFeatures } from '@/lib/nav-items';
import { formatMoney } from '@/lib/money';
import { isRole, type Role } from '@/lib/permissions';

export interface DashboardScreenProps {
  slug: string;
  businessName: string;
  logoUrl: string | null;
  nav: NavFeatures;
  currency: string;
}

type Auth = 'checking' | 'out' | 'in';
const WINDOWS = [7, 30, 90] as const;

/** "2026-10-05" → "5 Oct". A calendar date, so formatted as UTC. */
function dayLabel(date: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return date;
  return new Date(`${date}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
}

/** "2026-10-05" → "Mon 5 Oct". */
function dayWithWeekday(date: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return date;
  return new Date(`${date}T00:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
}

/** One to-do waiting: its count, what it is, and a link to the screen that does it. */
interface Todo {
  href: string;
  count: number;
  /** singular and plural, e.g. ['booking request waits', 'booking requests wait'] */
  words: [string, string];
  hint: string;
  urgent?: boolean;
}

function TodoRow({ todo }: { todo: Todo }) {
  return (
    <Link href={todo.href} className={`todo-row${todo.urgent ? ' urgent' : ''}`}>
      <strong className="todo-count">{todo.count}</strong>
      <span className="todo-text">
        <span className="todo-what">{todo.count === 1 ? todo.words[0] : todo.words[1]}</span>
        <span className="small muted">{todo.hint}</span>
      </span>
      <Icon name="chevron-right" size={16} />
    </Link>
  );
}

/** A chart with nothing to draw is a sentence instead (an empty plot reads as broken). */
function ChartOr({ bars, empty, children }: { bars: { value: number }[]; empty: string; children: React.ReactNode }) {
  return bars.some((b) => b.value > 0) ? <>{children}</> : <p className="small muted chart-empty">{empty}</p>;
}

export function DashboardScreen({ slug, businessName, logoUrl, nav, currency }: DashboardScreenProps) {
  const api = `/api/t/${slug}`;
  const [auth, setAuth] = useState<Auth>('checking');
  const [role, setRole] = useState<Role | null>(null);
  const [days, setDays] = useState<(typeof WINDOWS)[number]>(30);
  const [data, setData] = useState<TenantDashboard | null>(null);
  const [loadState, setLoadState] = useState<Load>(LOADING);

  const unauthorized = useCallback(() => {
    setAuth('out');
    setData(null);
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

  const load = useCallback(async () => {
    let response: Response | null = null;
    try {
      response = await fetch(`${api}/dashboard?days=${days}`);
      if (response.status === 401) return unauthorized();
      if (!response.ok) throw new Error('failed');
      setData(await response.json());
    } catch (error) {
      setData(null);
      setLoadState(failed(await describeFailure(error as Error, response)));
    }
  }, [api, days, unauthorized]);

  useEffect(() => {
    if (auth === 'in') void load();
  }, [auth, load]);

  const logout = useCallback(async () => {
    await fetch(`${api}/admin/session`, { method: 'DELETE' }).catch(() => undefined);
    unauthorized();
  }, [api, unauthorized]);

  const frame = { slug, businessName, logoUrl, features: nav, current: 'dashboard' as const, title: 'Dashboard', session: { auth, role, onLogout: logout } };

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

  if (!data) {
    return (
      <>
        <StaffFrame {...frame}>
          <LoadState load={loadState} what="dashboard" rows={4} onRetry={() => { setLoadState(LOADING); void load(); }} />
        </StaffFrame>
      </>
    );
  }

  const base = `/t/${slug}/admin`;
  const b = data.bookings;
  const money = (centavos: number) => formatMoney(centavos, currency);
  const windowLabel = `last ${data.days} days`;
  // Only what waits, the urgent first: money and guests before housekeeping.
  const todos: Todo[] = [
    ...(b
      ? [
          { href: `${base}/payments`, count: b.attention.proofsToVerify, words: ['proof of payment to verify', 'proofs of payment to verify'], hint: 'Check the account, then verify or reject.', urgent: true },
          { href: `${base}/payments`, count: b.attention.changeRequests, words: ['guest asks to cancel or move', 'guests ask to cancel or move'], hint: 'Approve or reject on the booking.', urgent: true },
          { href: `${base}/bookings`, count: b.attention.clashing, words: ['pending stay would clash', 'pending stays would clash'], hint: 'A night is already taken. Decline it, or free the night.', urgent: true },
          { href: `${base}/bookings`, count: b.attention.pendingRequests, words: ['booking request waits', 'booking requests wait'], hint: 'From the booking page: confirm or decline.' },
          { href: `${base}/bookings`, count: b.attention.pendingStaff, words: ['staff booking is unconfirmed', 'staff bookings are unconfirmed'], hint: 'Made here, not confirmed yet.' },
        ]
      : []),
    { href: `${base}/unanswered`, count: data.chat.openUnanswered, words: ['question the assistant could not answer', 'questions the assistant could not answer'], hint: 'Add the answers to the knowledge base.' },
  ].filter((t) => t.count > 0) as Todo[];

  return (
    <>
      <StaffFrame {...frame} mainClassName="dashboard">
        <div className="dashboard-toolbar">
          <span className="small muted">
            Today is {dayWithWeekday(data.today)} in {data.timezone}.
          </span>
          <div className="segmented" role="group" aria-label="Window">
            {WINDOWS.map((w) => (
              <button key={w} type="button" aria-pressed={w === days} onClick={() => setDays(w)}>
                {w} days
              </button>
            ))}
          </div>
        </div>

        {/* The to-dos: only what waits, each a link; "All clear" when nothing does. */}
        <section className="card attention" aria-labelledby="attention-title">
          <h2 id="attention-title">Needs attention</h2>
          {todos.length === 0 ? (
            <p className="all-clear">
              <Icon name="check" size={16} /> All clear: nothing is waiting for you.
            </p>
          ) : (
            <div className="todo-list">
              {todos.map((t) => (
                <TodoRow key={t.words[1]} todo={t} />
              ))}
            </div>
          )}
        </section>

        {b && (
          <section className="card today">
            <div className="today-head">
              <h2>Today</h2>
              <span className="today-counts">
                <span>
                  <strong>{b.today.checkIns}</strong> check-in{b.today.checkIns === 1 ? '' : 's'}
                </span>
                <span>
                  <strong>{b.today.checkOuts}</strong> check-out{b.today.checkOuts === 1 ? '' : 's'}
                </span>
              </span>
            </div>
            {b.today.next7.length > 0 ? (
              <>
                <h3 className="small muted">Arriving in the next 7 days, confirmed</h3>
                <ul className="dashboard-list">
                  {b.today.next7.map((n, i) => (
                    <li key={i}>
                      <span className="dashboard-date">{dayWithWeekday(n.date)}</span>
                      <span>
                        {n.unit} · {n.slot}
                      </span>
                      <span className="muted">{n.guest}</span>
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <p className="small muted">No confirmed arrivals in the next 7 days.</p>
            )}
          </section>
        )}

        <div className="dashboard-grid">
          <section className="card">
            <h2>Chat, {windowLabel}</h2>
            <div className="stat-row">
              <Link href={`${base}/conversations${data.days === 30 ? '' : `?days=${data.days}`}`} className="stat">
                <strong>{data.chat.conversations}</strong>
                <span>conversations</span>
              </Link>
              <div className="stat">
                <strong>{data.chat.visitorMessages}</strong>
                <span>visitor messages</span>
              </div>
              <div className="stat">
                <strong>{data.chat.refusals}</strong>
                <span>refusals ({data.chat.refusalRate} %)</span>
              </div>
            </div>
            <ChartOr bars={data.chat.perDay.map((d) => ({ value: d.conversations }))} empty={`No conversations in the ${windowLabel}.`}>
              <BarChart title={`Conversations per day, ${windowLabel}`} bars={data.chat.perDay.map((d) => ({ label: dayLabel(d.day), value: d.conversations }))} />
            </ChartOr>
          </section>

          <section className="card">
            <h2>Knowledge base</h2>
            <div className="stat-row">
              <Link href={`${base}/documents`} className="stat">
                <strong>{data.knowledge.documents}</strong>
                <span>document{data.knowledge.documents === 1 ? '' : 's'}</span>
              </Link>
              <div className="stat">
                <strong>{data.knowledge.chunks}</strong>
                <span>chunks</span>
              </div>
            </div>
            <p className="small muted">
              {data.knowledge.newest ? `Newest: "${data.knowledge.newest.title}", ${dayLabel(data.knowledge.newest.createdAt.slice(0, 10))}.` : 'No documents yet.'}
            </p>
            {data.chat.openUnanswered > 0 && (
              <p className="small">
                <Link href={`${base}/unanswered`}>
                  {data.chat.openUnanswered} question{data.chat.openUnanswered === 1 ? '' : 's'} the documents could not answer
                </Link>
              </p>
            )}
            <h3 className="small muted">Team</h3>
            <p className="small">
              {data.team.owners} owner{data.team.owners === 1 ? '' : 's'} · {data.team.admins} admin{data.team.admins === 1 ? '' : 's'} · {data.team.staff} staff
            </p>
          </section>
        </div>

        {/* Bookings and money side by side on a desktop: the same window, read together. */}
        <div className={b?.money ? 'dashboard-grid' : undefined}>
        {b && (
          <section className="card">
            <h2>Bookings, {windowLabel}</h2>
            <div className="stat-row">
              <div className="stat">
                <strong>{b.window.confirmed}</strong>
                <span>confirmed</span>
              </div>
              <div className="stat">
                <strong>{b.window.pending}</strong>
                <span>pending</span>
              </div>
              <div className="stat">
                <strong>{b.window.cancelled}</strong>
                <span>cancelled</span>
              </div>
            </div>
            {b.window.web + b.window.staff > 0 && <SplitBar a={b.window.web} b={b.window.staff} labelA="From the booking page" labelB="By staff" />}
            <ChartOr bars={b.stays.perWeek.map((w) => ({ value: w.stays }))} empty={`No confirmed nights in the last ${b.stays.weeks} weeks.`}>
              <BarChart
                title={`Confirmed stays per week, the last ${b.stays.weeks} weeks (by the night's date)`}
                bars={b.stays.perWeek.map((w) => ({ label: dayLabel(w.weekOf), value: w.stays }))}
              />
            </ChartOr>
          </section>
        )}

        {b?.money && (
          <section className="card">
            <h2>Revenue, {windowLabel}</h2>
            <div className="stat-row">
              <div className="stat">
                <strong>{money(b.money.confirmed)}</strong>
                <span>confirmed</span>
              </div>
              <div className="stat">
                <strong>{money(b.money.pending)}</strong>
                <span>pending, awaiting a decision</span>
              </div>
              <div className="stat">
                <strong>{money(b.money.discounts)}</strong>
                <span>discounts given</span>
              </div>
            </div>
            <ChartOr bars={b.money.perWeek.map((w) => ({ value: w.confirmed }))} empty={`No confirmed revenue in the last ${b.stays.weeks} weeks.`}>
              <BarChart title={`Confirmed revenue per week, the last ${b.stays.weeks} weeks`} unit="pesos" currency={currency} bars={b.money.perWeek.map((w) => ({ label: dayLabel(w.weekOf), value: w.confirmed }))} />
            </ChartOr>
            <p className="small muted">Every amount is the stored price of the nights in the window, net of discounts.</p>
          </section>
        )}
        </div>

        {b?.occupancy && (
          <section className="card">
            <h2>Occupancy, next 30 days</h2>
            <div className="stat-row">
              <div className="stat">
                <strong>{b.occupancy.percent} %</strong>
                <span>
                  {b.occupancy.roomNights} of {b.occupancy.activeUnits * 30} room-nights, {b.occupancy.activeUnits} active room{b.occupancy.activeUnits === 1 ? '' : 's'}
                </span>
              </div>
            </div>
            <ChartOr bars={b.occupancy.perWeek.map((w) => ({ value: w.percent }))} empty="Nothing booked in the next 30 days yet.">
              <BarChart title="Occupancy per week, next 30 days" unit="percent" bars={b.occupancy.perWeek.map((w) => ({ label: dayLabel(w.weekOf), value: w.percent }))} />
            </ChartOr>
          </section>
        )}

        {b && b.promos.length > 0 && (
          <section className="card">
            <h2>Promos</h2>
            <ul className="dashboard-list">
              {b.promos.map((p) => (
                <li key={p.id}>
                  <span>{p.name}</span>
                  <span>
                    {p.uses} use{p.uses === 1 ? '' : 's'}
                    {p.maxUses !== null ? ` of ${p.maxUses}` : ''}
                  </span>
                  <span className="muted">{p.discount > 0 ? `${money(p.discount)} off, ${windowLabel}` : 'no discount given yet'}</span>
                </li>
              ))}
            </ul>
            <p className="small">
              <Link href={`${base}/promos`}>Manage promos</Link>
            </p>
          </section>
        )}

      </StaffFrame>
    </>
  );
}
