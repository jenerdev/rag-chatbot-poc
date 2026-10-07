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
//
// The look (plan/ui-refresh.md Phase 9): "Add a slot" and Edit open the form
// in a drawer; Retire and Delete ask in the dialog; the retired slots are
// folded away under "Retired (n)".

import { useCallback, useEffect, useState } from 'react';
import type { SlotAdmin } from '@rag/bookings';
import { LoginForm, describeFailure } from '@/components/admin-login';
import { fetchRole } from '@/components/tenant-nav';
import { StaffFrame } from '@/components/staff-frame';
import type { NavFeatures } from '@/lib/nav-items';
import { isRole, type Role } from '@/lib/permissions';
import { Drawer, useConfirmDialog } from '@/components/dialogs';
import { useNotice } from '@/components/toast';
import { Icon } from '@/components/icons';
import { Tip } from '@/components/tooltip';
import { EmptyState, LOADING, LoadState, failed, type Load } from '@/components/load-state';

export interface SlotsScreenProps {
  slug: string;
  businessName: string;
  logoUrl: string | null;
  bannerUrl: string | null;
  /** What the tenant has, for the header's links (lib/nav.ts). */
  nav: NavFeatures;
}

type Auth = 'checking' | 'out' | 'in';

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
  const [loadState, setLoadState] = useState<Load>(LOADING);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [formOpen, setFormOpen] = useState(false);
  const { notice, setNotice } = useNotice(formOpen);
  const { ask, dialog } = useConfirmDialog();

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
      setLoadState(failed(await describeFailure(error as Error, response)));
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
    if (ok) {
      setDraft(EMPTY);
      setFormOpen(false);
    }
  }

  // Closing abandons an edit; a new slot's draft is kept for next time.
  function closeForm() {
    setFormOpen(false);
    if (draft.id !== null) setDraft(EMPTY);
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
    setFormOpen(true);
  }

  const editing = draft.id === null ? null : (slots?.find((s) => s.id === draft.id) ?? null);
  // The times are fixed while upcoming bookings use the slot: the fields say
  // so before the server has to (the server and Postgres still decide).
  const timesFixed = editing !== null && editing.upcoming > 0;

  const frame = { slug, businessName, logoUrl, bannerUrl, features: nav, current: 'slots' as const, title: 'Slots', session: { auth, role, onLogout: logout } };

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

  const active = slots?.filter((s) => s.active) ?? [];
  const retired = slots?.filter((s) => !s.active) ?? [];

  const addSlot = (
    <button
      type="button"
      className="primary"
      onClick={() => {
        if (draft.id !== null) setDraft(EMPTY);
        setNotice(null);
        setFormOpen(true);
      }}
    >
      <Icon name="plus" size={16} /> Add a slot
    </button>
  );

  return (
    <>
      <StaffFrame {...frame} actions={addSlot}>
        {dialog}

        <Drawer open={formOpen} title={draft.id === null ? 'Add a slot' : `Edit "${editing?.name ?? draft.name}"`} onClose={closeForm}>
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
              <span className="form-actions">
                <button type="button" disabled={busy} onClick={closeForm}>
                  Cancel
                </button>
                <button type="submit" className="primary" aria-busy={busy || undefined} disabled={busy}>
                  {busy ? 'Saving…' : draft.id === null ? 'Add slot' : 'Save'}
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
          <h2>Slots offered</h2>
          {slots === null ? (
            <LoadState load={loadState} what="slots" onRetry={() => { setLoadState(LOADING); void load(); }} />
          ) : active.length === 0 ? (
            <EmptyState icon="clock" title="No slots offered" action={addSlot}>
              Nothing can be booked without one.
            </EmptyState>
          ) : (
            active.map((s) => (
              <div key={s.id} className="list-row">
                <span className="list-row-lead">{s.startTime}</span>
                <span className="list-row-main">
                  <span className="list-row-title">{s.name}</span>
                  {s.nightly && <span className="badge accent">Nightly</span>}
                </span>
                <span className="list-row-meta">
                  {lengthLabel(s.minutes)}
                  {s.upcoming > 0 ? ` · ${s.upcoming} upcoming` : ''}
                </span>
                <span className="list-row-actions">
                  <Tip label="Edit">
                    <button type="button" className="ghost sm" aria-label={`Edit ${s.name}`} disabled={busy} onClick={() => edit(s)}>
                      <Icon name="edit" size={16} />
                    </button>
                  </Tip>
                  {s.booked ? (
                    <button
                      type="button"
                      className="sm"
                      disabled={busy}
                      onClick={async () => {
                        const sure = await ask({
                          title: `Retire "${s.name}"?`,
                          body: 'It will no longer be offered on the booking page, in the chat, or for new bookings. Its bookings stay.',
                          actionLabel: 'Retire',
                          backLabel: 'Keep offering it',
                        });
                        if (sure !== null) void write('PATCH', `/slots/${s.id}`, { active: false }, `Retired "${s.name}".`);
                      }}
                    >
                      Retire
                    </button>
                  ) : (
                    <Tip label="Delete">
                      <button
                        type="button"
                        className="ghost sm danger"
                        aria-label={`Delete ${s.name}`}
                        disabled={busy}
                        onClick={async () => {
                          const sure = await ask({
                            title: `Delete "${s.name}"?`,
                            body: 'It was never booked; its room rates are deleted with it. This cannot be undone.',
                            actionLabel: 'Delete',
                            backLabel: 'Keep it',
                            danger: true,
                          });
                          if (sure !== null) void write('DELETE', `/slots/${s.id}`, undefined, `Deleted "${s.name}".`);
                        }}
                      >
                        <Icon name="trash" size={16} />
                      </button>
                    </Tip>
                  )}
                </span>
              </div>
            ))
          )}
        </section>

        {retired.length > 0 && (
          <details className="card folded">
            <summary>
              <Icon name="chevron-right" size={16} className="folded-chevron" />
              Retired ({retired.length})
            </summary>
            <p className="small muted">Not offered anywhere, and takes no new bookings. Their past bookings keep them.</p>
            {retired.map((s) => (
              <div key={s.id} className="list-row">
                <span className="list-row-lead">{s.startTime}</span>
                <span className="list-row-main">
                  <span className="list-row-title">{s.name}</span>
                  <span className="badge">Retired</span>
                </span>
                <span className="list-row-meta">{lengthLabel(s.minutes)}</span>
                <span className="list-row-actions">
                  <button type="button" className="sm" disabled={busy} onClick={() => void write('PATCH', `/slots/${s.id}`, { active: true }, `"${s.name}" is offered again.`)}>
                    Offer again
                  </button>
                </span>
              </div>
            ))}
          </details>
        )}
      </StaffFrame>
    </>
  );
}
