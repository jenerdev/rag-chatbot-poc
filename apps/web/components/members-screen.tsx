'use client';

import Link from 'next/link';
// S-8, the tenant's Members screen (plan/tenant-management.md § 4.3): for
// OWNERS. The page holds nothing; the browser proves its session first, and
// the route behind every action asks `members:manage` again.

import { useCallback, useEffect, useState } from 'react';
import { LoginForm } from '@/components/admin-login';
import { MembersPanel } from '@/components/members-panel';
import { StaffFrame } from '@/components/staff-frame';
import type { NavFeatures } from '@/lib/nav-items';
import { ROLE_LABELS, can, isRole, type Role } from '@/lib/permissions';

type Auth = 'checking' | 'out' | 'in';

export function MembersScreen({
  slug,
  businessName,
  logoUrl,
  nav,
}: {
  slug: string;
  businessName: string;
  logoUrl: string | null;
  nav: NavFeatures;
}) {
  const api = `/api/t/${slug}`;
  const [auth, setAuth] = useState<Auth>('checking');
  const [role, setRole] = useState<Role | null>(null);

  const askSession = useCallback(async () => {
    try {
      const response = await fetch(`${api}/admin/session`);
      const body = await response.json();
      setAuth(body.admin === true ? 'in' : 'out');
      setRole(isRole(body.role) ? body.role : null);
    } catch {
      setAuth('out');
    }
  }, [api]);

  useEffect(() => {
    void askSession();
  }, [askSession]);

  const unauthorized = useCallback(() => {
    setAuth('out');
    setRole(null);
  }, []);

  const logout = useCallback(async () => {
    await fetch(`${api}/admin/session`, { method: 'DELETE' }).catch(() => undefined);
    unauthorized();
  }, [api, unauthorized]);

  const frame = { slug, businessName, logoUrl, features: nav, current: 'members' as const, title: 'Members', session: { auth, role, onLogout: logout } };

  if (auth !== 'in') {
    return (
      <>
        <StaffFrame {...frame}>
          {auth === 'checking' ? (
            <div className="small muted">Checking your session…</div>
          ) : (
            <LoginForm api={api} slug={slug} onLoggedIn={() => void askSession()} />
          )}
        </StaffFrame>
      </>
    );
  }

  if (!role || !can(role, 'members:manage', nav.access)) {
    return (
      <>
        <StaffFrame {...frame}>
          <section className="card">
            <p className="small muted">
              Members are managed by an owner. You are {role ? ROLE_LABELS[role].toLowerCase() : 'a member'} here.
            </p>
          </section>
        </StaffFrame>
      </>
    );
  }

  return (
    <>
      <StaffFrame {...frame}>
        <MembersPanel api={`${api}/members`} onUnauthorized={unauthorized} />
        {/* D-138: what members did is a filter away. */}
        {can(role, 'activity:read', nav.access) && (
          <p className="small muted members-activity-link">
            <Link href={`/t/${slug}/admin/activity?area=members`}>See what members did</Link>
          </p>
        )}
      </StaffFrame>
    </>
  );
}
