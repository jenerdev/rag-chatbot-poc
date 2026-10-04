import { describe, expect, it } from 'vitest';
import { navItems, type NavFeatures } from './nav-items';

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
    expect(labels(HARBOR, 'staff')).toEqual(['Chat', 'Book', 'Dashboard', 'Knowledge base', 'Unanswered', 'Bookings']);
  });

  it('adds rooms and holidays for an admin, but not members', () => {
    expect(labels(HARBOR, 'admin')).toEqual(['Chat', 'Book', 'Dashboard', 'Knowledge base', 'Unanswered', 'Bookings', 'Rooms', 'Holidays', 'Slots', 'Promos']);
  });

  it('adds members for an owner', () => {
    expect(labels(HARBOR, 'owner')).toEqual(['Chat', 'Book', 'Dashboard', 'Knowledge base', 'Unanswered', 'Bookings', 'Rooms', 'Holidays', 'Slots', 'Promos', 'Members']);
  });

  it('leaves out what the tenant does not have', () => {
    expect(labels(VILLA, 'owner')).toEqual(['Chat', 'Book', 'Dashboard', 'Knowledge base', 'Unanswered', 'Bookings', 'Holidays', 'Slots', 'Promos', 'Members']);
    expect(labels(NORTHWIND, 'owner')).toEqual(['Chat', 'Dashboard', 'Knowledge base', 'Unanswered', 'Members']);
  });

  it('links each page under the tenant', () => {
    expect(navItems('harbor', HARBOR, 'owner').map((i) => i.href)).toEqual([
      '/t/harbor',
      '/t/harbor/book',
      '/t/harbor/admin/dashboard',
      '/t/harbor/admin',
      '/t/harbor/admin/unanswered',
      '/t/harbor/admin/bookings',
      '/t/harbor/admin/accommodations',
      '/t/harbor/admin/holidays',
      '/t/harbor/admin/slots',
      '/t/harbor/admin/promos',
      '/t/harbor/admin/members',
    ]);
  });
});
