'use client';

// S-7 · Holidays (plan/customer-booking.md § 2.3). Staff keep the list of
// holiday and peak days that unit_price() reads: on a listed day every unit is
// priced at its holiday rate (or its weekend rate when it has none), plus the
// day's surcharge per night.
//
// A holiday is a DATE, not a rule, so every one is typed here: Holy Week moves
// every year, and special non-working days are declared by proclamation. Fixed
// dates (24, 25, 31 Dec, 1 Jan, a town fiesta) can be copied from last year;
// only staff know which ones are fixed, so they tick them.
//
// A change here never reprices a request or booking already made: each keeps
// the price it was stored with.
//
// A CLOSED date (D-080) is the same list, kind 'closed': nothing may be
// booked on it, by a customer or by staff, and it has no surcharge. Postgres
// refuses to close a date that has confirmed bookings (the message says how
// many), and refuses every booking on a closed date whatever this screen
// shows. Removing it reopens the date.
//
// The look (plan/ui-refresh.md Phase 9): "Add a date" and Edit open the form
// in a drawer; the next twelve months are grouped by month, each date's kind
// a badge; Remove and Reopen ask in the dialog.

import { useCallback, useEffect, useState } from 'react';
import type { CalendarDay } from '@rag/bookings';
import { LoginForm, describeFailure } from '@/components/admin-login';
import { fetchRole } from '@/components/tenant-nav';
import { Drawer, useConfirmDialog } from '@/components/dialogs';
import { useNotice } from '@/components/toast';
import { Icon } from '@/components/icons';
import { EmptyState, LOADING, LoadState, failed, type Load } from '@/components/load-state';
import { StaffFrame } from '@/components/staff-frame';
import type { NavFeatures } from '@/lib/nav-items';
import { isRole, type Role } from '@/lib/permissions';
import { centavosToInput, formatMoney, parseMoneyInput } from '@/lib/money';

export interface HolidaysScreenProps {
  slug: string;
  businessName: string;
  logoUrl: string | null;
  bannerUrl: string | null;
  /** What the tenant has, for the header's links (lib/nav.ts). */
  nav: NavFeatures;
}

type Auth = 'checking' | 'out' | 'in';

function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function dayLabel(date: string): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

