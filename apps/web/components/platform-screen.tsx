'use client';
import { SessionCheck } from './session-check';

// /platform (plan/tenant-management.md § 4.3): the super user's screen. A
// login form until the session GET says `platform: true`; then the tenant
// list, and one form per tenant (tenant-form.tsx). Every call goes to
// /api/platform/*, each on the platform token; this component holds no
// secret and decides nothing the routes do not decide again.

import { useCallback, useEffect, useState } from 'react';
import type { PlatformPulse, TenantDetail, TenantSummary } from '@rag/pipeline';
import { Icon } from '@/components/icons';
import { Bone, EmptyState, LOADING, LoadState, boneRows, failed, type Load } from '@/components/load-state';
import { LoginForm, describeFailure } from '@/components/admin-login';
import { ListSearch } from '@/components/list-search';
import { matches } from '@/lib/search';
import { TenantForm } from '@/components/tenant-form';
import { TenantMark } from '@/components/tenant-mark';
import { Drawer } from '@/components/dialogs';
import { Toaster } from '@/components/toast';
import { AccountMenu } from '@/components/account-menu';
import { BuildTag } from '@/components/build-tag';
import { ActivityList } from '@/components/activity-list';

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

  // The platform's top bar (plan/platform-header.md): the staff app's (D-117)
  // in the platform's own colours, with no tenant theme. Left, the mark and
  // where you are: Tenants, or Tenants › the tenant, its first step a way
  // back. Right, the account menu: the super user and Log out. Its edges are
  // the page's below it (the list is wider than a tenant's form).
  const header = (
    <div className={`staff-topbar platform-topbar ${typeof selected === 'number' ? 'narrow' : 'wide'}`} role="banner">
      <span className="platform-mark" aria-hidden="true">
        <Icon name="home" size={16} />
      </span>
      {/* Signed out, "Platform" is the page's h1 (the login card's title is an
          h2); signed in, the list and a tenant have their own h1. */}
      {auth === 'in' ? <span className="platform-name">Platform</span> : <h1 className="platform-name">Platform</h1>}
      <BuildTag />
      {auth === 'in' && (
        <nav className="topbar-crumbs" aria-label="Breadcrumb">
          {selected === null ? (
            <span className="topbar-here" aria-current="page">
              Tenants
            </span>
          ) : (
            <>
              <button type="button" className="link crumb-link" onClick={() => setSelected(null)}>
                Tenants
              </button>
              <Icon name="chevron-right" size={14} />
              <span className="topbar-here" aria-current="page">
                {detail?.businessName ?? '…'}
              </span>
            </>
          )}
        </nav>
      )}
      <div className="topbar-actions">{auth === 'in' && <AccountMenu role={null} label="Super user" links={[]} device={null} onLogout={logout} />}</div>
    </div>
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
            <SessionCheck />
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
        <main className="platform-main tenant-edit">
          {detail ? (
            <TenantForm
              api={API}
              tenant={detail}
              selfUserId={userId}
              onUnauthorized={unauthorized}
              onBack={() => setSelected(null)}
              onSaved={(saved) => {
                setDetail(saved);
                void loadTenants();
              }}
            />
          ) : (
            <>
              <button type="button" className="link back-link" onClick={() => setSelected(null)}>
                <Icon name="chevron-left" size={16} /> Tenants
              </button>
              <LoadState load={detailLoad} what="tenant" onRetry={() => setDetailTry((n) => n + 1)} skeleton={<TenantFormSkeleton />} />
            </>
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

        {/* While the list loads, the totals' own shape, so the list does not drop
            by a row of tiles when they arrive (the Pulse loads with the list). */}
        {!tenants && loadState.state === 'loading' && (
          <div className="stat-tiles platform-totals" aria-hidden="true">
            {boneRows(4, (i) => (
              <div className="stat-tile static">
                <span className="stat-tile-label">
                  <Bone w={['44%', '52%', '58%', '54%'][i]} h="small" />
                </span>
                <span className="stat-tile-value">
                  <Bone w="3ch" h="1.6rem" />
                </span>
                <span className="stat-tile-hint">
                  <Bone w={['38%', '56%', '70%', '72%'][i]} h="small" />
                </span>
              </div>
            ))}
          </div>
        )}
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
            <LoadState load={loadState} what="tenants" onRetry={() => { setLoadState(LOADING); void loadTenants(); }} skeleton={<TenantsSkeleton />} />
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

        {/* D-138: the platform's own log: super users added and removed, workspaces created and removed, sign-ins. */}
        <section className="card platform-activity" aria-labelledby="platform-activity-title">
          <h2 id="platform-activity-title">Platform activity</h2>
          <ActivityList api={`${API}/activity`} slug={null} platformView initial={{ days: 30, area: '', actor: '', q: '' }} onUnauthorized={unauthorized} retentionDays={730} />
        </section>
      </main>
    </>
  );
}

/**
 * The tenant list while it loads, in TenantRow's own classes: the mark, the
 * name with an application badge, the meta line, six Pulse figures, and the
 * Open and Edit buttons. A figure is a <dl>'s caption over its count, as the
 * real one; the buttons are bones of `button.sm`'s height.
 */
function TenantsSkeleton() {
  return (
    <ul className="tenant-list">
      {boneRows(4, (i) => (
        <li className="tenant-row">
          <Bone w="40px" h="40px" />
          <div className="tenant-who">
            <div className="tenant-name">
              <Bone w={['16ch', '22ch', '12ch', '19ch'][i]!} />
              {i % 2 === 0 && <Bone w="8ch" h="chip" />}
            </div>
            <span className="tenant-meta">
              <Bone w={['34ch', '40ch', '30ch', '36ch'][i]!} h="small" />
            </span>
          </div>
          <dl className="tenant-figures">
            {boneRows(6, () => (
              <div className="tenant-figure">
                <dt>
                  <Bone w="7ch" h="small" />
                </dt>
                <dd>
                  <Bone w="3ch" />
                </dd>
              </div>
            ))}
          </dl>
          <span className="list-row-actions">
            <Bone w="8ch" h="button-sm" />
            <Bone w="7ch" h="button-sm" />
          </span>
        </li>
      ))}
    </ul>
  );
}

/**
 * The tenant form while it loads, shaped like TenantForm's top and its first
 * tab: the large mark, the name with its status badge, the meta line and
 * Open chat; the tab strip; then Profile's Identity section (two name fields,
 * the avatar, the logo and the banner). The back link is drawn outside it.
 * The tabs are ghost <button>s so they take a control's height; the region
 * is inert.
 */
function TenantFormSkeleton() {
  const field = (label: string) => (
    <div className="field">
      <span className="field-label">
        <Bone w={label} h="small" />
      </span>
      <Bone w="100%" h="var(--control-h)" />
    </div>
  );
  const image = (preview: { w: string; round?: 'circle' }) => (
    <div className="field brand-image-field">
      <span className="field-label">
        <Bone w="10ch" h="small" />
      </span>
      <div className="brand-image-row">
        <Bone w={preview.w} h="72px" round={preview.round} />
        <div className="brand-image-actions">
          <Bone w="13ch" h="button-sm" />
        </div>
      </div>
      <div className="brand-image-url">
        <Bone w="22ch" h="small" />
      </div>
    </div>
  );
  return (
    <>
      <div className="tenant-edit-head">
        <div className="tenant-edit-title">
          <Bone w="56px" h="56px" />
          <div className="tenant-edit-name">
            <div className="page-title">
              <Bone w="18ch" h="title" /> <Bone w="5ch" h="chip" />
            </div>
            <p className="tenant-meta">
              <Bone w="40ch" h="small" />
            </p>
          </div>
          <Bone w="12ch" h="button" />
        </div>
      </div>
      <div className="tabs">
        {['7ch', '12ch', '8ch', '11ch', '14ch', '5ch', '7ch', '7ch'].map((w, i) => (
          <button key={i} type="button" className="ghost">
            <Bone w={w} h="small" />
          </button>
        ))}
      </div>
      <div className="card settings">
        <section className="settings-section">
          <div className="settings-about">
            <div>
              <Bone w="9ch" />
            </div>
            <p>
              <Bone w="100%" h="small" />
              <br />
              <Bone w="70%" h="small" />
            </p>
          </div>
          <div className="settings-fields">
            <div className="field-row">
              {field('13ch')}
              {field('14ch')}
            </div>
            <div className="field-row">{image({ w: '72px', round: 'circle' })}</div>
            <div className="field-row">
              {image({ w: '72px' })}
              {image({ w: '160px' })}
            </div>
          </div>
        </section>
      </div>
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
      <TenantMark businessName={t.businessName} logoUrl={t.logoUrl} />
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
