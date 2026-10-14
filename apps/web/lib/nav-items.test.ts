import { describe, expect, it } from 'vitest';
import { ALL_ON } from './features';
import { groupNavItems, groupOf, navItems, type NavFeatures } from './nav-items';

// The header offers exactly the pages a role may open, and only the pages the
// tenant has (so a button never leads to a 404).
const labels = (features: NavFeatures, role: Parameters<typeof navItems>[2]) => navItems('t', features, role).map((i) => i.label);

const NORTHWIND: NavFeatures = { bookings: false, rooms: false, book: false, manage: false, flags: ALL_ON, access: {} };
const VILLA: NavFeatures = { bookings: true, rooms: false, book: true, manage: true, flags: ALL_ON, access: {} };
const HARBOR: NavFeatures = { bookings: true, rooms: true, book: true, manage: true, flags: ALL_ON, access: {} };

describe('navItems', () => {
  it('shows a visitor the public pages only', () => {
    expect(labels(NORTHWIND, null)).toEqual(['Chat']);
    expect(labels(HARBOR, null)).toEqual(['Chat', 'Book']);
  });

  it('shows staff the daily work, and no admin-only page', () => {
    expect(labels(HARBOR, 'staff')).toEqual(['Chat', 'Book', 'Dashboard', 'Notifications', 'Bookings', 'Calendar', 'Payments', 'Conversations', 'Unanswered', 'Knowledge base']);
  });

  it('adds rooms and holidays for an admin, but not members', () => {
    expect(labels(HARBOR, 'admin')).toEqual(['Chat', 'Book', 'Dashboard', 'Notifications', 'Bookings', 'Calendar', 'Payments', 'Conversations', 'Unanswered', 'Knowledge base', 'Rooms', 'Slots', 'Holidays', 'Promos']);
  });

  it('adds members for an owner', () => {
    expect(labels(HARBOR, 'owner')).toEqual(['Chat', 'Book', 'Dashboard', 'Notifications', 'Bookings', 'Calendar', 'Payments', 'Conversations', 'Unanswered', 'Knowledge base', 'Rooms', 'Slots', 'Holidays', 'Promos', 'Members']);
  });

  it('leaves out what the tenant does not have', () => {
    expect(labels(VILLA, 'owner')).toEqual(['Chat', 'Book', 'Dashboard', 'Notifications', 'Bookings', 'Calendar', 'Payments', 'Conversations', 'Unanswered', 'Knowledge base', 'Slots', 'Holidays', 'Promos', 'Members']);
    expect(labels(NORTHWIND, 'owner')).toEqual(['Chat', 'Dashboard', 'Conversations', 'Unanswered', 'Knowledge base', 'Members']);
  });

  it('links each page under the tenant', () => {
    expect(navItems('harbor', HARBOR, 'owner').map((i) => i.href)).toEqual([
      '/t/harbor',
      '/t/harbor/book',
      '/t/harbor/admin/dashboard',
      '/t/harbor/admin/notifications',
      '/t/harbor/admin/bookings',
      '/t/harbor/admin/calendar',
      '/t/harbor/admin/payments',
      '/t/harbor/admin/conversations',
      '/t/harbor/admin/unanswered',
      '/t/harbor/admin/documents',
      '/t/harbor/admin/accommodations',
      '/t/harbor/admin/slots',
      '/t/harbor/admin/holidays',
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

  it("sections an owner's harbor links by the work: the daily work first, then the assistant, then setup", () => {
    expect(sections(HARBOR, 'owner')).toEqual({
      groups: ['Overview: Dashboard', 'Front desk: Bookings, Calendar, Payments', 'Assistant: Conversations, Unanswered, Knowledge base', 'Setup: Rooms, Slots, Holidays, Promos, Members'],
      publicItems: ['Chat', 'Book'],
    });
  });

  it('puts the bell in the top bar, not in a section', () => {
    const { groups, topItems } = groupNavItems(navItems('t', HARBOR, 'staff'));
    expect(topItems.map((i) => i.label)).toEqual(['Notifications']);
    expect(groups.flatMap((g) => g.items).some((i) => i.page === 'notifications')).toBe(false);
  });

  it('leaves out an empty section: northwind has no Front desk, a staff member no Setup', () => {
    expect(sections(NORTHWIND, 'staff').groups.map((g) => g.split(':')[0])).toEqual(['Overview', 'Assistant']);
    expect(sections(HARBOR, 'staff').groups.map((g) => g.split(':')[0])).toEqual(['Overview', 'Front desk', 'Assistant']);
  });

  it('names the section of a page for the breadcrumb, and none for a page in no section', () => {
    expect(groupOf('bookings')).toBe('Front desk');
    expect(groupOf('documents')).toBe('Assistant');
    expect(groupOf('members')).toBe('Setup');
    expect(groupOf('notifications')).toBeNull();
  });

  it('keeps every link navItems gave, and only those', () => {
    for (const role of ['owner', 'admin', 'staff', null] as const) {
      const items = navItems('t', VILLA, role);
      const { groups, topItems, publicItems } = groupNavItems(items);
      expect([...publicItems, ...topItems, ...groups.flatMap((g) => g.items)].map((i) => i.page).sort()).toEqual(items.map((i) => i.page).sort());
    }
  });
});

describe('navItems badges', () => {
  const unread = { unread: 3, latest: [] };
  const badges = (role: Parameters<typeof navItems>[2], attention?: typeof unread | null) =>
    navItems('t', HARBOR, role, attention).filter((i) => i.badge).map((i) => [i.label, i.badge]);

  it('puts the unread count on Notifications alone, for every role', () => {
    expect(badges('owner', unread)).toEqual([['Notifications', 3]]);
    expect(badges('staff', unread)).toEqual([['Notifications', 3]]);
  });

  it('shows no badge for a zero, before the first read, or to a visitor', () => {
    expect(badges('owner', { unread: 0, latest: [] })).toEqual([]);
    expect(badges('owner', null)).toEqual([]);
    expect(badges(null, unread)).toEqual([]);
  });

  it('has no Notifications item, and so no badge, for a tenant without bookings', () => {
    expect(navItems('t', NORTHWIND, 'owner', unread).filter((i) => i.page === 'notifications' || i.badge)).toEqual([]);
  });
});

describe('navItems feature flags (D-127)', () => {
  const off = (...keys: (keyof typeof ALL_ON)[]): NavFeatures => ({ ...HARBOR, flags: { ...ALL_ON, ...Object.fromEntries(keys.map((k) => [k, false])) } });

  it('leaves out the link of every switched-off staff screen, for every role', () => {
    const features = off('dashboard', 'conversations', 'unanswered', 'calendar', 'notifications');
    for (const role of ['owner', 'admin', 'staff'] as const) {
      const pages = navItems('t', features, role).map((i) => i.page);
      for (const gone of ['dashboard', 'conversations', 'unanswered', 'calendar', 'notifications']) expect(pages).not.toContain(gone);
      expect(pages).toContain('bookings');
    }
  });

  it('switching one off leaves the others', () => {
    const pages = navItems('t', off('calendar'), 'owner').map((i) => i.page);
    expect(pages).not.toContain('calendar');
    expect(pages).toEqual(expect.arrayContaining(['dashboard', 'notifications', 'conversations', 'unanswered']));
  });


});
