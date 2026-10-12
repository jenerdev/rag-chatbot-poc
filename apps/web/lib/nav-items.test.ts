import { describe, expect, it } from 'vitest';
import { groupNavItems, navItems, type NavFeatures } from './nav-items';

// The header offers exactly the pages a role may open, and only the pages the
// tenant has (so a button never leads to a 404).
const labels = (features: NavFeatures, role: Parameters<typeof navItems>[2]) => navItems('t', features, role).map((i) => i.label);

const NORTHWIND: NavFeatures = { bookings: false, rooms: false, book: false };
const VILLA: NavFeatures = { bookings: true, rooms: false, book: true };
const HARBOR: NavFeatures = { bookings: true, rooms: true, book: true };

describe('navItems', () => {
  it('shows a visitor the public pages only', () => {
    expect(labels(NORTHWIND, null)).toEqual(['Chat']);
    expect(labels(HARBOR, null)).toEqual(['Chat', 'Book']);
  });

  it('shows staff the daily work, and no admin-only page', () => {
    expect(labels(HARBOR, 'staff')).toEqual(['Chat', 'Book', 'Dashboard', 'Knowledge base', 'Unanswered', 'Conversations', 'Bookings', 'Calendar', 'Payments']);
  });

  it('adds rooms and holidays for an admin, but not members', () => {
    expect(labels(HARBOR, 'admin')).toEqual(['Chat', 'Book', 'Dashboard', 'Knowledge base', 'Unanswered', 'Conversations', 'Bookings', 'Calendar', 'Payments', 'Rooms', 'Holidays', 'Slots', 'Promos']);
  });

  it('adds members for an owner', () => {
    expect(labels(HARBOR, 'owner')).toEqual(['Chat', 'Book', 'Dashboard', 'Knowledge base', 'Unanswered', 'Conversations', 'Bookings', 'Calendar', 'Payments', 'Rooms', 'Holidays', 'Slots', 'Promos', 'Members']);
  });

  it('leaves out what the tenant does not have', () => {
    expect(labels(VILLA, 'owner')).toEqual(['Chat', 'Book', 'Dashboard', 'Knowledge base', 'Unanswered', 'Conversations', 'Bookings', 'Calendar', 'Payments', 'Holidays', 'Slots', 'Promos', 'Members']);
    expect(labels(NORTHWIND, 'owner')).toEqual(['Chat', 'Dashboard', 'Knowledge base', 'Unanswered', 'Conversations', 'Members']);
  });

  it('links each page under the tenant', () => {
    expect(navItems('harbor', HARBOR, 'owner').map((i) => i.href)).toEqual([
      '/t/harbor',
      '/t/harbor/book',
      '/t/harbor/admin/dashboard',
      '/t/harbor/admin/documents',
      '/t/harbor/admin/unanswered',
      '/t/harbor/admin/conversations',
      '/t/harbor/admin/bookings',
      '/t/harbor/admin/calendar',
      '/t/harbor/admin/payments',
      '/t/harbor/admin/accommodations',
      '/t/harbor/admin/holidays',
      '/t/harbor/admin/slots',
      '/t/harbor/admin/promos',
      '/t/harbor/admin/members',
    ]);
  });
});

describe('groupNavItems', () => {
  const sections = (features: NavFeatures, role: Parameters<typeof navItems>[2]) => {
    const { groups, publicItems } = groupNavItems(navItems('t', features, role));
    return { groups: groups.map((g) => `${g.group}: ${g.items.map((i) => i.label).join(', ')}`), publicItems: publicItems.map((i) => i.label) };
  };

  it("sections an owner's harbor links, Chat and Book apart", () => {
    expect(sections(HARBOR, 'owner')).toEqual({
      groups: ['Overview: Dashboard', 'Content: Knowledge base, Unanswered, Conversations', 'Bookings: Bookings, Calendar, Payments, Rooms, Holidays, Slots, Promos', 'Team: Members'],
      publicItems: ['Chat', 'Book'],
    });
  });

  it('leaves out an empty section: northwind has no bookings, a staff member no Team', () => {
    expect(sections(NORTHWIND, 'staff').groups.map((g) => g.split(':')[0])).toEqual(['Overview', 'Content']);
  });

  it('keeps every link navItems gave, and only those', () => {
    for (const role of ['owner', 'admin', 'staff', null] as const) {
      const items = navItems('t', VILLA, role);
      const { groups, publicItems } = groupNavItems(items);
      expect([...publicItems, ...groups.flatMap((g) => g.items)].map((i) => i.page).sort()).toEqual(items.map((i) => i.page).sort());
    }
  });
});

describe('navItems badges', () => {
  const counts = { requests: 2, proofs: 1, changes: 1 };
  const badges = (role: Parameters<typeof navItems>[2], attention?: typeof counts | null) =>
    navItems('t', HARBOR, role, attention).filter((i) => i.badge).map((i) => [i.label, i.badge]);

  it('puts requests and changes on Bookings, proofs on Payments', () => {
    expect(badges('owner', counts)).toEqual([['Bookings', 3], ['Payments', 1]]);
    expect(badges('staff', counts)).toEqual([['Bookings', 3], ['Payments', 1]]);
  });

  it('shows no badge for a zero, before the first read, or to a visitor', () => {
    expect(badges('owner', { requests: 0, proofs: 0, changes: 0 })).toEqual([]);
    expect(badges('owner', null)).toEqual([]);
    expect(badges(null, counts)).toEqual([]);
  });

  it('never badges a page the tenant does not have', () => {
    expect(navItems('t', NORTHWIND, 'owner', counts).filter((i) => i.badge)).toEqual([]);
  });
});
