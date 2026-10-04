// permissions.ts — what each role may do, in ONE table (plan/tenant-management.md § 3.2).
//
// Pure: no imports, no I/O, no `server-only`, so a Client Component may import
// it to hide what a role cannot do, and every Route Handler imports it to
// REFUSE what a role cannot do. The screen is a courtesy; the route is the
// guard; and behind the route, Postgres asks the same role again through
// app_is_admin() and app_is_staff() (sql/schema-roles.sql § 2). Two walls.
//
// The role itself is never in here or in a token. It is a `memberships` row,
// read on every request by staffClient() (plan Rule 4), and handed to
// requireAdmin(), which looks the permission up below.
//
// The DATABASE's view of this table is two functions, and they must agree:
//   app_is_admin()  = owner | admin  → every *:write except bookings and unanswered,
//                                       and the rooms, holidays and slots reads
//   app_is_staff()  = any member     → bookings, unanswered, session, every other read
// permissions.test.ts pins the two views to each other, by hand, permission
// by permission. A permission only one wall knows about is a bug (plan Rule 2).

export const ROLES = ['owner', 'admin', 'staff'] as const;
export type Role = (typeof ROLES)[number];

export const PERMISSIONS = [
  /** GET /admin/session: any member may ask "am I logged in, and as what?" */
  'session',
  'documents:read',
  'documents:write',
  'bookings:read',
  /** create, cancel, confirm and decline: the daily work, so staff too */
  'bookings:write',
  /** S-5, rooms, rates and photos: the read is admin-only too, because the screen is */
  'rooms:read',
  'rooms:write',
  /** S-7, the holiday calendar */
  'holidays:read',
  'holidays:write',
  /** the Slots screen (D-090): create, edit, retire and delete booking slots */
  'slots:read',
  'slots:write',
  /** the Promos screen (D-097): discounts, their codes and limits; the read is admin-only because the screen is */
  'promos:read',
  'promos:write',
  'unanswered:read',
  /** resolve and reopen */
  'unanswered:write',
  /** the Members screen: list, add an existing account, change a role, remove */
  'members:manage',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const STAFF: readonly Permission[] = ['session', 'documents:read', 'bookings:read', 'bookings:write', 'unanswered:read', 'unanswered:write'];
const ADMIN: readonly Permission[] = [...STAFF, 'documents:write', 'rooms:read', 'rooms:write', 'holidays:read', 'holidays:write', 'slots:read', 'slots:write', 'promos:read', 'promos:write'];
const OWNER: readonly Permission[] = [...ADMIN, 'members:manage'];

export const ROLE_PERMISSIONS: Readonly<Record<Role, readonly Permission[]>> = {
  staff: STAFF,
  admin: ADMIN,
  owner: OWNER,
};

/** May this role do that? The one question every guard and every screen asks. */
export function can(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}

/** Is this string one of the three roles? For the session response, which the browser must not trust blindly. */
export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}

/** How a role is shown to people (plan § 8 q1). */
export const ROLE_LABELS: Readonly<Record<Role, string>> = { owner: 'Owner', admin: 'Admin', staff: 'Staff' };
