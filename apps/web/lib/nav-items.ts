// nav-items.ts — which pages the header offers, for which tenant and which role.
//
// Pure, like permissions.ts, so the Client Component that draws the header
// can import it. A button shown here is a courtesy: every page behind it
// still 404s for a tenant without the feature, and every route behind the
// page still asks requireAdmin() for the permission named below. Hiding a
// button is never the guard.

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

export type NavPage = 'chat' | 'book' | 'documents' | 'unanswered' | 'bookings' | 'rooms' | 'holidays' | 'members' | 'reset';

export interface NavItem {
  page: NavPage;
  label: string;
  href: string;
  primary?: boolean;
}

/**
 * The header's links, in order: the public pages first, then every staff
 * page this role may open. `role` null means "not logged in" (or not yet
 * known): the public pages only.
 */
export function navItems(slug: string, features: NavFeatures, role: Role | null): NavItem[] {
  const base = `/t/${slug}`;
  const items: NavItem[] = [{ page: 'chat', label: 'Chat', href: base }];
  if (features.book) items.push({ page: 'book', label: 'Book', href: `${base}/book`, primary: true });
  if (role === null) return items;

  // Each staff page with the permission its screen's first read needs.
  const staff: [NavPage, string, string, boolean][] = [
    ['documents', 'Knowledge base', '/admin', can(role, 'documents:read')],
    ['unanswered', 'Unanswered', '/admin/unanswered', can(role, 'unanswered:read')],
    ['bookings', 'Bookings', '/admin/bookings', features.bookings && can(role, 'bookings:read')],
    ['rooms', 'Rooms', '/admin/accommodations', features.rooms && can(role, 'rooms:read')],
    ['holidays', 'Holidays', '/admin/holidays', features.bookings && can(role, 'holidays:read')],
    ['members', 'Members', '/admin/members', can(role, 'members:manage')],
  ];
  for (const [page, label, path, allowed] of staff) {
    if (allowed) items.push({ page, label, href: `${base}${path}` });
  }
  return items;
}
