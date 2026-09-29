'use client';

// S-8, the tenant's Members screen (plan/tenant-management.md § 4.3): for
// OWNERS. The page holds nothing; the browser proves its session first, and
// the route behind every action asks `members:manage` again.

import { useCallback, useEffect, useState } from 'react';
import { LoginForm } from '@/components/admin-login';
import { BrandHeader } from '@/components/brand-header';
import { MembersPanel } from '@/components/members-panel';
import { TenantNav } from '@/components/tenant-nav';
import type { NavFeatures } from '@/lib/nav-items';
import { ROLE_LABELS, can, isRole, type Role } from '@/lib/permissions';

type Auth = 'checking' | 'out' | 'in';

export function MembersScreen({
  slug,
  businessName,
  logoUrl,
  bannerUrl,
  nav,
}: {
  slug: string;
  businessName: string;
  logoUrl: string | null;
  bannerUrl: string | null;
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

  const header = (
    <BrandHeader businessName={businessName} logoUrl={logoUrl} bannerUrl={bannerUrl} subtitle="Members">
      <TenantNav slug={slug} features={nav} current="members" session={{ auth, role, onLogout: logout }} />
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
            <LoginForm api={api} slug={slug} onLoggedIn={() => void askSession()} />
          )}
        </main>
      </>
    );
  }

  if (!role || !can(role, 'members:manage')) {
    return (
      <>
        {header}
        <main>
          <section className="card">
            <p className="small muted">
              Members are managed by an owner. You are {role ? ROLE_LABELS[role].toLowerCase() : 'a member'} here.
            </p>
          </section>
        </main>
      </>
    );
  }

  return (
    <>
      {header}
      <main>
        <MembersPanel api={`${api}/members`} onUnauthorized={unauthorized} />
      </main>
    </>
  );
}
