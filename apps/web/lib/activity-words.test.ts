import { describe, expect, it } from 'vitest';
import { AREA_LABELS, activityHref, activityQuery, activityWords, actorWords, changeWords, parseActivityFilters, type ActivityLine } from './activity-words';

const row = (over: Partial<ActivityLine>): ActivityLine => ({
  source: 'audit',
  actorKind: 'staff',
  actorUser: '6f1c2e4a-1111-4222-8333-444455556666',
  actorEmail: 'maria@example.com',
  area: 'documents',
  action: 'delete',
  subject: '42',
  label: 'House rules',
  changed: null,
  before: null,
  after: null,
  ...over,
});

describe('actorWords', () => {
  it('names a current member, a former member, the platform, the system and the guest', () => {
    expect(actorWords(row({}))).toBe('maria@example.com');
    expect(actorWords(row({ actorEmail: null }))).toBe('A former member');
    expect(actorWords(row({ actorKind: 'super', actorEmail: null }))).toBe('Platform');
    expect(actorWords(row({ actorKind: 'super', actorEmail: null }), true)).toBe('Super user');
    expect(actorWords(row({ actorKind: 'system', actorUser: null, actorEmail: null }))).toBe('System');
    expect(actorWords(row({ actorKind: 'guest', actorUser: null, actorEmail: null }))).toBe('The guest');
  });
});

describe('activityWords', () => {
  it('says what happened to a document, a room, a rate and a member', () => {
    expect(activityWords(row({}))).toBe('deleted the document “House rules”');
    expect(activityWords(row({ action: 'insert' }))).toBe('added the document “House rules”');
    expect(activityWords(row({ area: 'rooms', action: 'update', label: 'Garden Room', changed: ['name', 'capacity'], before: { name: 'Garden', capacity: 2 }, after: { name: 'Garden Room', capacity: 4 } }))).toBe(
      'changed “Garden Room”: name Garden → Garden Room, maximum guests 2 → 4',
    );
    expect(activityWords(row({ area: 'rates', action: 'update', label: 'Garden Room · Overnight', changed: ['weekend_price'], before: { weekend_price: 1200000 }, after: { weekend_price: 1500000 } }))).toBe(
      'changed the rates for “Garden Room · Overnight”: weekend rate ₱12,000.00 → ₱15,000.00',
    );
    expect(activityWords(row({ area: 'members', action: 'update', label: null, changed: ['role'], before: { role: 'staff' }, after: { role: 'admin' } }))).toBe('made a member admin (was staff)');
    expect(activityWords(row({ area: 'members', action: 'insert', label: null, after: { role: 'owner' } }))).toBe('added a member as owner');
  });

  it('names a feature, a permission, an archive and the named actions', () => {
    expect(activityWords(row({ area: 'features', action: 'update', subject: 'voice', label: 'voice', changed: ['enabled'], before: { enabled: false }, after: { enabled: true } }))).toBe('switched Voice on');
    expect(activityWords(row({ area: 'features', action: 'delete', subject: 'calendar', label: 'calendar' }))).toBe('set Calendar back to its default');
    expect(activityWords(row({ area: 'permissions', action: 'insert', after: { role: 'admin', permission: 'activity:read', allowed: true } }))).toBe('let admin see the activity log');
    expect(activityWords(row({ area: 'permissions', action: 'insert', after: { role: 'staff', permission: 'bookings:write', allowed: false } }))).toBe('stopped staff from: Create, confirm, decline and cancel bookings');
    expect(activityWords(row({ area: 'tenant', action: 'update', changed: ['archived_at'], before: { archived_at: null }, after: { archived_at: '2026-10-20T00:00:00Z' } }))).toBe('archived the workspace');
    expect(activityWords(row({ area: 'session', action: 'login' }))).toBe('signed in');
    expect(activityWords(row({ area: 'proof', action: 'proof_opened', subject: '17' }))).toBe('opened the proof of payment #17');
    expect(activityWords(row({ area: 'platform', action: 'tenant_removed', label: 'harbor' }))).toBe('removed the workspace “harbor” and everything in it');
  });

  it("reads a stay's log without its note", () => {
    const stay = (over: Partial<ActivityLine>) => row({ source: 'bookings', area: 'bookings', label: 'VIL-ABC123', ...over });
    expect(activityWords(stay({ action: 'created', actorKind: 'guest', after: { status: 'pending' } }))).toBe('requested booking VIL-ABC123');
    expect(activityWords(stay({ action: 'created', after: { status: 'confirmed' } }))).toBe('booked booking VIL-ABC123, confirmed');
    expect(activityWords(stay({ action: 'status', before: { status: 'pending' }, after: { status: 'cancelled' } }))).toBe('declined booking VIL-ABC123');
    expect(activityWords(stay({ action: 'status', before: { status: 'confirmed' }, after: { status: 'cancelled' } }))).toBe('cancelled booking VIL-ABC123');
    expect(activityWords(stay({ action: 'payment', after: { status: 'payment:verified' } }))).toBe('verified a payment on booking VIL-ABC123');
    expect(activityWords(stay({ action: 'change', after: { status: 'cancel:pending' } }))).toBe('asked to cancel booking VIL-ABC123');
  });
});

describe('changeWords', () => {
  it('names a column outside the allowlist by name alone, and says on/off for a boolean', () => {
    expect(changeWords({ changed: ['description', 'active'], before: { active: true }, after: { active: false } })).toBe('description, active on → off');
    expect(changeWords({ changed: [], before: null, after: null })).toBe('');
  });
});

describe('the filters and the URL', () => {
  it('parses the URL, drops what it does not know, and writes the non-defaults back', () => {
    const f = parseActivityFilters({ days: '90', area: 'members', actor: 'not-a-uuid', q: 'garden' });
    expect(f).toEqual({ days: 90, area: 'members', actor: '', q: 'garden' });
    expect(activityQuery(f)).toBe('?days=90&area=members&q=garden');
    expect(parseActivityFilters({ days: '12', area: 'nope' })).toEqual({ days: 30, area: '', actor: '', q: '' });
    expect(activityQuery({ days: 30, area: '', actor: '', q: ' ' })).toBe('');
    for (const key of Object.keys(AREA_LABELS)) expect(parseActivityFilters({ area: key }).area).toBe(key);
  });
});

describe('activityHref', () => {
  it('links a stay to its page, a live row to its screen, and a deleted row nowhere', () => {
    expect(activityHref('villa', row({ source: 'bookings', area: 'bookings', label: 'VIL-ABC123', action: 'status' }))).toBe('/t/villa/admin/bookings/VIL-ABC123');
    expect(activityHref('villa', row({ area: 'rooms', action: 'update' }))).toBe('/t/villa/admin/accommodations');
    expect(activityHref('villa', row({ area: 'documents', action: 'delete' }))).toBeNull();
    expect(activityHref('villa', row({ area: 'session', action: 'login' }))).toBeNull();
  });
});
