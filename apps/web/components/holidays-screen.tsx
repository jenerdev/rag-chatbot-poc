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

import { useCallback, useEffect, useState } from 'react';
import type { CalendarDay } from '@rag/bookings';
import { LoginForm, describeFailure } from '@/components/admin-login';
import { fetchRole } from '@/components/tenant-nav';
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
type Notice = { message: string; kind: 'ok' | 'error' } | null;

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
  const [loadMessage, setLoadMessage] = useState('Loading…');
  const [notice, setNotice] = useState<Notice>(null);
  const [busy, setBusy] = useState(false);

  // The form. The surcharge is typed in pesos and sent as centavos.
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
  useEffect(() => {
    if (auth !== 'in') return;
    void (async () => {
      let response: Response | null = null;
      try {
        response = await fetch(`${api}/bookings/setup`);
        if (response.status === 401) return unauthorized();
        if (!response.ok) throw new Error('failed');
        const body = await response.json();
        setSetup({ today: body.today, currency: body.currency });
        setToYear(body.today.slice(0, 4));
      } catch (error) {
        setLoadMessage(await describeFailure(error as Error, response));
      }
    })();
  }, [api, auth, unauthorized]);

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
      setLoadMessage(await describeFailure(error as Error, response));
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
    if (!window.confirm(question)) return;
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
          <div className="small">{loadMessage}</div>
        </StaffFrame>
      </>
    );
  }

  return (
    <>
      <StaffFrame {...frame}>
        <div className={notice ? `notice ${notice.kind}` : 'notice hidden'}>{notice?.message}</div>

        <section className="card">
          <h2>Add a holiday or a closed date</h2>
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
              <button type="submit" className="primary" disabled={busy}>
                {busy ? 'Saving…' : 'Save'}
              </button>
            </div>
          </form>
        </section>

        <section className="card">
          <h2>The next twelve months</h2>
          {upcoming === null ? (
            <div className="small">{loadMessage}</div>
          ) : upcoming.length === 0 ? (
            <div className="small muted">No holidays or closed dates listed. Every date is open and priced as a weekday or a weekend.</div>
          ) : (
            upcoming.map((d) => (
              <div key={d.day} className="holiday">
                <span className="holiday-day">{dayLabel(d.day)}</span>
                <span className="holiday-label">
                  {d.label}
                  {d.kind === 'peak' && <span className="holiday-badge">peak</span>}
                  {d.kind === 'closed' && <span className="holiday-badge closed">closed</span>}
                </span>
                <span className="holiday-surcharge">{d.surcharge > 0 ? `+${formatMoney(d.surcharge, setup.currency)} a night` : ''}</span>
                <button
                  type="button"
                  className="link"
                  disabled={busy}
                  onClick={() => {
                    setDay(d.day);
                    setKind(d.kind);
                    setLabel(d.label);
                    setSurcharge(d.surcharge ? centavosToInput(d.surcharge) : '');
                    window.scrollTo({ top: 0 });
                  }}
                >
                  Edit
                </button>
                <button type="button" disabled={busy} onClick={() => remove(d)}>
                  {d.kind === 'closed' ? 'Reopen' : 'Remove'}
                </button>
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
              <label key={d.day} className="holiday">
                <input
                  type="checkbox"
                  checked={ticked.includes(d.day)}
                  onChange={(e) => setTicked((current) => (e.target.checked ? [...current, d.day] : current.filter((x) => x !== d.day)))}
                />
                <span className="holiday-day">{dayLabel(d.day)}</span>
                <span className="holiday-label">
                  {d.label}
                  {d.kind === 'closed' && <span className="holiday-badge closed">closed</span>}
                </span>
                <span className="holiday-surcharge">{d.surcharge > 0 ? `+${formatMoney(d.surcharge, setup.currency)}` : ''}</span>
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
