import { describe, expect, it } from 'vitest';
import { PERMISSIONS, ROLES, ROLE_PERMISSIONS, can, isRole, type Permission, type Role } from './permissions';
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
  'unanswered:read': ANY_MEMBER, // unanswered_resolutions_read → app_is_staff()
  'unanswered:write': ANY_MEMBER, // unanswered_resolutions_insert/delete → app_is_staff()
  'members:manage': OWNER_ONLY, // memberships_owner_insert/update/delete
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
