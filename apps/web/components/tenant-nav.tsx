'use client';

// The header's links on every tenant page: the public pages, then every staff
// page this member's role may open (lib/nav-items.ts), then Log out.
//
// A staff screen already asks /admin/session for itself, so it passes what it
// learned as `session`, and its own logout, which also clears its data. The
// public pages (chat, book, reset) pass nothing, and the nav asks for itself:
// a visitor with no cookie gets `admin: false` and sees the public links and
// "Staff login".

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
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
  // A staff page shows its own login form when logged out, so "Staff login"
  // is offered only from the public pages.
  const publicPage = current === 'chat' || current === 'book' || current === 'reset';

  return (
    <>
      {navItems(slug, features, role).map((item) => (
        <Link
          key={item.page}
          className={item.primary ? 'button primary' : 'button'}
          href={item.href}
          aria-current={item.page === current ? 'page' : undefined}
        >
          {item.label}
        </Link>
      ))}
      {auth === 'out' && publicPage && (
        <Link className="button" href={`/t/${slug}/admin`}>
          Staff login
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
