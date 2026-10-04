'use client';

// S-11 · Dashboard (plan/dashboard.md, D-098). One page that says how the
// business is doing, from ONE JSON the database computed (tenant_dashboard):
// this screen draws and links; it never adds, divides or re-buckets a
// figure (plan Rule 1). A tenant without bookings sees the first three
// cards; a staff member sees everything but Revenue, which the function
// withholds (null) by role; every count that is a to-do links to the screen
// that does it. The charts are inline SVG (bar-chart.tsx), no library.

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import type { TenantDashboard } from '@rag/pipeline';
import { BrandHeader } from '@/components/brand-header';
import { LoginForm, describeFailure } from '@/components/admin-login';
import { TenantNav, fetchRole } from '@/components/tenant-nav';
import { BarChart, SplitBar } from '@/components/bar-chart';
import type { NavFeatures } from '@/lib/nav-items';
import { formatMoney } from '@/lib/money';
import { isRole, type Role } from '@/lib/permissions';

export interface DashboardScreenProps {
  slug: string;
  businessName: string;
  logoUrl: string | null;
  bannerUrl: string | null;
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

export function DashboardScreen({ slug, businessName, logoUrl, bannerUrl, nav, currency }: DashboardScreenProps) {
  const api = `/api/t/${slug}`;
  const [auth, setAuth] = useState<Auth>('checking');
  const [role, setRole] = useState<Role | null>(null);
  const [days, setDays] = useState<(typeof WINDOWS)[number]>(30);
  const [data, setData] = useState<TenantDashboard | null>(null);
  const [message, setMessage] = useState('Loading…');

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
      setMessage(await describeFailure(error as Error, response));
    }
  }, [api, days, unauthorized]);

  useEffect(() => {
    if (auth === 'in') void load();
  }, [auth, load]);

  const logout = useCallback(async () => {
    await fetch(`${api}/admin/session`, { method: 'DELETE' }).catch(() => undefined);
    unauthorized();
  }, [api, unauthorized]);

  const header = (
    <BrandHeader businessName={businessName} logoUrl={logoUrl} bannerUrl={bannerUrl} subtitle="Dashboard">
      <TenantNav slug={slug} features={nav} current="dashboard" session={{ auth, role, onLogout: logout }} />
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

  if (!data) {
    return (
      <>
        {header}
        <main>
          <div className="small">{message}</div>
        </main>
      </>
    );
  }

  const base = `/t/${slug}/admin`;
  const b = data.bookings;
  const money = (centavos: number) => formatMoney(centavos, currency);
  const windowLabel = `last ${data.days} days`;

  return (
    <>
      {header}
      <main className="dashboard">
        <div className="dashboard-toolbar">
          <span className="small muted">
            Today is {dayWithWeekday(data.today)} in {data.timezone}.
          </span>
          <span className="dashboard-windows" role="group" aria-label="Window">
            {WINDOWS.map((w) => (
              <button key={w} type="button" className={w === days ? 'primary' : ''} onClick={() => setDays(w)}>
                {w} days
              </button>
            ))}
          </span>
        </div>

        {b && (
          <section className="card dashboard-attention">
            <h2>Needs attention</h2>
            <div className="stat-row">
              <Link href={`${base}/bookings`} className="stat">
                <strong>{b.attention.pendingRequests}</strong>
                <span>request{b.attention.pendingRequests === 1 ? '' : 's'} waiting</span>
              </Link>
              <Link href={`${base}/bookings`} className="stat">
                <strong>{b.attention.pendingStaff}</strong>
                <span>staff booking{b.attention.pendingStaff === 1 ? '' : 's'} unconfirmed</span>
              </Link>
              <Link href={`${base}/bookings`} className={`stat${b.attention.clashing > 0 ? ' warn' : ''}`}>
                <strong>{b.attention.clashing}</strong>
                <span>would clash on Confirm (a night already confirmed, or wanted by another pending stay)</span>
              </Link>
              <Link href={`${base}/unanswered`} className={`stat${data.chat.openUnanswered > 0 ? ' warn' : ''}`}>
                <strong>{data.chat.openUnanswered}</strong>
                <span>unanswered question{data.chat.openUnanswered === 1 ? '' : 's'} open</span>
              </Link>
            </div>
          </section>
        )}

        {b && (
          <section className="card">
            <h2>Today</h2>
            <div className="stat-row">
              <div className="stat">
                <strong>{b.today.checkIns}</strong>
                <span>check-in{b.today.checkIns === 1 ? '' : 's'}</span>
              </div>
              <div className="stat">
                <strong>{b.today.checkOuts}</strong>
                <span>check-out{b.today.checkOuts === 1 ? '' : 's'}</span>
              </div>
            </div>
            {b.today.next7.length > 0 ? (
              <>
                <h3 className="small muted">Next 7 days, confirmed</h3>
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
              <p className="small muted">No confirmed check-ins in the next 7 days.</p>
            )}
          </section>
        )}

        <div className="dashboard-grid">
          <section className="card">
            <h2>Chat, {windowLabel}</h2>
            <div className="stat-row">
              <div className="stat">
                <strong>{data.chat.conversations}</strong>
                <span>conversations</span>
              </div>
              <div className="stat">
                <strong>{data.chat.visitorMessages}</strong>
                <span>visitor messages</span>
              </div>
              <div className="stat">
                <strong>{data.chat.refusals}</strong>
                <span>refusals ({data.chat.refusalRate} %)</span>
              </div>
            </div>
            <BarChart title={`Conversations per day, ${windowLabel}`} bars={data.chat.perDay.map((d) => ({ label: dayLabel(d.day), value: d.conversations }))} />
            {!b && (
              <p className="small">
                <Link href={`${base}/unanswered`}>
                  {data.chat.openUnanswered} unanswered question{data.chat.openUnanswered === 1 ? '' : 's'} open
                </Link>
              </p>
            )}
          </section>

          <section className="card">
            <h2>Knowledge base</h2>
            <div className="stat-row">
              <Link href={base} className="stat">
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
            <h3 className="small muted">Team</h3>
            <p className="small">
              {data.team.owners} owner{data.team.owners === 1 ? '' : 's'} · {data.team.admins} admin{data.team.admins === 1 ? '' : 's'} · {data.team.staff} staff
            </p>
          </section>
        </div>

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
            <SplitBar a={b.window.web} b={b.window.staff} labelA="From the booking page" labelB="By staff" />
            <BarChart
              title={`Confirmed stays per week, the last ${b.stays.weeks} weeks (by the night's date)`}
              bars={b.stays.perWeek.map((w) => ({ label: dayLabel(w.weekOf), value: w.stays }))}
            />
          </section>
        )}

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
            <BarChart title="Occupancy per week, next 30 days" unit="percent" bars={b.occupancy.perWeek.map((w) => ({ label: dayLabel(w.weekOf), value: w.percent }))} />
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
            <BarChart title={`Confirmed revenue per week, the last ${b.stays.weeks} weeks`} unit="pesos" currency={currency} bars={b.money.perWeek.map((w) => ({ label: dayLabel(w.weekOf), value: w.confirmed }))} />
            <p className="small muted">Every amount is the stored price of the nights in the window, net of discounts.</p>
          </section>
        )}
      </main>
    </>
  );
}
