'use client';

// S-18 · Activity (plan/audit-log.md, D-138): who did what in this
// workspace, for a role with activity:read (owners by default). The list
// itself is activity-list.tsx, shared with the platform's Activity tab;
// this screen is the staff frame around it: the session check, the login
// form, the filters from the URL.
//
// Rendered by app/t/[tenant]/admin/activity/page.tsx, which holds no data.
// The one route is requireAdmin(…, 'activity:read'); the SQL function
// refuses the wrong caller again (plan Rule 4). A member whose role lacks
// the permission sees one sentence, as the Members screen does.

import { useCallback, useEffect, useState } from 'react';
import { LoginForm } from '@/components/admin-login';
import { fetchRole } from '@/components/tenant-nav';
import { StaffFrame } from '@/components/staff-frame';
import { ActivityList } from '@/components/activity-list';
import type { ActivityFilters } from '@/lib/activity-words';
import type { NavFeatures } from '@/lib/nav-items';
import { ROLE_LABELS, can, isRole, type Role } from '@/lib/permissions';

export interface ActivityScreenProps {
  slug: string;
  businessName: string;
  logoUrl: string | null;
  nav: NavFeatures;
  /** The filters the URL arrived with (lib/activity-words.ts). */
  initial: ActivityFilters;
}

type Auth = 'checking' | 'out' | 'in';

export function ActivityScreen({ slug, businessName, logoUrl, nav, initial }: ActivityScreenProps) {
  const api = `/api/t/${slug}`;
  const [auth, setAuth] = useState<Auth>('checking');
  const [role, setRole] = useState<Role | null>(null);

  const unauthorized = useCallback(() => setAuth('out'), []);

  useEffect(() => {
    void (async () => {
      try {
        const body = await (await fetch(`${api}/admin/session`)).json();
        setAuth(body.admin === true ? 'in' : 'out');
        setRole(isRole(body.role) ? body.role : null);
      } catch {
        setAuth('out');
      }
    })();
  }, [api]);

  const logout = useCallback(async () => {
    await fetch(`${api}/admin/session`, { method: 'DELETE' }).catch(() => undefined);
    unauthorized();
  }, [api, unauthorized]);

  const frame = { slug, businessName, logoUrl, features: nav, current: 'activity' as const, title: 'Activity', session: { auth, role, onLogout: logout } };

  if (auth !== 'in') {
    return (
      <StaffFrame {...frame}>
        {auth === 'checking' ? (
          null
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

  // The courtesy (the route and Postgres are the guard): one sentence for a role without the permission.
  if (!role || !can(role, 'activity:read', nav.access)) {
    return (
      <StaffFrame {...frame}>
        <section className="card">
          <p className="small muted">The activity log is read by an owner. You are {role ? ROLE_LABELS[role].toLowerCase() : 'a member'} here.</p>
        </section>
      </StaffFrame>
    );
  }

  return (
    <StaffFrame {...frame}>
      <section className="card">
        <ActivityList api={`${api}/admin/activity`} slug={slug} initial={initial} syncUrl onUnauthorized={unauthorized} retentionDays={null} />
      </section>
    </StaffFrame>
  );
}
