import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { CONFIGURABLE_PERMISSIONS, GRANTABLE_PERMISSIONS, NOTIFY_PERMISSION, PERMISSIONS, PERMISSION_LABELS, ROLES, ROLE_PERMISSIONS, can, isRole, overridesFrom, type Permission, type Role } from './permissions';
import { COLOUR, parseTheme, themeVars } from './theme';

// The two walls must agree (plan/tenant-management.md Rule 2, § 3.2). This
// is the DATABASE's view of the table, written by hand from
// sql/schema-roles.sql: which helper each permission's policy asks, and so
// which roles Postgres lets through. If a permission moves between roles in
// permissions.ts, this test fails until the policy (and this list) move too.
const ADMIN_ONLY: Role[] = ['owner', 'admin']; // app_is_admin()
const ANY_MEMBER: Role[] = ['owner', 'admin', 'staff']; // app_is_staff()
const OWNER_ONLY: Role[] = ['owner']; // memberships_owner_* policies
const POSTGRES: Record<Permission, Role[]> = {
  session: ANY_MEMBER, // memberships_read_own: any member sees its own row
  'dashboard:read': ANY_MEMBER, // tenant_dashboard() refuses unless app_is_staff(); money null unless app_is_admin() (schema-dashboard.sql)
  'documents:read': ANY_MEMBER, // documents_read: tenant match only
  'documents:write': ADMIN_ONLY, // documents_insert / documents_delete / chunks_insert
  'bookings:read': ANY_MEMBER, // bookings_read → app_is_staff() (schema-roles § 3)
  'bookings:write': ANY_MEMBER, // bookings_insert / bookings_update → app_is_staff()
  'rooms:read': ADMIN_ONLY, // units_read is any token; the SCREEN is admin-only, so the route is too
  'rooms:write': ADMIN_ONLY, // units_insert/update, unit_rates_*, unit_images_*, storage.objects
  'holidays:read': ADMIN_ONLY, // rate_calendar_read is any token; the screen is admin-only
  'holidays:write': ADMIN_ONLY, // rate_calendar_insert/update/delete
  'slots:read': ADMIN_ONLY, // slots_read is any token; the screen is admin-only (it counts bookings)
  'slots:write': ADMIN_ONLY, // slots_insert/update/delete (schema-slots.sql)
  'promos:read': ADMIN_ONLY, // promos_select is any MEMBER (the staff form lists them); the SCREEN is admin-only, so the route is too
  'promos:write': ADMIN_ONLY, // promos_insert/update/delete → app_is_admin() (schema-promos.sql)
  'payments:read': ANY_MEMBER, // payments_read / stays_read / booking_events_read → app_is_staff() (schema-manage-booking.sql)
  'payments:write': ADMIN_ONLY, // review_payment() / record_refund() refuse unless app_is_admin()
  'payments:settings': ADMIN_ONLY, // set_payment_settings() refuses unless app_is_admin()
  'unanswered:read': ANY_MEMBER, // unanswered_resolutions_read → app_is_staff()
  'unanswered:write': ANY_MEMBER, // unanswered_resolutions_insert/delete → app_is_staff()
  'conversations:read': ANY_MEMBER, // conversation_list() refuses unless app_is_staff() (schema-conversations.sql)
  'members:manage': OWNER_ONLY, // memberships_owner_insert/update/delete
  'activity:read': OWNER_ONLY, // audit_log_read → app_can('activity:read'); activity_list() asks it again (schema-audit-log.sql)
  'sources:read': ADMIN_ONLY, // no policy: app_default_can() alone; the chat route strips the chunks for anyone else (D-140)
};

describe('permissions: the code view matches the Postgres view', () => {
  for (const permission of PERMISSIONS) {
    it(permission, () => {
      const codeSays = ROLES.filter((role) => can(role, permission)).sort();
      expect(codeSays).toEqual([...POSTGRES[permission]].sort());
    });
  }

  it('every role has "session", and roles only ever ADD permissions upward', () => {
    for (const role of ROLES) expect(can(role, 'session')).toBe(true);
    for (const p of ROLE_PERMISSIONS.staff) expect(ROLE_PERMISSIONS.admin).toContain(p);
    for (const p of ROLE_PERMISSIONS.admin) expect(ROLE_PERMISSIONS.owner).toContain(p);
  });

  it('isRole trusts only the three names', () => {
    expect(isRole('owner')).toBe(true);
    expect(isRole('super')).toBe(false);
    expect(isRole(undefined)).toBe(false);
  });
});

