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
// The look (plan/ui-refresh.md Phase 9, refined 2026-10-12): "Add a date"
// and Edit open the form in a drawer where the kind is a choice of three
// cards (Holiday, Peak, Closed), each saying what it does, the surcharge
// shows only where it applies, a sentence reads back what will happen on
// the date, and the footer says what is missing; the next twelve months are
// grouped by month, each date's kind a badge; Remove and Reopen ask.

import { useCallback, useEffect, useState } from 'react';
import type { CalendarDay } from '@rag/bookings';
import { LoginForm, describeFailure } from '@/components/admin-login';
import { fetchRole } from '@/components/tenant-nav';
import { Drawer, useConfirmDialog } from '@/components/dialogs';
import { useNotice } from '@/components/toast';
import { Icon } from '@/components/icons';
import { Tip } from '@/components/tooltip';
import { Bone, EmptyState, LOADING, LoadState, failed, type Load } from '@/components/load-state';
import { StaffFrame } from '@/components/staff-frame';
import type { NavFeatures } from '@/lib/nav-items';
import { isRole, type Role } from '@/lib/permissions';
import { centavosToInput, formatMoney, parseMoneyInput } from '@/lib/money';

export interface HolidaysScreenProps {
  slug: string;
  businessName: string;
  logoUrl: string | null;
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

/**
 * The dates while they load: one month group of `.list-row.setup-row` rows,
 * the real list's classes, with the date and weekday, the name and its kind
 * badge, the surcharge, and the Edit and Remove buttons as shapes. Rows are
 * mapped directly, not through boneRows(): its wrapper would make every row
 * `:first-of-type` and take away the lines between them.
 */
function DatesSkeleton() {
  const names = ['38%', '52%', '30%', '46%', '42%'];
  return (
    <div className="month-group">
      {/* An h3 as in the list, so the first row is the first div and draws no top line. */}
      <h3 className="month-label">
        <Bone w="12ch" h="small" />
      </h3>
      {names.map((w, i) => (
        <div key={i} className="list-row setup-row">
          <span className="setup-row-when">
            <Bone w="6ch" />
            <Bone w="9ch" h="small" />
          </span>
          <span className="list-row-main">
            <Bone w={w} />
            <Bone w="8ch" h="chip" />
          </span>
          <span className="list-row-meta">{i % 2 === 0 && <Bone w="13ch" h="small" />}</span>
          <span className="list-row-actions">
            <Bone w="32px" h="var(--control-h-sm)" />
            <Bone w="68px" h="var(--control-h-sm)" />
          </span>
        </div>
      ))}
    </div>
  );
}

export function HolidaysScreen({ slug, businessName, logoUrl, nav }: HolidaysScreenProps) {
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

  const frame = { slug, businessName, logoUrl, features: nav, current: 'holidays' as const, title: 'Holidays', session: { auth, role, onLogout: logout } };

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
          <LoadState
            load={loadState}
            what="setup"
            onRetry={() => { setLoadState(LOADING); void loadSetup(); }}
            skeleton={
              // The page's one card, so the frame does not change shape when the setup arrives.
              <section className="card">
                <h2>
                  <Bone w="14em" />
                </h2>
                <p className="small muted">
                  <Bone w="70%" h="small" />
                </p>
                <DatesSkeleton />
              </section>
            }
          />
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
        setDay('');
        setLabel('');
        setSurcharge('');
        setKind('holiday');
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
  // What the form will save, read back; what it still needs; whether it replaces a listed date.
  const listed = (upcoming ?? []).find((d) => d.day === day) ?? null;
  const formMissing = day === '' ? 'Choose the date' : label.trim() === '' ? 'Give it a name' : null;
  const amountText = kind !== 'closed' && surcharge.trim() !== '' && parseMoneyInput(surcharge) ? formatMoney(parseMoneyInput(surcharge)!, setup.currency) : null;
  const summary =
    day === ''
      ? null
      : kind === 'closed'
        ? `${dayLabel(day)}${label.trim() ? `, ${label.trim()}` : ''}: nothing can be booked, and the chat says you are closed.`
        : `${dayLabel(day)}${label.trim() ? `, ${label.trim()}` : ''}: every room is priced at its holiday rate (or its weekend rate)${amountText ? `, plus ${amountText} a night` : ''}.`;
  const KINDS: { key: CalendarDay['kind']; title: string; text: string }[] = [
    { key: 'holiday', title: 'Holiday', text: 'A public or local holiday, priced at the holiday rate.' },
    { key: 'peak', title: 'Peak', text: 'A busy date that is not a holiday, priced the same way.' },
    { key: 'closed', title: 'Closed', text: 'Nothing can be booked, by guests or staff.' },
  ];

  const kindBadge = (k: CalendarDay['kind']) =>
    k === 'closed' ? <span className="badge danger">Closed</span> : k === 'peak' ? <span className="badge accent">Peak</span> : <span className="badge warn">Holiday</span>;

  return (
    <>
      <StaffFrame {...frame} actions={addDate}>
        {dialog}

        <Drawer open={formOpen} title={listed ? `Edit ${dayLabel(listed.day)}` : 'Add a date'} onClose={() => setFormOpen(false)}>
          <form onSubmit={save} className="setup-form">
            <p className="small muted setup-intro">A date priced differently from a normal weekday or weekend, or closed. Bookings already made keep their price.</p>
            <div className="field-row">
              <div className="field">
                <label htmlFor="day">Date</label>
                <input type="date" id="day" required min={setup.today} value={day} onChange={(e) => setDay(e.target.value)} />
              </div>
              <div className="field grow">
                <label htmlFor="label">Name</label>
                <input
                  type="text"
                  id="label"
                  required
                  maxLength={100}
                  autoComplete="off"
                  placeholder={kind === 'closed' ? 'Maintenance' : 'Christmas Eve'}
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                />
              </div>
            </div>
            {listed && <p className="hint">This date is already listed as {listed.label}; saving changes it.</p>}

            <fieldset className="setup-choice-set">
              <legend className="field-label">What happens on this date</legend>
              <div className="setup-choices cols-3">
              {KINDS.map((k) => (
                <label key={k.key} className={`review-option${k.key === 'closed' ? ' danger' : ''}${kind === k.key ? ' picked' : ''}`}>
                  <input
                    type="radio"
                    name="kind"
                    checked={kind === k.key}
                    onChange={() => {
                      setKind(k.key);
                      if (k.key === 'closed') setSurcharge('');
                    }}
                  />
                  <span>
                    <strong>{k.title}</strong>
                    <span className="small muted">{k.text}</span>
                  </span>
                </label>
              ))}
              </div>
            </fieldset>
            {kind === 'closed' && (
              <p className="hint">A date with confirmed bookings cannot be closed until they are cancelled or moved.</p>
            )}

            {/* Only where it applies: a closed date has no price. */}
            {kind !== 'closed' && (
              <div className="field">
                <label htmlFor="surcharge">
                  Surcharge per night <span className="muted">(optional)</span>
                </label>
                <div className="input-prefix">
                  <span aria-hidden="true">{setup.currency === 'PHP' ? '₱' : setup.currency}</span>
                  <input type="text" id="surcharge" inputMode="decimal" placeholder="0" value={surcharge} onChange={(e) => setSurcharge(e.target.value)} />
                </div>
                <p className="hint">Added to every night on this date, for every room.</p>
              </div>
            )}

            {summary && (
              <p className="setup-summary" aria-live="polite">
                <Icon name={kind === 'closed' ? 'alert' : 'flag'} size={14} />
                {summary}
              </p>
            )}

            {notice?.kind === 'error' && formOpen && (
              <div className="notice error drawer-notice" role="alert">
                {notice.message}
              </div>
            )}
            <div className="drawer-footer">
              <div className="drawer-footer-total">
                <span className="small muted">{formMissing ?? (listed ? 'Saving replaces the listed date.' : 'Ready to save.')}</span>
              </div>
              <button type="button" disabled={busy} onClick={() => setFormOpen(false)}>
                Cancel
              </button>
              <button type="submit" className="primary" aria-busy={busy || undefined} disabled={busy || formMissing !== null}>
                {busy ? 'Saving…' : listed ? 'Save changes' : 'Add date'}
              </button>
            </div>
          </form>
        </Drawer>

        <section className="card">
          <h2>The next twelve months</h2>
          <p className="small muted">Holidays and peak dates use each room's holiday rate; closed dates take no booking.</p>
          {upcoming === null ? (
            <LoadState load={loadState} what="dates" onRetry={() => { setLoadState(LOADING); void load(); }} skeleton={<DatesSkeleton />} />
          ) : upcoming.length === 0 ? (
            <EmptyState icon="flag" title="No holidays or closed dates" action={addDate}>
              Every date is open and priced as a weekday or a weekend.
            </EmptyState>
          ) : (
            months.map(({ month, days }) => (
              <div key={month} className="month-group">
                <h3 className="month-label">{month}</h3>
                {days.map((d) => (
                  <div key={d.day} className="list-row setup-row">
                    <span className="setup-row-when">
                      <strong>{new Date(`${d.day}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' })}</strong>
                      <span className="small muted">{new Date(`${d.day}T00:00:00Z`).toLocaleDateString('en-GB', { weekday: 'long', timeZone: 'UTC' })}</span>
                    </span>
                    <span className="list-row-main">
                      <span className="list-row-title">{d.label}</span>
                      {kindBadge(d.kind)}
                    </span>
                    <span className="list-row-meta">{d.surcharge > 0 ? `+${formatMoney(d.surcharge, setup.currency)} a night` : ''}</span>
                    <span className="list-row-actions">
                      <Tip label="Edit">
                        <button
                          type="button"
                          className="ghost sm"
                          aria-label={`Edit ${d.label}`}
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
                      </Tip>
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
