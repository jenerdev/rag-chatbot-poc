'use client';

// S-9 · Slots (D-090). The periods a tenant sells: a name, a start time, a
// length, and whether a stay can repeat it night after night ("nightly").
// Owners and admins manage them here; every rule is also Postgres's
// (schema-slots.sql), so this screen only says it first:
//
//   * a slot's START TIME and LENGTH cannot change while it has upcoming
//     bookings: a booking keeps the times it was made with. The name and
//     nightly can change at any time. For new times, add a slot and retire
//     the old one.
//   * a slot that was ever booked is RETIRED, not deleted: it disappears from
//     the booking page, the chat and new bookings, and its past bookings keep
//     it. A slot never booked can be deleted, and its room rates go with it.
//
// A new slot has no price until rates are set for it (the Rooms screen, or
// the whole property's rates), so it is not offered on the booking page yet.

import { useCallback, useEffect, useState } from 'react';
import type { SlotAdmin } from '@rag/bookings';
import { BrandHeader } from '@/components/brand-header';
import { LoginForm, describeFailure } from '@/components/admin-login';
import { TenantNav, fetchRole } from '@/components/tenant-nav';
import type { NavFeatures } from '@/lib/nav-items';
import { isRole, type Role } from '@/lib/permissions';

export interface SlotsScreenProps {
  slug: string;
  businessName: string;
  logoUrl: string | null;
  bannerUrl: string | null;
  /** What the tenant has, for the header's links (lib/nav.ts). */
  nav: NavFeatures;
}

type Auth = 'checking' | 'out' | 'in';
type Notice = { message: string; kind: 'ok' | 'error' } | null;

/** The form's fields: the length is hours and minutes, sent as minutes. */
interface Draft {
  id: number | null;
  name: string;
  startTime: string;
  hours: string;
  minutes: string;
  nightly: boolean;
}

const EMPTY: Draft = { id: null, name: '', startTime: '', hours: '', minutes: '0', nightly: false };

/** 1320 → "22 hours", 90 → "1 hour 30 minutes". */
function lengthLabel(total: number): string {
  const h = Math.floor(total / 60);
  const m = total % 60;
  const parts = [h ? `${h} hour${h === 1 ? '' : 's'}` : '', m ? `${m} minute${m === 1 ? '' : 's'}` : ''].filter(Boolean);
  return parts.join(' ') || '0 minutes';
}