describe('theme', () => {
  it('the regex is #rgb or #rrggbb and nothing else', () => {
    for (const ok of ['#fff', '#0f766e', '#ABCDEF']) expect(COLOUR.test(ok)).toBe(true);
    for (const bad of ['fff', '#ffff', '#0f766e;', 'url(x)', 'var(--x)', '#0f766e ', 'red']) expect(COLOUR.test(bad)).toBe(false);
  });

  it('themeVars keeps known keys with valid colours and drops the rest', () => {
    expect(themeVars({ accent: '#0f766e', bg: 'url(x)', font: 'Comic Sans' })).toEqual({ '--accent': '#0f766e' });
    expect(themeVars(null)).toEqual({});
    expect(themeVars('#fff')).toEqual({});
  });

  it('parseTheme reports each problem and treats an emptied field as the default', () => {
    const { theme, problems } = parseTheme({ accent: '#0f766e', bg: '', ink: 'blue', font: 'x' });
    expect(theme).toEqual({ accent: '#0f766e' });
    expect(problems).toEqual(['Text must be a colour like #0f766e or #fff.', 'Unknown theme key "font".']);
  });
});

describe('NOTIFY_PERMISSION', () => {
  // notify_claim() in SQL decides who hears each kind (Rule 3). Read its
  // body and compare: request and change go to every role, a proof to the
  // roles the function names. If either side moves, this fails.
  const sql = readFileSync(new URL('../../../packages/db/sql/schema-notifications.sql', import.meta.url), 'utf8');
  const claim = sql.slice(sql.indexOf('create or replace function public.notify_claim'), sql.indexOf('create or replace function public.notify_done'));

  it('sends a proof to exactly the roles notify_claim() names', () => {
    const named = /o\.kind = 'proof' and m\.role in \(([^)]*)\)/.exec(claim)?.[1] ?? '';
    const sqlRoles = [...named.matchAll(/'(\w+)'/g)].map((m) => m[1]).sort();
    expect(sqlRoles).toEqual(ROLES.filter((r) => can(r, NOTIFY_PERMISSION.proof)).sort());
  });

  it('sends a request and a change to every role, as notify_claim() does', () => {
    expect(claim).toContain("o.kind in ('request', 'change')");
    expect(ROLES.filter((r) => can(r, NOTIFY_PERMISSION.request))).toEqual([...ROLES]);
    expect(ROLES.filter((r) => can(r, NOTIFY_PERMISSION.change))).toEqual([...ROLES]);
  });
});

describe('per-tenant role permissions (D-128): the code and app_can() agree', () => {
  const sql = readFileSync(new URL('../../../packages/db/sql/schema-role-permissions.sql', import.meta.url), 'utf8');
  const between = (from: string, to: string) => sql.slice(sql.indexOf(from), sql.indexOf(to, sql.indexOf(from)));
  const quoted = (text: string) => [...text.matchAll(/'([a-z]+:[a-z]+)'/g)].map((m) => m[1]);

  it("app_default_can()'s matrix is ROLE_PERMISSIONS, pair for pair", () => {
    const body = between('function public.app_default_can', '$$;');
    const pairs = [...body.matchAll(/\('(owner|admin|staff)', '([a-z]+:[a-z]+|session)'\)/g)].map((m) => `${m[1]} ${m[2]}`).sort();
    const code = ROLES.flatMap((role) => ROLE_PERMISSIONS[role].map((p) => `${role} ${p}`)).sort();
    expect(pairs).toEqual(code);
  });

  it('the configurable check and the grantable list are the code lists', () => {
    expect(quoted(between('role_permissions_configurable check', '));')).sort()).toEqual([...CONFIGURABLE_PERMISSIONS].sort());
    expect(quoted(between('function public.app_permission_grantable', '$$;')).sort()).toEqual([...GRANTABLE_PERMISSIONS].sort());
    for (const p of GRANTABLE_PERMISSIONS) expect(CONFIGURABLE_PERMISSIONS).toContain(p);
    for (const fixed of ['session', 'payments:write', 'payments:settings'] as const) expect(CONFIGURABLE_PERMISSIONS).not.toContain(fixed);
  });

  it('a row takes a configurable permission away, and grants only a grantable one', () => {
    const o = overridesFrom([
      { role: 'owner', permission: 'documents:write', allowed: false },
      { role: 'staff', permission: 'promos:write', allowed: true },
      { role: 'staff', permission: 'members:manage', allowed: true }, // not grantable
      { role: 'admin', permission: 'payments:write', allowed: false }, // fixed
      { role: 'super', permission: 'documents:write', allowed: true }, // no such role
    ]);
    expect(can('owner', 'documents:write', o)).toBe(false);
    expect(can('owner', 'documents:read', o)).toBe(true);
    expect(can('staff', 'promos:write', o)).toBe(true);
    expect(can('staff', 'members:manage', o)).toBe(false);
    expect(can('admin', 'payments:write', o)).toBe(true);
    expect(can('admin', 'documents:write', o)).toBe(true);
    expect(can('owner', 'documents:write')).toBe(true);
  });

  it('every permission has a label', () => {
    for (const p of PERMISSIONS) expect(PERMISSION_LABELS[p].label.length).toBeGreaterThan(0);
  });
});

