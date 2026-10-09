import { describe, expect, it } from 'vitest';
import { dashboardDays, parseTenantDashboard } from './dashboard.js';

// The jsonb tenant_dashboard() returns (verify 117's shape), with the
// bucket dates as a database that has NOT re-run the file sends them:
// timestamps. The parser normalises them either way.
const RAW = {
  timezone: 'Asia/Manila',
  today: '2026-10-05',
  days: 30,
  chat: {
    conversations: 128,
    visitorMessages: 410,
    assistantMessages: 405,
    refusals: 11,
    refusalRate: 2.7,
    openUnanswered: 4,
    perDay: [
      { day: '2026-09-06T00:00:00+00:00', conversations: 0 },
      { day: '2026-09-07', conversations: 3 },
    ],
  },
  knowledge: { documents: 8, chunks: 86, newest: { title: 'Rates', createdAt: '2026-10-02T03:00:00+00:00' } },
  team: { owners: 1, admins: 2, staff: 1 },
  bookings: {
    attention: { pendingRequests: 3, pendingStaff: 1, clashing: 1 },
    today: { checkIns: 2, checkOuts: 1, next7: [{ date: '2026-10-08', unit: 'Garden Room', slot: 'Night', guest: 'Ana' }] },
    window: { days: 30, confirmed: 14, pending: 3, cancelled: 2, web: 12, staff: 7 },
    stays: { weeks: 5, perWeek: [{ weekOf: '2026-09-01T00:00:00+00:00', stays: 4 }] },
    occupancy: { from: '2026-10-05', to: '2026-11-03', activeUnits: 4, roomNights: 46, percent: 38.3, perWeek: [{ weekOf: '2026-10-05', percent: 50 }] },
    promos: [{ id: 7, name: 'Off season', uses: 6, maxUses: null, discount: 320000 }],
    money: { confirmed: 18600000, pending: 4200000, discounts: 320000, perWeek: [{ weekOf: '2026-09-01', confirmed: 4000000 }] },
  },
};

describe('parseTenantDashboard', () => {
  it('names every key and normalises bucket dates to YYYY-MM-DD', () => {
    const d = parseTenantDashboard(RAW);
    expect(d.chat.conversations).toBe(128);
    expect(d.chat.refusalRate).toBe(2.7);
    expect(d.chat.perDay).toEqual([
      { day: '2026-09-06', conversations: 0 },
      { day: '2026-09-07', conversations: 3 },
    ]);
    expect(d.knowledge.newest).toEqual({ title: 'Rates', createdAt: '2026-10-02T03:00:00+00:00' });
    expect(d.team).toEqual({ owners: 1, admins: 2, staff: 1 });
    // The two manage-booking counts are not in tenant_dashboard()'s JSON: they read 0 here and are filled by tenantDashboard() from manage_attention().
    expect(d.bookings?.attention).toEqual({ pendingRequests: 3, pendingStaff: 1, clashing: 1, proofsToVerify: 0, changeRequests: 0 });
    expect(d.bookings?.today.next7[0]).toEqual({ date: '2026-10-08', unit: 'Garden Room', slot: 'Night', guest: 'Ana' });
    expect(d.bookings?.stays.perWeek).toEqual([{ weekOf: '2026-09-01', stays: 4 }]);
    expect(d.bookings?.occupancy?.percent).toBe(38.3);
    expect(d.bookings?.promos[0]).toEqual({ id: 7, name: 'Off season', uses: 6, maxUses: null, discount: 320000 });
    expect(d.bookings?.money?.confirmed).toBe(18600000);
  });

  it('keeps the nulls the function sends: no bookings, no occupancy, no money for staff', () => {
    expect(parseTenantDashboard({ ...RAW, bookings: null }).bookings).toBeNull();
    const staff = parseTenantDashboard({ ...RAW, bookings: { ...RAW.bookings, money: null, occupancy: null } });
    expect(staff.bookings?.money).toBeNull();
    expect(staff.bookings?.occupancy).toBeNull();
    expect(parseTenantDashboard({ ...RAW, knowledge: { documents: 0, chunks: 0, newest: null } }).knowledge.newest).toBeNull();
  });

  it('never throws on a shape it does not expect', () => {
    const d = parseTenantDashboard({});
    expect(d.chat.conversations).toBe(0);
    expect(d.bookings).toBeNull();
    expect(d.team).toEqual({ owners: 0, admins: 0, staff: 0 });
  });
});

describe('dashboardDays', () => {
  it('clamps to the function’s window and defaults to 30', () => {
    expect(dashboardDays(undefined)).toBe(30);
    expect(dashboardDays('7')).toBe(7);
    expect(dashboardDays('90')).toBe(90);
    expect(dashboardDays('3')).toBe(7);
    expect(dashboardDays('365')).toBe(90);
    expect(dashboardDays('abc')).toBe(30);
    expect(dashboardDays(14.5)).toBe(30);
  });
});
