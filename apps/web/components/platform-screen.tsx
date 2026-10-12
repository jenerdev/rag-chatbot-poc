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
import { ListSearch } from '@/components/list-search';
import { matches } from '@/lib/search';
import { TenantForm } from '@/components/tenant-form';
import { Drawer } from '@/components/dialogs';
import { Toaster } from '@/components/toast';

type Auth = 'checking' | 'out' | 'in';
const API = '/api/platform';

export function PlatformScreen() {
  const [auth, setAuth] = useState<Auth>('checking');
  const [userId, setUserId] = useState<string | null>(null);
  const [tenants, setTenants] = useState<TenantSummary[] | null>(null);
  const [pulse, setPulse] = useState<PlatformPulse[] | null>(null);
  const [loadState, setLoadState] = useState<Load>(LOADING);
  /** null = the list; a number = that tenant's form. */
  const [selected, setSelected] = useState<number | null>(null);
  // The create form is a drawer over the list. It stays mounted while closed,
  // so what was typed survives closing it; `createKey` empties it after a create.
  const [creating, setCreating] = useState(false);
  const [createKey, setCreateKey] = useState(0);
  const [detail, setDetail] = useState<TenantDetail | null>(null);
  const [detailLoad, setDetailLoad] = useState<Load>(LOADING);
  // Bumped by Retry: the detail load is an effect (it cancels on a new selection), so it re-runs on this.
  const [detailTry, setDetailTry] = useState(0);
  // The list's search and view: they narrow what was loaded, on screen only.
  const [search, setSearch] = useState('');
  const [view, setView] = useState<'live' | 'archived' | 'all'>('live');

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
    setCreating(false);
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
    <button type="button" className="primary" onClick={() => setCreating(true)}>
      <Icon name="plus" size={16} /> New tenant
    </button>
  );

  const header = (
    <header>
      <h1 className="brand">
        <span>Platform</span>
        <span className="brand-subtitle">{selected === null ? 'Tenants' : detail?.businessName ?? '…'}</span>
      </h1>
      <nav>
        {auth === 'in' && selected !== null && (
          <button type="button" className="button" onClick={() => setSelected(null)}>
            ← All tenants
          </button>
        )}
        {auth === 'in' && (
          <button type="button" className="link" onClick={logout}>
            <Icon name="logout" size={16} /> <span className="narrow-hidden">Log out</span>
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

  // The index: the totals, then ONE list of tenants, each row carrying its own
  // Pulse figures (D-098) beside its name, so a tenant is read once, not twice.
  const pulseOf = new Map((pulse ?? []).map((p) => [p.tenantId, p]));
  const live = (tenants ?? []).filter((t) => !t.archivedAt);
  const archived = (tenants ?? []).filter((t) => t.archivedAt);
  const livePulse = (pulse ?? []).filter((p) => p.archivedAt === null);
  const total = (key: 'conversations30d' | 'refusals30d' | 'openUnanswered' | 'pendingRequests') => livePulse.reduce((sum, p) => sum + p[key], 0);
  const shown = (view === 'live' ? live : view === 'archived' ? archived : tenants ?? [])
    .filter((t) => matches([t.businessName, t.slug, t.assistantName, ...t.applications].join(' '), search))
    .sort((a, b) => a.businessName.localeCompare(b.businessName));

  return (
    <>
      {top}
      <main className="platform-main">
        <Drawer open={creating} title="New tenant" onClose={() => setCreating(false)}>
          <TenantForm
            key={createKey}
            api={API}
            tenant={null}
            selfUserId={userId}
            onUnauthorized={unauthorized}
            onCancel={() => setCreating(false)}
            onSaved={(saved) => {
              setCreating(false);
              setCreateKey((n) => n + 1);
              void loadTenants();
              setSelected(saved.id);
            }}
          />
        </Drawer>

        <div className="page-head">
          <div>
            <h1 className="page-title">Tenants</h1>
            <p className="page-lede">
              Each tenant is a workspace at <code>/t/&lt;slug&gt;</code> with its own documents, assistant and theme.
            </p>
          </div>
          {newTenant}
        </div>

        {/* The totals over live tenants, from the Pulse (counts only, no content, no money: plan § 2.4). Left out if it failed. */}
        {tenants && pulse && (
          <div className="stat-tiles platform-totals">
            <div className="stat-tile static">
              <span className="stat-tile-label">
                <Icon name="home" size={14} /> Live tenants
              </span>
              <span className="stat-tile-value">{live.length}</span>
              <span className="stat-tile-hint">{archived.length > 0 ? `${archived.length} archived` : 'None archived'}</span>
            </div>
            <div className="stat-tile static">
              <span className="stat-tile-label">
                <Icon name="chat" size={14} /> Conversations
              </span>
              <span className="stat-tile-value">{total('conversations30d')}</span>
              <span className="stat-tile-hint">last 30 days · {total('refusals30d')} refused</span>
            </div>
            <div className={`stat-tile static${total('openUnanswered') > 0 ? ' attention' : ''}`}>
              <span className="stat-tile-label">
                <Icon name="help" size={14} /> Open unanswered
              </span>
              <span className="stat-tile-value">{total('openUnanswered')}</span>
              <span className="stat-tile-hint">questions the assistant could not answer</span>
            </div>
            <div className={`stat-tile static${total('pendingRequests') > 0 ? ' attention' : ''}`}>
              <span className="stat-tile-label">
                <Icon name="calendar" size={14} /> Requests waiting
              </span>
              <span className="stat-tile-value">{total('pendingRequests')}</span>
              <span className="stat-tile-hint">booking requests staff have not decided</span>
            </div>
          </div>
        )}

        <section className="card platform-tenants">
          <div className="platform-toolbar">
            <ListSearch value={search} onChange={setSearch} label="Search name, slug, assistant" />
            <div className="segmented" role="group" aria-label="Show">
              {(
                [
                  ['live', 'Live', live.length],
                  ['archived', 'Archived', archived.length],
                  ['all', 'All', tenants?.length ?? 0],
                ] as const
              ).map(([key, label, count]) => (
                <button key={key} type="button" aria-pressed={view === key} onClick={() => setView(key)}>
                  {label} <span className="segment-count">{count}</span>
                </button>
              ))}
            </div>
          </div>

          {tenants === null ? (
            <LoadState load={loadState} what="tenants" rows={4} onRetry={() => { setLoadState(LOADING); void loadTenants(); }} />
          ) : tenants.length === 0 ? (
            <EmptyState icon="home" title="No tenants yet" action={newTenant}>
              A tenant is a business with its own chat, documents and staff.
            </EmptyState>
          ) : shown.length === 0 ? (
            <EmptyState icon="search" title={search ? 'No tenants match' : view === 'archived' ? 'Nothing archived' : 'No live tenants'} compact>
              {search ? 'Change the search, or choose All.' : 'Choose another view.'}
            </EmptyState>
          ) : (
            <ul className="tenant-list">
              {shown.map((t) => (
                <TenantRow key={t.id} tenant={t} pulse={pulseOf.get(t.id) ?? null} onEdit={() => setSelected(t.id)} />
              ))}
            </ul>
          )}
        </section>
      </main>
    </>
  );
}

/** One figure in a tenant's row: the count, its caption; `attention` when it waits on someone. */
function Figure({ value, label, attention }: { value: number; label: string; attention?: boolean }) {
  return (
    <div className={attention && value > 0 ? 'tenant-figure attention' : 'tenant-figure'}>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

/**
 * A tenant: its mark, its name (which opens the form) with what is switched
 * on, where it lives and who answers there; its figures from the Pulse; the
 * way to its chat. Booking figures only for a tenant with bookings.
 */
function TenantRow({ tenant: t, pulse: p, onEdit }: { tenant: TenantSummary; pulse: PlatformPulse | null; onEdit: () => void }) {
  const bookings = t.applications.includes('bookings');
  const since = new Date(t.createdAt).toLocaleDateString('en-GB', { month: 'short', year: 'numeric' });
  return (
    <li className={t.archivedAt ? 'tenant-row archived' : 'tenant-row'}>
      <span className="member-avatar" aria-hidden="true">
        {t.businessName.charAt(0).toUpperCase()}
      </span>
      <div className="tenant-who">
        <div className="tenant-name">
          <button type="button" className="link tenant-open" onClick={onEdit}>
            {t.businessName}
          </button>
          {t.archivedAt && <span className="badge">Archived {t.archivedAt.slice(0, 10)}</span>}
          {t.applications.map((a) => (
            <span key={a} className="badge accent">
              {a}
            </span>
          ))}
        </div>
        <span className="tenant-meta">
          /t/{t.slug} · {t.assistantName} · {t.members} member{t.members === 1 ? '' : 's'} · since {since}
        </span>
      </div>
      {p && (
        <dl className="tenant-figures" aria-label={`${t.businessName}, last 30 days`}>
          <Figure value={p.documents} label="Documents" />
          <Figure value={p.conversations30d} label="Chats" />
          <Figure value={p.refusals30d} label="Refused" />
          <Figure value={p.openUnanswered} label="Unanswered" attention />
          {bookings ? (
            <>
              <Figure value={p.pendingRequests} label="Requests" attention />
              <Figure value={p.confirmedStays30d} label="Stays" />
            </>
          ) : (
            // Two empty cells keep the columns in line with the booking tenants' rows.
            <div className="tenant-figure-gap" aria-hidden="true" />
          )}
        </dl>
      )}
      <span className="list-row-actions">
        {!t.archivedAt && (
          <a className="button ghost sm" href={`/t/${t.slug}`} target="_blank" rel="noreferrer" aria-label={`Open the chat of ${t.businessName} in a new tab`}>
            <Icon name="chat" size={14} /> Open
          </a>
        )}
        <button type="button" className="sm" onClick={onEdit} aria-label={`Edit ${t.businessName}`}>
          <Icon name="edit" size={14} /> Edit
        </button>
      </span>
    </li>
  );
}
