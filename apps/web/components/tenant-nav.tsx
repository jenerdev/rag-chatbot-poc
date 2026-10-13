'use client';

// The header's links on every tenant page: the public pages, then every staff
// page this member's role may open (lib/nav-items.ts), then Log out.
//
// A staff screen already asks /admin/session for itself, so it passes what it
// learned as `session`, and its own logout, which also clears its data. The
// public pages (chat, book, manage, reset) pass nothing, and the nav asks for itself:
// a visitor with no cookie gets `admin: false` and sees the public links. Since
// plan/public-brand.md "Staff login" is in the public footer, not here: the
// header is the guest's.
//
// Since plan/ui-refresh.md Phase 2 a SIGNED-IN staff page draws its links in
// the sidebar (staff-frame.tsx), so this header is only ever the public one
// or a signed-out staff page's. On a public page it is slim: the page's own
// link is left out, and a signed-in member gets ONE way to the staff side
// (their first staff page, the dashboard) instead of every staff link.

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { Icon } from './icons';
import { navItems, type NavFeatures, type NavPage } from '@/lib/nav-items';
import { isRole, type Role } from '@/lib/permissions';

export type SessionState = 'checking' | 'out' | 'in';

/** The role of this browser's session for the tenant, or null. The login route answers only "admin: true", so screens call this after a login too. */
export async function fetchRole(api: string): Promise<Role | null> {
  try {
    const body = await (await fetch(`${api}/admin/session`)).json();
    return body.admin === true && isRole(body.role) ? body.role : null;
  } catch {
    return null;
  }
}

export function TenantNav({
  slug,
  features,
  current,
  session,
}: {
  slug: string;
  features: NavFeatures;
  current: NavPage;
  session?: { auth: SessionState; role: Role | null; onLogout: () => void };
}) {
  const api = `/api/t/${slug}`;
  const [own, setOwn] = useState<{ auth: SessionState; role: Role | null }>({ auth: 'checking', role: null });

  useEffect(() => {
    if (session) return;
    void fetchRole(api).then((role) => setOwn({ auth: role ? 'in' : 'out', role }));
  }, [api, session]);

  const ownLogout = useCallback(async () => {
    await fetch(`${api}/admin/session`, { method: 'DELETE' }).catch(() => undefined);
    setOwn({ auth: 'out', role: null });
  }, [api]);

  const auth = session?.auth ?? own.auth;
  const role = auth === 'in' ? (session?.role ?? own.role) : null;
  const logout = session?.onLogout ?? ownLogout;
  const publicPage = current === 'chat' || current === 'book' || current === 'manage' || current === 'reset';

  const all = navItems(slug, features, role);
  const isPublic = (page: NavPage) => page === 'chat' || page === 'book';
  // No "Book" button in the header (the user, 2026-10-14: redundant). The
  // chat's welcome card offers "Book your stay", the booking page is
  // itself, and Manage booking's footer has "Book a stay".
  const shown = (publicPage ? all.filter((item) => isPublic(item.page) && item.page !== current) : all).filter((item) => item.page !== 'book');
  const staffHome = publicPage ? all.find((item) => !isPublic(item.page)) : undefined;

  return (
    <>
      {shown.map((item) => (
        <Link
          key={item.page}
          className={item.primary ? 'button primary' : 'button'}
          href={item.href}
          aria-current={item.page === current ? 'page' : undefined}
        >
          {item.label}
        </Link>
      ))}
      {staffHome && (
        <Link className="button" href={staffHome.href}>
          <Icon name="chart" size={16} />
          <span className="narrow-hidden">{staffHome.label}</span>
        </Link>
      )}
      {auth === 'in' && (
        <button type="button" className="link" onClick={logout}>
          Log out
        </button>
      )}
    </>
  );
}