export function SlotsScreen({ slug, businessName, logoUrl, bannerUrl, nav }: SlotsScreenProps) {
  const api = `/api/t/${slug}`;
  const [auth, setAuth] = useState<Auth>('checking');
  // What this member is, for the header's links only; the routes decide for themselves.
  const [role, setRole] = useState<Role | null>(null);
  const [slots, setSlots] = useState<SlotAdmin[] | null>(null);
  const [loadMessage, setLoadMessage] = useState('Loading…');
  const [notice, setNotice] = useState<Notice>(null);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<Draft>(EMPTY);

  const unauthorized = useCallback(() => {
    setAuth('out');
    setSlots(null);
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
      response = await fetch(`${api}/slots`);
      if (response.status === 401) return unauthorized();
      if (!response.ok) throw new Error('failed');
      setSlots(await response.json());
    } catch (error) {
      setSlots(null);
      setLoadMessage(await describeFailure(error as Error, response));
    }
  }, [api, unauthorized]);

  useEffect(() => {
    if (auth === 'in') void load();
  }, [auth, load]);

  const logout = useCallback(async () => {
    await fetch(`${api}/admin/session`, { method: 'DELETE' }).catch(() => undefined);
    unauthorized();
  }, [api, unauthorized]);

  /** One write; on success, a message and a fresh list. */
  async function write(method: string, path: string, body: object | undefined, done: string): Promise<boolean> {
    setNotice(null);
    setBusy(true);
    let response: Response | null = null;
    try {
      response = await fetch(`${api}${path}`, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      if (response.status === 401) {
        unauthorized();
        return false;
      }
      if (!response.ok) throw new Error('failed');
      setNotice({ message: done, kind: 'ok' });
      void load();
      return true;
    } catch (error) {
      setNotice({ message: await describeFailure(error as Error, response), kind: 'error' });
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    const minutes = Number(draft.hours || 0) * 60 + Number(draft.minutes || 0);
    if (!Number.isInteger(minutes) || minutes <= 0) {
      setNotice({ message: 'The length is whole hours and minutes, more than zero.', kind: 'error' });
      return;
    }
    const fields = { name: draft.name.trim(), startTime: draft.startTime, minutes, nightly: draft.nightly };
    const ok =
      draft.id === null
        ? await write('POST', '/slots', fields, `Added "${fields.name}". Set its rates before it is offered on the booking page.`)
        : await write('PATCH', `/slots/${draft.id}`, fields, `Saved "${fields.name}".`);
    if (ok) setDraft(EMPTY);
  }

  function edit(slot: SlotAdmin) {
    setDraft({
      id: slot.id,
      name: slot.name,
      startTime: slot.startTime,
      hours: String(Math.floor(slot.minutes / 60)),
      minutes: String(slot.minutes % 60),
      nightly: slot.nightly,
    });
    setNotice(null);
    window.scrollTo({ top: 0 });
  }

  const editing = draft.id === null ? null : (slots?.find((s) => s.id === draft.id) ?? null);
  // The times are fixed while upcoming bookings use the slot: the fields say
  // so before the server has to (the server and Postgres still decide).
  const timesFixed = editing !== null && editing.upcoming > 0;

  const header = (
    <BrandHeader businessName={businessName} logoUrl={logoUrl} bannerUrl={bannerUrl} subtitle="Slots">
      <TenantNav slug={slug} features={nav} current="slots" session={{ auth, role, onLogout: logout }} />
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

  const active = slots?.filter((s) => s.active) ?? [];
  const retired = slots?.filter((s) => !s.active) ?? [];

  return (
    <>
      {header}
      <main>
        <div className={notice ? `notice ${notice.kind}` : 'notice hidden'}>{notice?.message}</div>

        <section className="card">
          <h2>{draft.id === null ? 'Add a slot' : `Edit "${editing?.name ?? draft.name}"`}</h2>
          <p className="small muted">
            A slot is a period you sell, such as a Day Tour from 08:00 for 9 hours. It can run past midnight. Nightly means a
            stay can repeat it night after night. Times are in {slots?.[0]?.timezone ?? 'the business’s timezone'}.
          </p>
          {timesFixed && (
            <p className="small">
              <strong>
                {editing!.upcoming} upcoming booking{editing!.upcoming === 1 ? '' : 's'} use this slot,
              </strong>{' '}
              so its start time and length cannot change. Its name and nightly can. For new times, add a new slot and retire
              this one.
            </p>
          )}
          <form onSubmit={save}>
            <div className="field-row">
              <div className="field grow">
                <label htmlFor="slot-name">Name</label>
                <input id="slot-name" required maxLength={60} placeholder="Day Tour" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
              </div>
              <div className="field">
                <label htmlFor="slot-start">Starts at</label>
                <input
                  id="slot-start"
                  type="time"
                  required
                  disabled={timesFixed}
                  value={draft.startTime}
                  onChange={(e) => setDraft({ ...draft, startTime: e.target.value })}
                />
              </div>
              <div className="field narrow">
                <label htmlFor="slot-hours">Hours</label>
                <input
                  id="slot-hours"
                  type="number"
                  min={0}
                  max={48}
                  required
                  disabled={timesFixed}
                  value={draft.hours}
                  onChange={(e) => setDraft({ ...draft, hours: e.target.value })}
                />
              </div>
              <div className="field narrow">
                <label htmlFor="slot-minutes">Minutes</label>
                <input
                  id="slot-minutes"
                  type="number"
                  min={0}
                  max={59}
                  disabled={timesFixed}
                  value={draft.minutes}
                  onChange={(e) => setDraft({ ...draft, minutes: e.target.value })}
                />
              </div>
            </div>
            <label className="small">
              <input type="checkbox" checked={draft.nightly} onChange={(e) => setDraft({ ...draft, nightly: e.target.checked })} /> Nightly: a stay
              can book this slot for several nights in a row
            </label>
            <div className="form-footer">
              <span className="small muted">
                {draft.id === null ? 'A new slot has no price until its rates are set.' : 'Bookings already made keep the times they were made with.'}
              </span>
              <span>
                {draft.id !== null && (
                  <button type="button" disabled={busy} onClick={() => setDraft(EMPTY)}>
                    Cancel
                  </button>
                )}{' '}
                <button type="submit" className="primary" disabled={busy}>
                  {busy ? 'Saving…' : draft.id === null ? 'Add slot' : 'Save'}
                </button>
              </span>
            </div>
          </form>
        </section>

        <section className="card">
          <h2>Slots offered</h2>
          {slots === null ? (
            <div className="small">{loadMessage}</div>
          ) : active.length === 0 ? (
            <div className="small muted">No slots offered. Add one above; nothing can be booked without one.</div>
          ) : (
            active.map((s) => (
              <div key={s.id} className="holiday">
                <span className="holiday-day">{s.startTime}</span>
                <span className="holiday-label">
                  {s.name}
                  {s.nightly && <span className="holiday-badge">nightly</span>}
                </span>
                <span className="holiday-surcharge">
                  {lengthLabel(s.minutes)}
                  {s.upcoming > 0 ? ` · ${s.upcoming} upcoming` : ''}
                </span>
                <button type="button" className="link" disabled={busy} onClick={() => edit(s)}>
                  Edit
                </button>
                {s.booked ? (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      if (window.confirm(`Retire "${s.name}"? It will no longer be offered on the booking page, in the chat, or for new bookings. Its bookings stay.`)) {
                        void write('PATCH', `/slots/${s.id}`, { active: false }, `Retired "${s.name}".`);
                      }
                    }}
                  >
                    Retire
                  </button>
                ) : (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      if (window.confirm(`Delete "${s.name}"? It was never booked; its room rates are deleted with it.`)) {
                        void write('DELETE', `/slots/${s.id}`, undefined, `Deleted "${s.name}".`);
                      }
                    }}
                  >
                    Delete
                  </button>
                )}
              </div>
            ))
          )}
        </section>

        {retired.length > 0 && (
          <section className="card">
            <h2>Retired</h2>
            <p className="small muted">Not offered anywhere, and takes no new bookings. Their past bookings keep them.</p>
            {retired.map((s) => (
              <div key={s.id} className="holiday">
                <span className="holiday-day">{s.startTime}</span>
                <span className="holiday-label">
                  {s.name}
                  <span className="holiday-badge closed">retired</span>
                </span>
                <span className="holiday-surcharge">{lengthLabel(s.minutes)}</span>
                <button type="button" disabled={busy} onClick={() => void write('PATCH', `/slots/${s.id}`, { active: true }, `"${s.name}" is offered again.`)}>
                  Offer again
                </button>
              </div>
            ))}
          </section>
        )}
      </main>
    </>
  );
}
