// nav-items.ts — which pages the header offers, for which tenant and which role.
//
// Pure, like permissions.ts, so the Client Component that draws the header
// can import it. A button shown here is a courtesy: every page behind it
// still 404s for a tenant without the feature, and every route behind the
// page still asks requireAdmin() for the permission named below. Hiding a
// button is never the guard.

import type { Attention } from './attention';
import { can, type Role } from './permissions';

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
  /** bookings and a priced unit: S-6, the public booking page */
  book: boolean;
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

  // Each staff page with the permission its screen's first read needs.
  const staff: [NavPage, string, string, boolean][] = [
    // First (plan/dashboard.md § 7 q1): the page to land on; /admin redirects here.
    ['dashboard', 'Dashboard', '/admin/dashboard', can(role, 'dashboard:read')],
    // S-17 (plan/notifications.md § 8): what arrived, read or not; the ONE badge.
    ['notifications', 'Notifications', '/admin/notifications', features.bookings && can(role, 'bookings:read')],
    ['documents', 'Knowledge base', '/admin/documents', can(role, 'documents:read')],
    ['unanswered', 'Unanswered', '/admin/unanswered', can(role, 'unanswered:read')],
    // S-16 (plan/conversations.md, D-115): every chat, every tenant.
    ['conversations', 'Conversations', '/admin/conversations', can(role, 'conversations:read')],
    ['bookings', 'Bookings', '/admin/bookings', features.bookings && can(role, 'bookings:read')],
    // S-12 (plan/calendar.md, D-103): a view of the same bookings, so the same permission.
    ['calendar', 'Calendar', '/admin/calendar', features.bookings && can(role, 'bookings:read')],
    // S-14 (plan/manage-booking.md): proofs to verify, refunds, the payment settings.
    ['payments', 'Payments', '/admin/payments', features.bookings && can(role, 'payments:read')],
    ['rooms', 'Rooms', '/admin/accommodations', features.rooms && can(role, 'rooms:read')],
    ['holidays', 'Holidays', '/admin/holidays', features.bookings && can(role, 'holidays:read')],
    ['slots', 'Slots', '/admin/slots', features.bookings && can(role, 'slots:read')],
    ['promos', 'Promos', '/admin/promos', features.bookings && can(role, 'promos:read')],
    ['members', 'Members', '/admin/members', can(role, 'members:manage')],
  ];
  // What this member has not read, on Notifications alone; a zero is no badge.
  for (const [page, label, path, allowed] of staff) {
    if (!allowed) continue;
    const badge = page === 'notifications' ? attention?.unread : undefined;
    items.push(badge ? { page, label, href: `${base}${path}`, badge } : { page, label, href: `${base}${path}` });
  }
  return items;
}

/** The sidebar's sections (plan/ui-refresh.md Phase 2), in order. */
export type NavGroup = 'Overview' | 'Content' | 'Bookings' | 'Team';

const GROUP_OF: Readonly<Partial<Record<NavPage, NavGroup>>> = {
  dashboard: 'Overview',
  notifications: 'Overview',
  documents: 'Content',
  unanswered: 'Content',
  conversations: 'Content',
  bookings: 'Bookings',
  calendar: 'Bookings',
  payments: 'Bookings',
  rooms: 'Bookings',
  holidays: 'Bookings',
  slots: 'Bookings',
  promos: 'Bookings',
  members: 'Team',
};
const GROUP_ORDER: readonly NavGroup[] = ['Overview', 'Content', 'Bookings', 'Team'];

/**
 * navItems()'s staff links, sectioned for the sidebar; the public pages
 * (Chat, Book) apart, for its footer. A presentation of the SAME list: which
 * links exist is still navItems()'s decision alone, and an empty section is
 * left out.
 */
export function groupNavItems(items: NavItem[]): { groups: { group: NavGroup; items: NavItem[] }[]; publicItems: NavItem[] } {
  const publicItems = items.filter((item) => !GROUP_OF[item.page]);
  const groups = GROUP_ORDER.map((group) => ({ group, items: items.filter((item) => GROUP_OF[item.page] === group) })).filter((g) => g.items.length > 0);
  return { groups, publicItems };
}