export function HolidaysScreen({ slug, businessName, logoUrl, bannerUrl, nav }: HolidaysScreenProps) {
  const api = `/api/t/${slug}`;
  const [auth, setAuth] = useState<Auth>('checking');
  // What this member is, for the header's links only; the routes decide for themselves.
  const [role, setRole] = useState<Role | null>(null);
  const [setup, setSetup] = useState<{ today: string; currency: string } | null>(null);
  const [upcoming, setUpcoming] = useState<CalendarDay[] | null>(null);
  const [past, setPast] = useState<CalendarDay[]>([]);
  const [loadState, setLoadState] = useState<Load>(LOADING);
  const [busy, setBusy] = useState(false);

  // The form. The surcharge is typed in pesos and sent as centavos.
  const [formOpen, setFormOpen] = useState(false);
  const { notice, setNotice } = useNotice(formOpen);
  const { ask, dialog } = useConfirmDialog();
  const [day, setDay] = useState('');
  const [kind, setKind] = useState<CalendarDay['kind']>('holiday');
  const [label, setLabel] = useState('');
  const [surcharge, setSurcharge] = useState('');
  // Copying last year's fixed dates.
  const [ticked, setTicked] = useState<string[]>([]);
  const [toYear, setToYear] = useState('');

  const unauthorized = useCallback(() => {
    setAuth('out');
    setUpcoming(null);
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

  // The tenant's today and currency, from the bookings setup (staff only).
  // Named, not an anonymous effect, so a failed load's Retry runs it again
  // (plan/ui-components.md Phase 2, trap 4).
  const loadSetup = useCallback(async () => {
    let response: Response | null = null;
    try {
      response = await fetch(`${api}/bookings/setup`);
      if (response.status === 401) return unauthorized();
      if (!response.ok) throw new Error('failed');
      const body = await response.json();
      setSetup({ today: body.today, currency: body.currency });
      setToYear(body.today.slice(0, 4));
    } catch (error) {
      setLoadState(failed(await describeFailure(error as Error, response)));
    }
  }, [api, unauthorized]);

  useEffect(() => {
    if (auth === 'in') void loadSetup();
  }, [auth, loadSetup]);

  // Upcoming: today to a year out. Past: the year before today, to copy from.
  const load = useCallback(async () => {
    if (!setup) return;
    let response: Response | null = null;
    try {
      const [a, b] = await Promise.all([
        fetch(`${api}/holidays?from=${setup.today}&to=${addDays(setup.today, 366)}`),
        fetch(`${api}/holidays?from=${addDays(setup.today, -366)}&to=${addDays(setup.today, -1)}`),
      ]);
      if (a.status === 401 || b.status === 401) return unauthorized();
      response = a.ok ? b : a;
      if (!a.ok || !b.ok) throw new Error('failed');
      setUpcoming(await a.json());
      setPast(await b.json());
    } catch (error) {
      setUpcoming(null);
      setLoadState(failed(await describeFailure(error as Error, response)));
    }
  }, [api, setup, unauthorized]);

  useEffect(() => {
    void load();
  }, [load]);

  const logout = useCallback(async () => {
    await fetch(`${api}/admin/session`, { method: 'DELETE' }).catch(() => undefined);
    unauthorized();
  }, [api, unauthorized]);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setNotice(null);
    // A closed date has no surcharge; the field is disabled for it.
    const amount = kind === 'closed' || surcharge.trim() === '' ? 0 : parseMoneyInput(surcharge);
    if (amount === null) {
      setNotice({ message: 'The surcharge must be an amount such as 4000 or 4000.50.', kind: 'error' });
      return;
    }
    setBusy(true);
    let response: Response | null = null;
    try {
      response = await fetch(`${api}/holidays`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ day, kind, label, surcharge: amount }),
      });
      if (response.status === 401) return unauthorized();
      if (!response.ok) throw new Error('failed');
      const saved: CalendarDay = await response.json();
      setNotice({ message: `Saved ${dayLabel(saved.day)}: ${saved.label}.`, kind: 'ok' });
      setDay('');
      setLabel('');
      setSurcharge('');
      setKind('holiday');
      setFormOpen(false);
      void load();
    } catch (error) {
      setNotice({ message: await describeFailure(error as Error, response), kind: 'error' });
    } finally {
      setBusy(false);
    }
  }

  async function remove(entry: CalendarDay) {
    const question =
      entry.kind === 'closed'
        ? `Reopen ${dayLabel(entry.day)} (${entry.label})? Customers can book it again.`
        : `Remove ${entry.label} on ${dayLabel(entry.day)}? Bookings already made keep their price.`;
    const sure = await ask({
      title: entry.kind === 'closed' ? `Reopen ${dayLabel(entry.day)}?` : `Remove ${entry.label}?`,
      body: question,
      actionLabel: entry.kind === 'closed' ? 'Reopen' : 'Remove',
      backLabel: 'Keep it',
      danger: entry.kind !== 'closed',
    });
    if (sure === null) return;
    setNotice(null);
    setBusy(true);
    let response: Response | null = null;
    try {
      response = await fetch(`${api}/holidays/${entry.day}`, { method: 'DELETE' });
      if (response.status === 401) return unauthorized();
      if (!response.ok) throw new Error('failed');
      setNotice({ message: entry.kind === 'closed' ? `Reopened ${dayLabel(entry.day)}.` : `Removed ${dayLabel(entry.day)}.`, kind: 'ok' });
      void load();
    } catch (error) {
      setNotice({ message: await describeFailure(error as Error, response), kind: 'error' });
    } finally {
      setBusy(false);
    }
  }

  async function copy() {
    setNotice(null);
    setBusy(true);
    let response: Response | null = null;
    try {
      response = await fetch(`${api}/holidays/copy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ days: ticked, toYear: Number(toYear) }),
      });
      if (response.status === 401) return unauthorized();
      if (!response.ok) throw new Error('failed');
      const copied: CalendarDay[] = await response.json();
      setNotice({ message: `Copied ${copied.length} date${copied.length === 1 ? '' : 's'} to ${toYear}.`, kind: 'ok' });
      setTicked([]);
      void load();
    } catch (error) {
      setNotice({ message: await describeFailure(error as Error, response), kind: 'error' });
    } finally {
      setBusy(false);
    }
  }

  const frame = { slug, businessName, logoUrl, bannerUrl, features: nav, current: 'holidays' as const, title: 'Holidays', session: { auth, role, onLogout: logout } };

  if (auth !== 'in') {
    return (
      <>
        <StaffFrame {...frame}>
          {auth === 'checking' ? (
            <div className="small muted">Checking your session…</div>
          ) : (
            <LoginForm api={api} slug={slug} onLoggedIn={() => {
                setAuth('in');
                void fetchRole(api).then(setRole);
              }} />
          )}
        </StaffFrame>
      </>
    );
  }

  if (!setup) {
    return (
      <>
        <StaffFrame {...frame}>
          <LoadState load={loadState} what="setup" onRetry={() => { setLoadState(LOADING); void loadSetup(); }} />
        </StaffFrame>
      </>
    );
  }

  const addDate = (
    <button
      type="button"
      className="primary"
      onClick={() => {
        setNotice(null);
        setFormOpen(true);
      }}
    >
      <Icon name="plus" size={16} /> Add a date
    </button>
  );

  // The next twelve months, grouped by month for reading ("November 2026").
  const months: { month: string; days: CalendarDay[] }[] = [];
  for (const d of upcoming ?? []) {
    const month = new Date(`${d.day}T00:00:00Z`).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
    const last = months[months.length - 1];
    if (last && last.month === month) last.days.push(d);
    else months.push({ month, days: [d] });
  }
  const kindBadge = (k: CalendarDay['kind']) =>
    k === 'closed' ? <span className="badge danger">Closed</span> : k === 'peak' ? <span className="badge accent">Peak</span> : <span className="badge warn">Holiday</span>;

  return (
    <>
      <StaffFrame {...frame} actions={addDate}>
        {dialog}

        <Drawer open={formOpen} title="Add a holiday or a closed date" onClose={() => setFormOpen(false)}>
          <p className="small muted">
            On a holiday or peak date every room is priced at its holiday rate, or its weekend rate if it has none, plus the
            surcharge for each night. Bookings already made keep their price.
          </p>
          <p className="small muted">
            On a closed date nothing can be booked, by a customer or by staff, and the chat says you are closed. A date that
            already has confirmed bookings cannot be closed until they are cancelled or moved.
          </p>
          <form onSubmit={save}>
            <div className="field-row">
              <div className="field">
                <label htmlFor="day">Date</label>
                <input type="date" id="day" required value={day} onChange={(e) => setDay(e.target.value)} />
              </div>
              <div className="field">
                <label htmlFor="kind">Kind</label>
                <select
                  id="kind"
                  value={kind}
                  onChange={(e) => {
                    const next = e.target.value as CalendarDay['kind'];
                    setKind(next);
                    if (next === 'closed') setSurcharge('');
                  }}
                >
                  <option value="holiday">Holiday</option>
                  <option value="peak">Peak</option>
                  <option value="closed">Closed</option>
                </select>
              </div>
              <div className="field grow">
                <label htmlFor="label">Name</label>
                <input
                  type="text"
                  id="label"
                  required
                  maxLength={100}
                  placeholder={kind === 'closed' ? 'Maintenance' : 'Christmas Eve'}
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                />
              </div>
              <div className="field">
                <label htmlFor="surcharge">
                  Surcharge per night <span className="muted">(optional)</span>
                </label>
                <input
                  type="text"
                  id="surcharge"
                  inputMode="decimal"
                  placeholder="0"
                  disabled={kind === 'closed'}
                  value={surcharge}
                  onChange={(e) => setSurcharge(e.target.value)}
                />
              </div>
            </div>
            <div className="form-footer">
              <span className="small muted">Saving a date that is already listed changes it.</span>
              <span className="form-actions">
                <button type="button" disabled={busy} onClick={() => setFormOpen(false)}>
                  Cancel
                </button>
                <button type="submit" className="primary" aria-busy={busy || undefined} disabled={busy}>
                  {busy ? 'Saving…' : 'Save'}
                </button>
              </span>
            </div>
            {notice?.kind === 'error' && formOpen && (
              <div className="notice error drawer-notice" role="alert">
                {notice.message}
              </div>
            )}
          </form>
        </Drawer>

        <section className="card">
          <h2>The next twelve months</h2>
          {upcoming === null ? (
            <LoadState load={loadState} what="dates" rows={5} onRetry={() => { setLoadState(LOADING); void load(); }} />
          ) : upcoming.length === 0 ? (
            <EmptyState icon="flag" title="No holidays or closed dates" action={addDate}>
              Every date is open and priced as a weekday or a weekend.
            </EmptyState>
          ) : (
            months.map(({ month, days }) => (
              <div key={month} className="month-group">
                <h3 className="month-label">{month}</h3>
                {days.map((d) => (
                  <div key={d.day} className="list-row">
                    <span className="list-row-lead">{dayLabel(d.day)}</span>
                    <span className="list-row-main">
                      <span className="list-row-title">{d.label}</span>
                      {kindBadge(d.kind)}
                    </span>
                    <span className="list-row-meta">{d.surcharge > 0 ? `+${formatMoney(d.surcharge, setup.currency)} a night` : ''}</span>
                    <span className="list-row-actions">
                      <button
                        type="button"
                        className="ghost sm"
                        aria-label={`Edit ${d.label}`}
                        title="Edit"
                        disabled={busy}
                        onClick={() => {
                          setDay(d.day);
                          setKind(d.kind);
                          setLabel(d.label);
                          setSurcharge(d.surcharge ? centavosToInput(d.surcharge) : '');
                          setNotice(null);
                          setFormOpen(true);
                        }}
                      >
                        <Icon name="edit" size={16} />
                      </button>
                      <button type="button" className={d.kind === 'closed' ? 'sm' : 'ghost sm danger'} disabled={busy} onClick={() => remove(d)}>
                        {d.kind === 'closed' ? 'Reopen' : 'Remove'}
                      </button>
                    </span>
                  </div>
                ))}
              </div>
            ))
          )}
        </section>

        {past.length > 0 && (
          <section className="card">
            <h2>Copy from last year</h2>
            <p className="small muted">
              Tick the dates that fall on the same day every year. Holy Week moves, so enter it by hand.
            </p>
            {past.map((d) => (
              <label key={d.day} className="list-row pick-row">
                <input
                  type="checkbox"
                  checked={ticked.includes(d.day)}
                  onChange={(e) => setTicked((current) => (e.target.checked ? [...current, d.day] : current.filter((x) => x !== d.day)))}
                />
                <span className="list-row-lead">{dayLabel(d.day)}</span>
                <span className="list-row-main">
                  <span className="list-row-title">{d.label}</span>
                  {kindBadge(d.kind)}
                </span>
                <span className="list-row-meta">{d.surcharge > 0 ? `+${formatMoney(d.surcharge, setup.currency)}` : ''}</span>
              </label>
            ))}
            <div className="form-footer">
              <div className="field narrow">
                <label htmlFor="to-year">To year</label>
                <input type="number" id="to-year" min={2000} max={2100} value={toYear} onChange={(e) => setToYear(e.target.value)} />
              </div>
              <button type="button" className="primary" disabled={busy || ticked.length === 0} onClick={copy}>
                Copy {ticked.length || ''} date{ticked.length === 1 ? '' : 's'}
              </button>
            </div>
          </section>
        )}
      </StaffFrame>
    </>
  );
}
