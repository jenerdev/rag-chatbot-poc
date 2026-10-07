'use client';

// The members of one tenant: who, as what, since when; add an existing
// account; change a role; remove (plan/tenant-management.md § 4.3).
//
// ONE panel, TWO callers: the tenant's Members screen (an owner, on
// /api/t/<slug>/members) and the platform's tenant form (a super user, on
// /api/platform/tenants/<id>/members). The routes differ; the panel does
// not. Everything it shows is a React child, so escaped.
//
// What it cannot do: invite a NEW account. That needs the service key, which
// no request holds (CLAUDE.md rule 2). The route's 404 says the CLI command
// to run, and this panel shows it as it is.
//
// The look (plan/ui-refresh.md Phase 9): each member a row with an initial,
// the role a compact picker, Remove a labelled icon that asks in the dialog.

import { useCallback, useEffect, useState } from 'react';
import type { Member } from '@rag/pipeline';
import { describeFailure } from '@/components/admin-login';
import { useConfirmDialog } from '@/components/dialogs';
import { Icon } from '@/components/icons';
import { Tip } from '@/components/tooltip';
import { LOADING, LoadState, failed, type Load } from '@/components/load-state';
import { useNotice } from '@/components/toast';
import { ROLES, ROLE_LABELS, type Role } from '@/lib/permissions';

export function MembersPanel({
  api,
  selfUserId,
  onUnauthorized,
}: {
  /** The members endpoint: `/api/t/<slug>/members` or `/api/platform/tenants/<id>/members`. */
  api: string;
  /** The platform's own user id, for "Make me an owner" (plan § 8 q5). Absent on the tenant's screen. */
  selfUserId?: string | null;
  onUnauthorized: () => void;
}) {
  const { ask, dialog } = useConfirmDialog();
  const [members, setMembers] = useState<Member[] | null>(null);
  const [loadState, setLoadState] = useState<Load>(LOADING);
  // No drawer here: the add form is one field, and its refusal is a toast like every other.
  const { setNotice } = useNotice();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('staff');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    let response: Response | null = null;
    try {
      response = await fetch(api);
      if (response.status === 401) return onUnauthorized();
      if (!response.ok) throw new Error('failed');
      setMembers(await response.json());
    } catch (error) {
      setMembers(null);
      setLoadState(failed(await describeFailure(error as Error, response)));
    }
  }, [api, onUnauthorized]);

  useEffect(() => {
    void load();
  }, [load]);

  /** One write, then the list the route hands back. Every refusal is shown in the server's words. */
  const write = useCallback(
    async (method: 'POST' | 'PATCH' | 'DELETE', body: object, done: string) => {
      setBusy(true);
      setNotice(null);
      let response: Response | null = null;
      try {
        response = await fetch(api, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        if (response.status === 401) return onUnauthorized();
        if (!response.ok) throw new Error('failed');
        setMembers(await response.json());
        setNotice({ message: done, kind: 'ok' });
        return true;
      } catch (error) {
        setNotice({ message: await describeFailure(error as Error, response), kind: 'error' });
        return false;
      } finally {
        setBusy(false);
      }
    },
    [api, onUnauthorized],
  );

  async function add(event: React.FormEvent) {
    event.preventDefault();
    if (await write('POST', { email: email.trim(), role }, `Added ${email.trim()} as ${ROLE_LABELS[role].toLowerCase()}.`)) setEmail('');
  }

  const isMember = selfUserId ? members?.some((m) => m.userId === selfUserId) : true;

  return (
    <section className="card">
      {dialog}
      <h2>Members{members ? ` (${members.length})` : ''}</h2>
      <p className="small muted">
        Owners manage members and everything below; admins manage the knowledge base, rooms, rates and holidays; staff
        handle bookings and the unanswered questions. A change takes effect on the person&apos;s next request. A tenant
        always keeps at least one owner.
      </p>

      {members === null ? (
        <LoadState load={loadState} what="members" onRetry={() => { setLoadState(LOADING); void load(); }} />
      ) : members.length === 0 ? (
        <div className="small muted">Nobody yet. Add the first owner below.</div>
      ) : (
        <div>
          {members.map((m) => (
            <div key={m.userId} className="member-row">
              <span className="member-avatar" aria-hidden="true">
                {m.email.charAt(0).toUpperCase()}
              </span>
              <span className="member-who">
                <span className="member-email">
                  {m.email}
                  {selfUserId === m.userId && <span className="badge accent">You</span>}
                </span>
                <span className="member-since">Member since {new Date(m.createdAt).toLocaleDateString()}</span>
              </span>
              <span className="list-row-actions">
                <select
                  className="compact"
                  aria-label={`Role of ${m.email}`}
                  value={m.role}
                  disabled={busy}
                  onChange={(event) => void write('PATCH', { userId: m.userId, role: event.target.value }, `${m.email} is now ${event.target.value}.`)}
                >
                  {ROLES.map((r) => (
                    <option key={r} value={r}>
                      {ROLE_LABELS[r]}
                    </option>
                  ))}
                </select>
                <Tip label="Remove">
                  <button
                    type="button"
                    className="ghost sm danger"
                    aria-label={`Remove ${m.email}`}
                    disabled={busy}
                    onClick={async () => {
                      const sure = await ask({
                        title: `Remove ${m.email}?`,
                        body: 'Their next request is refused. Their account stays; it can be added again.',
                        actionLabel: 'Remove',
                        backLabel: 'Keep them',
                        danger: true,
                      });
                      if (sure !== null) void write('DELETE', { userId: m.userId }, `Removed ${m.email}.`);
                    }}
                  >
                    <Icon name="trash" size={16} />
                  </button>
                </Tip>
              </span>
            </div>
          ))}
        </div>
      )}

      <form onSubmit={add}>
        <div className="field-row">
          <div className="field">
            <label htmlFor="member-email">Add an existing account</label>
            <input
              type="email"
              id="member-email"
              placeholder="name@example.com"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              required
            />
          </div>
          <div className="field">
            <label htmlFor="member-role">As</label>
            <select id="member-role" value={role} onChange={(event) => setRole(event.target.value as Role)}>
              {ROLES.map((r) => (
                <option key={r} value={r}>
                  {ROLE_LABELS[r]}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="form-footer">
          <span className="small muted">
            The account must already exist. A new one is invited from the command line: <code>member:add</code>.
          </span>
          <button type="submit" className="primary" disabled={busy || email.trim() === ''}>
            {busy ? 'Saving…' : 'Add member'}
          </button>
        </div>
      </form>

      {selfUserId && members && !isMember && (
        <div className="form-footer">
          <span className="small muted">
            The platform manages this tenant&apos;s record, not its content. To open its screens, become an owner.
          </span>
          <button type="button" disabled={busy} onClick={() => void write('POST', { userId: selfUserId, role: 'owner' }, 'You are an owner here now. Log in on its admin page.')}>
            Make me an owner
          </button>
        </div>
      )}
    </section>
  );
}
