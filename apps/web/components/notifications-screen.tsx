'use client';

// S-17 · Notifications (plan/notifications.md § 8). What arrived for this
// member in the last 30 days: a guest's booking request, a proof to verify
// (owners and admins), a guest asking to change a stay. The same rows, words
// and links a push carries, read or not.
//
// The sidebar's Notifications badge is the unread count. Opening a row marks
// it read and goes where it is dealt with (the stay, or Payments); so does
// tapping the push on any device. "Mark all read" clears the rest. Reading is
// per MEMBER: read on the phone is read here. Deciding the request is still
// done on its own page; reading a notification decides nothing.
//
// Rendered by app/t/[tenant]/admin/notifications/page.tsx; every call is
// guarded by requireAdmin() on the server, and which rows a role sees is the
// database's decision (RLS).

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { LoginForm, describeFailure } from '@/components/admin-login';
import { fetchRole } from '@/components/tenant-nav';
import { StaffFrame } from '@/components/staff-frame';
import { Icon, type IconName } from '@/components/icons';
import { EmptyState, LOADING, LoadState, failed, type Load } from '@/components/load-state';
import { notify } from '@/components/toast';
import { NOTIFICATIONS_CHANGED, type AttentionItem } from '@/lib/attention';
import type { NavFeatures } from '@/lib/nav-items';
import { isRole, type Role } from '@/lib/permissions';

export interface NotificationsScreenProps {
  slug: string;
  businessName: string;
  logoUrl: string | null;
  nav: NavFeatures;
}

type Auth = 'checking' | 'out' | 'in';

const KIND_ICON: Readonly<Record<AttentionItem['kind'], IconName>> = { request: 'calendar', proof: 'check', change: 'edit' };

/** "14 Oct, 02:41" in this browser's zone: an instant. */
function whenLabel(at: string): string {
  return new Date(at).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

export function NotificationsScreen({ slug, businessName, logoUrl, nav }: NotificationsScreenProps) {
  const api = `/api/t/${slug}`;
  const [auth, setAuth] = useState<Auth>('checking');
  const [role, setRole] = useState<Role | null>(null);
  const [items, setItems] = useState<AttentionItem[] | null>(null);
  const [loadState, setLoadState] = useState<Load>(LOADING);
  const [show, setShow] = useState<'all' | 'unread'>('all');
  const [busy, setBusy] = useState(false);
  const unread = useMemo(() => items?.filter((i) => !i.read).length ?? 0, [items]);
  const shown = useMemo(() => (show === 'unread' ? items?.filter((i) => !i.read) : items) ?? [], [items, show]);

  const unauthorized = useCallback(() => {
    setAuth('out');
    setItems(null);
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
      response = await fetch(`${api}/admin/notifications`, { cache: 'no-store' });
      if (response.status === 401) return unauthorized();
      if (!response.ok) throw new Error('failed');
      const body: { items: AttentionItem[] } = await response.json();
      setItems(body.items);
    } catch (error) {
      setItems(null);
      setLoadState(failed(await describeFailure(error as Error, response)));
    }
  }, [api, unauthorized]);

  useEffect(() => {
    if (auth !== 'in') return;
    void load();
    // A push reached this device: the list grows while it is open.
    const onWorker = (event: MessageEvent) => event.data?.type === 'rag-notification' && void load();
    navigator.serviceWorker?.addEventListener('message', onWorker);
    return () => navigator.serviceWorker?.removeEventListener('message', onWorker);
  }, [auth, load]);

  /** Mark read on the server; the row and the sidebar's badge follow at once. */
  const markRead = useCallback(
    async (ids: number[] | null, quiet: boolean) => {
      setItems((current) => current?.map((i) => (ids === null || ids.includes(i.id) ? { ...i, read: true } : i)) ?? null);
      let response: Response | null = null;
      try {
        // keepalive: a row's link navigates away while this is in flight.
        response = await fetch(`${api}/admin/notifications`, {
          method: 'POST',
          keepalive: true,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(ids === null ? { all: true } : { ids }),
        });
        if (response.status === 401) return unauthorized();
        if (!response.ok) throw new Error('failed');
        const { marked } = (await response.json()) as { marked: number };
        if (!quiet) notify(marked === 1 ? 'Marked 1 notification read.' : `Marked ${marked} notifications read.`, 'ok');
      } catch (failure) {
        if (!quiet) notify(await describeFailure(failure as Error, response), 'error');
        void load();
      } finally {
        window.dispatchEvent(new Event(NOTIFICATIONS_CHANGED));
      }
    },
    [api, load, unauthorized],
  );

  const markAll = useCallback(async () => {
    setBusy(true);
    await markRead(null, false);
    setBusy(false);
  }, [markRead]);

  const logout = useCallback(async () => {
    await fetch(`${api}/admin/session`, { method: 'DELETE' }).catch(() => undefined);
    unauthorized();
  }, [api, unauthorized]);

  const frame = {
    slug,
    businessName,
    logoUrl,
    features: nav,
    current: 'notifications' as const,
    title: 'Notifications',
    session: { auth, role, onLogout: logout },
  };

  if (auth !== 'in') {
    return (
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
    );
  }

  return (
    <StaffFrame
      {...frame}
      actions={
        <button type="button" className="sm" aria-busy={busy || undefined} disabled={busy || unread === 0} onClick={() => void markAll()}>
          <Icon name="check" size={14} /> Mark all read
        </button>
      }
    >
      <section className="card">
        <div className="range-head">
          <div className="segmented" role="group" aria-label="Show">
            <button type="button" aria-pressed={show === 'all'} onClick={() => setShow('all')}>
              All{items ? <span className="segment-count">{items.length}</span> : null}
            </button>
            <button type="button" aria-pressed={show === 'unread'} onClick={() => setShow('unread')}>
              Unread{items ? <span className="segment-count">{unread}</span> : null}
            </button>
          </div>
          <button type="button" className="ghost sm" aria-label="Refresh the list" onClick={() => void load()}>
            <Icon name="refresh" size={16} />
          </button>
        </div>
        <p className="small muted">The last 30 days. Opening one marks it read on all your devices; the request itself is still decided on its own page.</p>

        {items === null ? (
          <LoadState load={loadState} onRetry={() => void load()} what="notifications" />
        ) : shown.length === 0 ? (
          <EmptyState icon="bell" title={show === 'unread' ? 'All read' : 'No notifications yet'}>
            {show === 'unread' ? 'Nothing new since you last looked.' : 'A guest’s booking request, proof of payment or change request will show here.'}
          </EmptyState>
        ) : (
          <ul className="notification-list">
            {shown.map((item) => (
              <li key={item.id} className={item.read ? 'notification' : 'notification unread'}>
                <span className="notification-icon" aria-hidden="true">
                  <Icon name={KIND_ICON[item.kind]} size={18} />
                </span>
                <Link className="notification-text" href={item.path} onClick={() => !item.read && void markRead([item.id], true)}>
                  <span className="notification-title">
                    {item.title}
                    {!item.read && <span className="visually-hidden"> (unread)</span>}
                  </span>
                  <span className="notification-body">{item.body}</span>
                  <span className="notification-when">{whenLabel(item.at)}</span>
                </Link>
                {!item.read && (
                  <button type="button" className="ghost sm" onClick={() => void markRead([item.id], true)}>
                    Mark read
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </StaffFrame>
  );
}
