'use client';

// /platform (plan/tenant-management.md § 4.3): the super user's screen. A
// login form until the session GET says `platform: true`; then the tenant
// list, and one form per tenant (tenant-form.tsx). Every call goes to
// /api/platform/*, each on the platform token; this component holds no
// secret and decides nothing the routes do not decide again.

import { useCallback, useEffect, useState } from 'react';
import type { PlatformPulse, TenantDetail, TenantSummary } from '@rag/pipeline';
import { Icon } from '@/components/icons';
import { EmptyState, LOADING, LoadState, failed, type Load } from '@/components/load-state';
import { LoginForm, describeFailure } from '@/components/admin-login';
import { TenantForm } from '@/components/tenant-form';
import { Toaster } from '@/components/toast';

type Auth = 'checking' | 'out' | 'in';
const API = '/api/platform';

export function PlatformScreen() {
  const [auth, setAuth] = useState<Auth>('checking');
  const [userId, setUserId] = useState<string | null>(null);
  const [tenants, setTenants] = useState<TenantSummary[] | null>(null);
  const [pulse, setPulse] = useState<PlatformPulse[] | null>(null);
  const [loadState, setLoadState] = useState<Load>(LOADING);
  /** null = the list; 'new' = the create form; a number = that tenant's form. */
  const [selected, setSelected] = useState<number | 'new' | null>(null);
  const [detail, setDetail] = useState<TenantDetail | null>(null);
  const [detailLoad, setDetailLoad] = useState<Load>(LOADING);
  // Bumped by Retry: the detail load is an effect (it cancels on a new selection), so it re-runs on this.
  const [detailTry, setDetailTry] = useState(0);

  const askSession = useCallback(async () => {
    try {
      const response = await fetch(`${API}/session`);
      const body = await response.json();
      setAuth(body.platform === true ? 'in' : 'out');
      setUserId(typeof body.userId === 'string' ? body.userId : null);
    } catch {
      setAuth('out');
    }
  }, []);

  useEffect(() => {
    void askSession();
  }, [askSession]);

  // Any 401 means the session is gone (expired, logged out, or super:remove).
  const unauthorized = useCallback(() => {
    setAuth('out');
    setUserId(null);
    setTenants(null);
    setSelected(null);
    setDetail(null);
  }, []);

  const loadTenants = useCallback(async () => {
    let response: Response | null = null;
    try {
      response = await fetch(`${API}/tenants`);
      if (response.status === 401) return unauthorized();
      if (!response.ok) throw new Error('failed');
      setTenants(await response.json());
    } catch (error) {
      setTenants(null);
      setLoadState(failed(await describeFailure(error as Error, response)));
    }
    // The Pulse strip (D-098): counts only, from platform_dashboard(). A
    // failure here leaves the strip out and the list intact.
    try {
      const pulse = await fetch(`${API}/dashboard`);
      setPulse(pulse.ok ? await pulse.json() : null);
    } catch {
      setPulse(null);
    }
  }, [unauthorized]);

  useEffect(() => {
    if (auth === 'in') void loadTenants();
  }, [auth, loadTenants]);

  // One tenant's detail, by id (an archived one still resolves here).
  useEffect(() => {
    if (typeof selected !== 'number') {
      setDetail(null);
      return;
    }
    let cancelled = false;
    setDetail(null);
    setDetailLoad(LOADING);
    void (async () => {
      let response: Response | null = null;
      try {
        response = await fetch(`${API}/tenants/${selected}`);
        if (response.status === 401) return unauthorized();
        if (!response.ok) throw new Error('failed');
        const loaded: TenantDetail = await response.json();
        if (!cancelled) setDetail(loaded);
      } catch (error) {
        if (!cancelled) setDetailLoad(failed(await describeFailure(error as Error, response)));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selected, detailTry, unauthorized]);

  const logout = useCallback(async () => {
    await fetch(`${API}/session`, { method: 'DELETE' }).catch(() => undefined);
    unauthorized();
  }, [unauthorized]);

  const newTenant = (
    <button type="button" className="primary" onClick={() => setSelected('new')}>
      <Icon name="plus" size={16} /> New tenant
    </button>
  );

  const header = (
    <header>
      <h1 className="brand">
        <span>Platform</span>
        <span className="brand-subtitle">{selected === null ? 'Tenants' : selected === 'new' ? 'New tenant' : detail?.businessName ?? '…'}</span>
      </h1>
      <nav>
        {auth === 'in' && selected !== null && (
          <button type="button" className="button" onClick={() => setSelected(null)}>
            ← All tenants
          </button>
        )}
        {auth === 'in' && (
          <button type="button" className="link" onClick={logout}>
            Log out
          </button>
        )}
      </nav>
    </header>
  );
  // Every branch draws the header, so the page's ONE toast region rides with
  // it (components/toast.tsx): the tenant form and its members panel share it.
  const top = (
    <>
      {header}
      {auth === 'in' && <Toaster />}
    </>
  );

  if (auth !== 'in') {
    return (
      <>
        {top}
        <main>
          {auth === 'checking' ? (
            <div className="small muted">Checking your session…</div>
          ) : (
            <LoginForm
              api={API}
              slug="platform"
              sessionPath="/session"
              resetPath="/password-reset"
              title="Platform login"
              intro={
                <>
                  Log in with a platform account. Platform accounts are created with <code>pnpm --filter @rag/db super:add</code>.
                </>
              }
              onLoggedIn={() => void askSession()}
            />
          )}
        </main>
      </>
    );
  }

  if (selected === 'new') {
    return (
      <>
        {top}
        <main>
          <TenantForm
            api={API}
            tenant={null}
            selfUserId={userId}
            onUnauthorized={unauthorized}
            onSaved={(saved) => {
              void loadTenants();
              setSelected(saved.id);
            }}
          />
        </main>
      </>
    );
  }

  if (typeof selected === 'number') {
    return (
      <>
        {top}
        <main>
          {detail ? (
            <TenantForm
              api={API}
              tenant={detail}
              selfUserId={userId}
              onUnauthorized={unauthorized}
              onSaved={(saved) => {
                setDetail(saved);
                void loadTenants();
              }}
            />
          ) : (
            <LoadState load={detailLoad} what="tenant" rows={4} onRetry={() => setDetailTry((n) => n + 1)} />
          )}
        </main>
      </>
    );
  }

  return (
    <>
      {top}
      <main>
        {/* The Pulse strip (D-098): every live tenant's counts in one table; archived ones folded. Counts only, no content, no money (plan § 2.4). */}
        {pulse && pulse.length > 0 && (
          <section className="card">
            <h2>Pulse, last 30 days</h2>
            {/* Focusable, so a keyboard can scroll it sideways when it is wider than the card (Phase 10's audit). */}
            <div className="reply-table pulse" tabIndex={0} role="region" aria-label="Pulse, last 30 days">
              <table>
                <thead>
                  <tr>
                    <th>Tenant</th>
                    <th className="amount">Members</th>
                    <th className="amount">Documents</th>
                    <th className="amount">Conversations</th>
                    <th className="amount">Refusals</th>
                    <th className="amount">Open unanswered</th>
                    <th className="amount">Requests waiting</th>
                    <th className="amount">Confirmed stays</th>
                  </tr>
                </thead>
                <tbody>
                  {pulse
                    .filter((p) => p.archivedAt === null)
                    .map((p) => (
                      <tr key={p.tenantId}>
                        <td data-label="Tenant">{p.businessName}</td>
                        <td data-label="Members" className="amount">{p.members}</td>
                        <td data-label="Documents" className="amount">{p.documents}</td>
                        <td data-label="Conversations" className="amount">{p.conversations30d}</td>
                        <td data-label="Refusals" className="amount">{p.refusals30d}</td>
                        <td data-label="Open unanswered" className="amount">{p.openUnanswered}</td>
                        <td data-label="Requests waiting" className="amount">{p.pendingRequests}</td>
                        <td data-label="Confirmed stays" className="amount">{p.confirmedStays30d}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
            {pulse.some((p) => p.archivedAt !== null) && (
              <details className="small muted">
                <summary>{pulse.filter((p) => p.archivedAt !== null).length} archived</summary>
                <ul>
                  {pulse
                    .filter((p) => p.archivedAt !== null)
                    .map((p) => (
                      <li key={p.tenantId}>
                        {p.businessName} · archived {p.archivedAt?.slice(0, 10)}
                      </li>
                    ))}
                </ul>
              </details>
            )}
          </section>
        )}
        <section className="card">
          <div className="range-head">
            <h2>Tenants{tenants ? ` (${tenants.length})` : ''}</h2>
            {newTenant}
          </div>
          <p className="small muted">
            Each tenant is a workspace at <code>/t/&lt;slug&gt;</code> with its own documents, assistant and theme. Archived
            tenants answer 404 everywhere but here.
          </p>
          {tenants === null ? (
            <LoadState load={loadState} what="tenants" onRetry={() => { setLoadState(LOADING); void loadTenants(); }} />
          ) : tenants.length === 0 ? (
            <EmptyState icon="home" title="No tenants yet" action={newTenant} />
          ) : (
            <div>
              {tenants.map((t) => (
                <div key={t.id} className="member-row">
                  <span className="member-avatar" aria-hidden="true">
                    {t.businessName.charAt(0).toUpperCase()}
                  </span>
                  <span className="member-who">
                    <span className="member-email">
                      {t.businessName}
                      {t.archivedAt && <span className="badge">Archived</span>}
                      {t.applications.map((a) => (
                        <span key={a} className="badge accent">
                          {a}
                        </span>
                      ))}
                    </span>
                    <span className="member-since">
                      /t/{t.slug} · {t.assistantName} · {t.members} member{t.members === 1 ? '' : 's'}
                    </span>
                  </span>
                  <span className="list-row-actions">
                    {!t.archivedAt && (
                      <a className="button ghost sm" href={`/t/${t.slug}`} target="_blank" rel="noreferrer">
                        Open
                      </a>
                    )}
                    <button type="button" className="sm" onClick={() => setSelected(t.id)}>
                      Edit
                    </button>
                  </span>
                </div>
              ))}
            </div>
          )}
        </section>
      </main>
    </>
  );
}
