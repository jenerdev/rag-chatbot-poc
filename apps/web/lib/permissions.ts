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
//   app_is_staff()  = any member     → bookings, unanswered, conversations, session, every other read
// permissions.test.ts pins the two views to each other, by hand, permission
// by permission. A permission only one wall knows about is a bug (plan Rule 2).

export const ROLES = ['owner', 'admin', 'staff'] as const;
export type Role = (typeof ROLES)[number];

export const PERMISSIONS = [
  /** GET /admin/session: any member may ask "am I logged in, and as what?" */
  'session',
  /** the Dashboard (D-098): any member; tenant_dashboard() itself withholds money from a staff role */
  'dashboard:read',
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
  /** S-14 Payments: the proof queue, a proof's signed URL, a stay's history. Any member reads */
  'payments:read',
  /** verify, reject, record a refund (§ 9 q4: owners and admins; review_payment() asks again) */
  'payments:write',
  /** the Payments screen's Settings tab: ways to pay, the fee, the terms */
  'payments:settings',
  'unanswered:read',
  /** resolve and reopen */
  'unanswered:write',
  /** S-16 Conversations (D-115): every chat's transcript; any member, like Unanswered (§ 7 q1); conversation_list() asks app_is_staff() again */
  'conversations:read',
  /** the Members screen: list, add an existing account, change a role, remove */
  'members:manage',
  /** S-18 Activity (D-138): who did what; owners by default, grantable to admins; activity_list() and the audit_log policy ask app_can() again */
  'activity:read',
  /** the chat's sources panel (D-140): the chunks a reply was built from, for a signed-in owner or admin; grantable to staff. The chat route strips them for anyone else; no table policy asks it */
  'sources:read',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const STAFF: readonly Permission[] = ['session', 'dashboard:read', 'documents:read', 'bookings:read', 'bookings:write', 'payments:read', 'unanswered:read', 'unanswered:write', 'conversations:read'];
const ADMIN: readonly Permission[] = [...STAFF, 'documents:write', 'rooms:read', 'rooms:write', 'holidays:read', 'holidays:write', 'slots:read', 'slots:write', 'promos:read', 'promos:write', 'payments:write', 'payments:settings', 'sources:read'];
const OWNER: readonly Permission[] = [...ADMIN, 'members:manage', 'activity:read'];

export const ROLE_PERMISSIONS: Readonly<Record<Role, readonly Permission[]>> = {
  staff: STAFF,
  admin: ADMIN,
  owner: OWNER,
};

/**
 * D-128: a tenant may differ from the table above, set by a super user on
 * the platform page (sql/schema-role-permissions.sql, `role_permissions`).
 *
 *   CONFIGURABLE  a role may LOSE any of these, per tenant;
 *   GRANTABLE     and may GAIN these beyond the default: their every write is
 *                 a plain table policy, which the tenant's row reaches;
 *   the rest      (session, payments:write, payments:settings) are FIXED:
 *                 they are asked inside SQL functions a row cannot reach.
 *
 * app_can() in SQL computes exactly what can() below computes from the same
 * rows; permissions.test.ts reads that file and checks both lists and the
 * default matrix against these.
 */
export const CONFIGURABLE_PERMISSIONS: readonly Permission[] = [
  'dashboard:read', 'documents:read', 'documents:write', 'bookings:read', 'bookings:write',
  'rooms:read', 'rooms:write', 'holidays:read', 'holidays:write', 'slots:read', 'slots:write',
  'promos:read', 'promos:write', 'payments:read', 'unanswered:read', 'unanswered:write',
  'conversations:read', 'members:manage', 'activity:read', 'sources:read',
];
export const GRANTABLE_PERMISSIONS: readonly Permission[] = [
  'documents:write', 'rooms:read', 'rooms:write', 'holidays:read', 'holidays:write', 'slots:read', 'slots:write', 'promos:read', 'promos:write', 'activity:read', 'sources:read',
];

/** A tenant's rows: role → permission → allowed. Absent = the default. */
export type RoleOverrides = Readonly<Partial<Record<Role, Readonly<Partial<Record<Permission, boolean>>>>>>;

/** The role's default, from the one table above. */
export function canByDefault(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}

/**
 * May this role do that, in this tenant? The one question every guard and
 * every screen asks. Without `overrides`, the default. With them: a
 * configurable permission the role has may be taken away, and a grantable
 * one it lacks may be given; anything else is the default.
 */
export function can(role: Role, permission: Permission, overrides?: RoleOverrides | null): boolean {
  const byDefault = canByDefault(role, permission);
  const row = overrides?.[role]?.[permission];
  if (row === undefined || !CONFIGURABLE_PERMISSIONS.includes(permission)) return byDefault;
  if (byDefault) return row;
  return GRANTABLE_PERMISSIONS.includes(permission) ? row : false;
}

/** The rows as they come from the database, as overrides. Unknown roles and permissions are dropped. */
export function overridesFrom(rows: readonly { role: string; permission: string; allowed: boolean }[]): RoleOverrides {
  const out: Partial<Record<Role, Partial<Record<Permission, boolean>>>> = {};
  for (const r of rows) {
    if (!isRole(r.role) || !(PERMISSIONS as readonly string[]).includes(r.permission)) continue;
    (out[r.role] ??= {})[r.permission as Permission] = r.allowed;
  }
  return out;
}

/** What the platform's Permissions tab shows for each configurable permission (D-128). */
export const PERMISSION_LABELS: Readonly<Record<Permission, { area: string; label: string }>> = {
  session: { area: 'Account', label: 'Sign in' },
  'dashboard:read': { area: 'Overview', label: 'See the dashboard' },
  'documents:read': { area: 'Knowledge base', label: 'See the documents' },
  'documents:write': { area: 'Knowledge base', label: 'Add, edit and delete documents' },
  'bookings:read': { area: 'Bookings', label: 'See bookings, the calendar and notifications' },
  'bookings:write': { area: 'Bookings', label: 'Create, confirm, decline and cancel bookings' },
  'rooms:read': { area: 'Setup', label: 'See rooms and rates' },
  'rooms:write': { area: 'Setup', label: 'Change rooms, rates and photos' },
  'holidays:read': { area: 'Setup', label: 'See the holiday calendar' },
  'holidays:write': { area: 'Setup', label: 'Change holidays and closed dates' },
  'slots:read': { area: 'Setup', label: 'See slots' },
  'slots:write': { area: 'Setup', label: 'Change slots' },
  'promos:read': { area: 'Setup', label: 'See promos' },
  'promos:write': { area: 'Setup', label: 'Change promos' },
  'payments:read': { area: 'Payments', label: 'See payments and proofs' },
  'payments:write': { area: 'Payments', label: 'Verify and reject proofs, record refunds' },
  'payments:settings': { area: 'Payments', label: 'Change ways to pay and terms' },
  'unanswered:read': { area: 'Assistant', label: 'See unanswered questions' },
  'unanswered:write': { area: 'Assistant', label: 'Resolve and reopen them' },
  'conversations:read': { area: 'Assistant', label: 'Read conversations' },
  'sources:read': { area: 'Assistant', label: 'See the sources behind a reply in the chat' },
  'members:manage': { area: 'Members', label: 'Add, change and remove members' },
  'activity:read': { area: 'Members', label: 'See the activity log' },
};

/**
 * Who a push of each kind reaches (plan/notifications.md Rule 3): the
 * permission a member needs to ACT on it. notify_claim() asks the same in
 * SQL, from the membership row at send time; permissions.test.ts reads that
 * function and checks the two agree.
 */
export const NOTIFY_PERMISSION = { request: 'bookings:write', change: 'bookings:write', proof: 'payments:write' } as const satisfies Record<string, Permission>;

/** Is this string one of the three roles? For the session response, which the browser must not trust blindly. */
export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}

/** How a role is shown to people (plan § 8 q1). */
export const ROLE_LABELS: Readonly<Record<Role, string>> = { owner: 'Owner', admin: 'Admin', staff: 'Staff' };
