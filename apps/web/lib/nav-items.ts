// nav-items.ts — which pages the header offers, for which tenant and which role.
//
// Pure, like permissions.ts, so the Client Component that draws the header
// can import it. A button shown here is a courtesy: every page behind it
// still 404s for a tenant without the feature, and every route behind the
// page still asks requireAdmin() for the permission named below. Hiding a
// button is never the guard.

import type { Attention } from './attention';
import type { FeatureFlags } from './features';
import { can, type Role, type RoleOverrides } from './permissions';

/**
 * What the TENANT has, worked out on the server (lib/nav.ts) and passed down
 * as plain props. The same conditions the pages themselves 404 on, so a
 * button never leads to "No such workspace".
 */
export interface NavFeatures {
  /** the bookings application: S-3 Bookings and S-7 Holidays */
  bookings: boolean;
  /** bookings, per_room: S-5 Rooms */
  rooms: boolean;
  /** bookings, a priced unit and the booking_page feature: S-6, the public booking page */
  book: boolean;
  /** bookings and the manage_booking feature: S-13, Manage booking */
  manage: boolean;
  /** the tenant's feature flags (D-127, lib/features.ts): a switched-off screen has no link */
  flags: FeatureFlags;
  /** the tenant's role permissions where they differ from the default (D-128); {} = the default */
  access: RoleOverrides;
}

export type NavPage = 'chat' | 'book' | 'manage' | 'payments' | 'dashboard' | 'notifications' | 'documents' | 'unanswered' | 'conversations' | 'bookings' | 'calendar' | 'rooms' | 'holidays' | 'slots' | 'promos' | 'members' | 'reset';

export interface NavItem {
  page: NavPage;
  label: string;
  href: string;
  primary?: boolean;
  /** Notifications only (plan/notifications.md § 8): what this member has not read */
  badge?: number;
}

/**
 * The header's links, in order: the public pages first, then every staff
 * page this role may open. `role` null means "not logged in" (or not yet
 * known): the public pages only.
 */
export function navItems(slug: string, features: NavFeatures, role: Role | null, attention?: Attention | null): NavItem[] {
  const base = `/t/${slug}`;
  const items: NavItem[] = [{ page: 'chat', label: 'Chat', href: base }];
  if (features.book) items.push({ page: 'book', label: 'Book', href: `${base}/book`, primary: true });
  if (role === null) return items;

  // Each staff page with the permission its screen's first read needs, in
  // the order the sidebar shows them (plan/nav-layout.md): the daily work
  // first, then the chat assistant, then what is set up once.
  const staff: [NavPage, string, string, boolean][] = [
    // First (plan/dashboard.md § 7 q1): the page to land on; /admin redirects here.
    ['dashboard', 'Dashboard', '/admin/dashboard', features.flags.dashboard && can(role, 'dashboard:read', features.access)],
    // S-17 (plan/notifications.md § 8): what arrived, read or not; the ONE badge. The top bar's bell.
    ['notifications', 'Notifications', '/admin/notifications', features.bookings && features.flags.notifications && can(role, 'bookings:read', features.access)],
    ['bookings', 'Bookings', '/admin/bookings', features.bookings && can(role, 'bookings:read', features.access)],
    // S-12 (plan/calendar.md, D-103): a view of the same bookings, so the same permission.
    ['calendar', 'Calendar', '/admin/calendar', features.bookings && features.flags.calendar && can(role, 'bookings:read', features.access)],
    // S-14 (plan/manage-booking.md): proofs to verify, refunds, the payment settings.
    ['payments', 'Payments', '/admin/payments', features.bookings && can(role, 'payments:read', features.access)],
    // S-16 (plan/conversations.md, D-115): every chat, every tenant.
    ['conversations', 'Conversations', '/admin/conversations', features.flags.conversations && can(role, 'conversations:read', features.access)],
    ['unanswered', 'Unanswered', '/admin/unanswered', features.flags.unanswered && can(role, 'unanswered:read', features.access)],
    ['documents', 'Knowledge base', '/admin/documents', can(role, 'documents:read', features.access)],
    ['rooms', 'Rooms', '/admin/accommodations', features.rooms && can(role, 'rooms:read', features.access)],
    ['slots', 'Slots', '/admin/slots', features.bookings && can(role, 'slots:read', features.access)],
    ['holidays', 'Holidays', '/admin/holidays', features.bookings && can(role, 'holidays:read', features.access)],
    ['promos', 'Promos', '/admin/promos', features.bookings && can(role, 'promos:read', features.access)],
    ['members', 'Members', '/admin/members', can(role, 'members:manage', features.access)],
  ];
  // What this member has not read, on Notifications alone; a zero is no badge.
  for (const [page, label, path, allowed] of staff) {
    if (!allowed) continue;
    const badge = page === 'notifications' ? attention?.unread : undefined;
    items.push(badge ? { page, label, href: `${base}${path}`, badge } : { page, label, href: `${base}${path}` });
  }
  return items;
}

/**
 * The sidebar's sections (plan/nav-layout.md, which regrouped
 * plan/ui-refresh.md Phase 2's), by what staff are doing:
 *   Overview    where a day starts
 *   Front desk  the daily work on stays: the list, the calendar, the money
 *   Assistant   the chatbot: what guests asked, what it could not answer,
 *               and the documents it answers from
 *   Setup       set up once, changed rarely (owners and admins only)
 */
export type NavGroup = 'Overview' | 'Front desk' | 'Assistant' | 'Setup';

const GROUP_OF: Readonly<Partial<Record<NavPage, NavGroup>>> = {
  dashboard: 'Overview',
  bookings: 'Front desk',
  calendar: 'Front desk',
  payments: 'Front desk',
  conversations: 'Assistant',
  unanswered: 'Assistant',
  documents: 'Assistant',
  rooms: 'Setup',
  slots: 'Setup',
  holidays: 'Setup',
  promos: 'Setup',
  members: 'Setup',
};
const GROUP_ORDER: readonly NavGroup[] = ['Overview', 'Front desk', 'Assistant', 'Setup'];

/** In the top bar, not the sidebar: the bell (it carries the ONE badge). */
const TOP_PAGES: readonly NavPage[] = ['notifications'];

/**
 * navItems()'s links, placed: the staff pages sectioned for the sidebar;
 * the bell for the top bar; the public pages (Chat, Book) for the account
 * menu. A presentation of the SAME list: which links exist is still
 * navItems()'s decision alone, and an empty section is left out.
 */
export function groupNavItems(items: NavItem[]): { groups: { group: NavGroup; items: NavItem[] }[]; topItems: NavItem[]; publicItems: NavItem[] } {
  const topItems = items.filter((item) => TOP_PAGES.includes(item.page));
  const publicItems = items.filter((item) => !GROUP_OF[item.page] && !TOP_PAGES.includes(item.page));
  const groups = GROUP_ORDER.map((group) => ({ group, items: items.filter((item) => GROUP_OF[item.page] === group) })).filter((g) => g.items.length > 0);
  return { groups, topItems, publicItems };
}

/** "Front desk", for the top bar's breadcrumb; null for a page in no section. */
export function groupOf(page: NavPage): NavGroup | null {
  return GROUP_OF[page] ?? null;
}
