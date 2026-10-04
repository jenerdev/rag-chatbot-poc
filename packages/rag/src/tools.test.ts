// executeTool's tests (D-046). Every availability check, the model's and the
// ones answer.ts runs up front for a resolved date, reaches the booking layer
// through executeTool(). These pin what it hands on: the exact dates, and
// what happens when the check fails.
//
// @rag/bookings and the enablement lookup are mocked, so no database is
// touched. What is under test is the seam, not Postgres: `pnpm eval`'s
// date-* cases run the same path against the real one.

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@rag/bookings', () => {
  class BookingInputError extends Error {}
  return {
    BookingInputError,
    checkAvailability: vi.fn(),
    checkPricedAvailability: vi.fn(),
    checkRoomAvailability: vi.fn(),
    hasBookingPage: vi.fn(),
    bookingPage: vi.fn(),
    lastBookingDate: vi.fn(() => '2027-09-30'),
    listRooms: vi.fn(),
    bookingsConfig: vi.fn(),
    listSlots: vi.fn(),
    localDate: vi.fn(),
    MAX_AVAILABILITY_DAYS: 31,
  };
});
vi.mock('./applications.js', () => ({
  APPLICATIONS: { bookings: { tools: ['check_availability'] } },
  enabledApplications: vi.fn(async () => ['bookings']),
}));

import { BookingInputError, bookingPage, bookingsConfig, checkAvailability, checkPricedAvailability, checkRoomAvailability, hasBookingPage, lastBookingDate } from '@rag/bookings';
import { planDates } from './dates.js';
import { executeTool, rateCardReply } from './tools.js';
import type { TenantContext } from './types.js';

const TENANT = { id: 3, slug: 'villa', businessName: 'Villa Amihan', assistantName: 'Lia', fallbackMessages: {}, db: {} } as unknown as TenantContext;
const check = vi.mocked(checkAvailability);
const priced = vi.mocked(checkPricedAvailability);
const hasPage = vi.mocked(hasBookingPage);
const SLOTS = [{ date: '2026-09-28', unit: 'Villa', slot: 'Overnight', status: 'open' }];

/** The tool calls answer.ts builds from a plan, the same way (withDates). */
const precheck = (message: string, earlier: string[] = []) =>
  planDates(message, '2026-09-27', earlier).calls.map((args, i) => ({
    id: `call_resolved_date_${i}`,
    name: 'check_availability',
    arguments: JSON.stringify(args),
  }));

beforeEach(() => {
  check.mockReset();
  check.mockResolvedValue(SLOTS as never);
  // No priced unit unless a test says so: the unpriced whole-resort path.
  hasPage.mockResolvedValue(false);
  priced.mockReset();
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

describe('the resolved date is the date the availability API receives', () => {
  it('"Available ba kayo bukas?" → checkAvailability(2026-09-28)', async () => {
    const [call] = precheck('Available ba kayo bukas?');
    const { record } = await executeTool(TENANT, call!);
    expect(check).toHaveBeenCalledWith(TENANT, { from: '2026-09-28', to: undefined });
    expect(record).toMatchObject({ name: 'check_availability', args: { date_from: '2026-09-28' }, result: { slots: SLOTS } });
  });

  it('"Is the resort available tomorrow?" → the same date as "bukas"', async () => {
    await executeTool(TENANT, precheck('Is the resort available tomorrow?')[0]!);
    expect(check).toHaveBeenCalledWith(TENANT, { from: '2026-09-28', to: undefined });
  });

  it('"sa makalawa" → 2026-09-29', async () => {
    await executeTool(TENANT, precheck('Available ba kayo sa makalawa?')[0]!);
    expect(check).toHaveBeenCalledWith(TENANT, { from: '2026-09-29', to: undefined });
  });

  it('"next week" → a range, both ends', async () => {
    await executeTool(TENANT, precheck('Available ba kayo next week?')[0]!);
    expect(check).toHaveBeenCalledWith(TENANT, { from: '2026-09-28', to: '2026-10-04' });
  });

  it('an explicit date is passed as written', async () => {
    await executeTool(TENANT, precheck('Check availability for September 30, 2026.')[0]!);
    expect(check).toHaveBeenCalledWith(TENANT, { from: '2026-09-30', to: undefined });
  });

  it('a follow-up that changes the date checks the NEW date', async () => {
    await executeTool(TENANT, precheck('What about the day after tomorrow?', ['Available ba kayo bukas?'])[0]!);
    expect(check).toHaveBeenCalledWith(TENANT, { from: '2026-09-29', to: undefined });
  });

  it('the result goes back to the model as JSON, and carries only what the API returned', async () => {
    const { content } = await executeTool(TENANT, precheck('Available ba kayo bukas?')[0]!);
    expect(JSON.parse(content)).toEqual({ slots: SLOTS });
  });
});

describe('when the check fails', () => {
  it('a date the booking rules refuse (past, too long) comes back as an error the model passes on', async () => {
    check.mockRejectedValueOnce(new BookingInputError('2026-09-26 is in the past. Today is 2026-09-27.'));
    const { record, content } = await executeTool(TENANT, precheck('Available ba kahapon?')[0]!);
    expect(check).toHaveBeenCalledWith(TENANT, { from: '2026-09-26', to: undefined });
    expect(record.result).toEqual({ error: '2026-09-26 is in the past. Today is 2026-09-27.' });
    expect(JSON.parse(content)).toEqual({ error: '2026-09-26 is in the past. Today is 2026-09-27.' });
  });

  it('an API or database failure is NOT turned into an answer: it throws, so the user is told it could not be checked', async () => {
    check.mockRejectedValueOnce(new Error('Could not check availability: connection refused'));
    await expect(executeTool(TENANT, precheck('Available ba kayo bukas?')[0]!)).rejects.toThrow('connection refused');
  });

  it('a tool the tenant does not have is refused before anything is checked', async () => {
    const { enabledApplications } = await import('./applications.js');
    vi.mocked(enabledApplications).mockResolvedValueOnce([]);
    const { record } = await executeTool(TENANT, precheck('Available ba kayo bukas?')[0]!);
    expect(check).not.toHaveBeenCalled();
    expect(record.result).toEqual({ error: 'There is no tool named "check_availability".' });
  });
});

describe('when nothing is checked up front', () => {
  it('no date: no call, so the model asks for one', () => {
    expect(precheck('Is it available?')).toEqual([]);
  });

  it('a documents question with a date: no call', () => {
    expect(precheck('What time is check-in bukas?')).toEqual([]);
  });

  it('an ambiguous date: no call, the model asks which', () => {
    expect(planDates('Available ba next Friday?', '2026-09-30', []).calls).toEqual([]);
  });
});

// plan/booking-types.md Phase 6: a per_room tenant's check_availability. The
// same tool name, so D-046's up-front calls above reach rooms too; the branch
// is chosen from the DATABASE (bookingsConfig), not from the tool text.
describe('per_room: check_availability checks rooms', () => {
  const rooms = vi.mocked(checkRoomAvailability);
  const config = vi.mocked(bookingsConfig);
  const HARBOR = { ...TENANT, id: 67, slug: 'harbor' } as unknown as TenantContext;
  const ROOMS = [
    { date: '2026-09-28', unit: 'Garden Room', capacity: 2, standardCapacity: 2, extraPersonRate: 25000, slot: 'Night', status: 'open', price: 350000, rateKind: 'weekday', dayPrice: 350000, extraGuestPrice: 0, total: 350000 },
    { date: '2026-09-28', unit: 'Family Room', capacity: 6, standardCapacity: 2, extraPersonRate: 25000, slot: 'Night', status: 'taken', price: 600000, rateKind: 'weekday', dayPrice: 600000, extraGuestPrice: 25000, total: 625000 },
  ];

  beforeEach(() => {
    rooms.mockReset();
    rooms.mockResolvedValue(ROOMS as never);
    config.mockReset();
    config.mockResolvedValue({ timezone: 'Asia/Manila', bookingType: 'per_room', weekendDays: [5, 6, 7], currency: 'PHP' } as never);
  });

  it('passes the narrowing arguments through, by name', async () => {
    await executeTool(HARBOR, {
      id: 'c1',
      name: 'check_availability',
      arguments: JSON.stringify({ date_from: '2026-09-28', slot: 'Night', room: 'Garden Room', guests: 2 }),
    });
    expect(rooms).toHaveBeenCalledWith(HARBOR, { from: '2026-09-28', to: undefined, slot: 'Night', unit: 'Garden Room', guests: 2 });
    expect(check).not.toHaveBeenCalled();
  });

  it('hands the model prices as text, and exactly these fields when the guests are unknown', async () => {
    const { record, content } = await executeTool(HARBOR, { id: 'c1', name: 'check_availability', arguments: '{"date_from":"2026-09-28"}' });
    const rows = (record.result as { slots: Record<string, unknown>[] }).slots;
    expect(rows[0]).toEqual({
      date: '2026-09-28',
      unit: 'Garden Room',
      capacity: 2,
      included_guests: 2,
      extra_guest_fee: '₱250.00',
      slot: 'Night',
      status: 'open',
      price: '₱3,500.00 (weekday rate)',
    });
    // No total without a guest count: there is no party to price.
    expect(rows.every((r) => Object.keys(r).sort().join(',') === 'capacity,date,extra_guest_fee,included_guests,price,slot,status,unit')).toBe(true);
    expect(content).not.toContain('350000');
  });

  it("with a guest count, each row carries that party's extra charge and total, from the database", async () => {
    const { record } = await executeTool(HARBOR, { id: 'c1', name: 'check_availability', arguments: '{"date_from":"2026-09-28","guests":3}' });
    const [, family] = (record.result as { slots: Record<string, unknown>[] }).slots;
    expect(family).toMatchObject({ unit: 'Family Room', price: '₱6,000.00 (weekday rate)', extra_guest_charge: '₱250.00', total: '₱6,250.00' });
  });

  // D-082: the price says which rate it is; a closed row sells nothing, so no label.
  it('the price names its rate kind, from the row; a closed row has none', async () => {
    rooms.mockResolvedValueOnce([
      { ...ROOMS[0], date: '2026-12-24', rateKind: 'holiday' },
      { ...ROOMS[0], date: '2026-12-25', rateKind: 'peak' },
      { ...ROOMS[0], date: '2026-12-26', rateKind: 'closed', status: 'closed' },
    ] as never);
    const { record } = await executeTool(HARBOR, { id: 'c1', name: 'check_availability', arguments: '{"date_from":"2026-12-24","date_to":"2026-12-26"}' });
    const prices = (record.result as { slots: { price: string }[] }).slots.map((r) => r.price);
    expect(prices).toEqual(['₱3,500.00 (holiday rate)', '₱3,500.00 (peak rate)', '₱3,500.00']);
  });

  // D-083: villa's 24 December. The base (weekend) rate is ₱20,000, the
  // calendar adds ₱4,000; the model is quoted the DAY price, never the base.
  it("quotes the day price, the holiday surcharge in, not the base rate", async () => {
    rooms.mockResolvedValueOnce([{ ...ROOMS[0], date: '2026-12-24', rateKind: 'holiday', price: 2000000, dayPrice: 2400000, total: 2400000 }] as never);
    const { record, content } = await executeTool(HARBOR, { id: 'c1', name: 'check_availability', arguments: '{"date_from":"2026-12-24"}' });
    expect((record.result as { slots: { price: string }[] }).slots[0]!.price).toBe('₱24,000.00 (holiday rate)');
    expect(content).not.toContain('20,000');
  });

  // D-086: past the horizon, a row is "not yet bookable", with no price,
  // and the note names the last date; the day before it is priced as usual.
  it('a date past the booking horizon is not yet bookable, with no price', async () => {
    vi.mocked(lastBookingDate).mockReturnValueOnce('2027-09-30');
    rooms.mockResolvedValueOnce([
      { ...ROOMS[0], date: '2027-09-30' },
      { ...ROOMS[0], date: '2027-10-01' },
    ] as never);
    const { record } = await executeTool(HARBOR, { id: 'c1', name: 'check_availability', arguments: '{"date_from":"2027-09-30","date_to":"2027-10-01"}' });
    const result = record.result as { slots: Record<string, unknown>[]; not_yet_bookable?: { dates: string[]; meaning: string } };
    expect(result.slots[0]).toMatchObject({ date: '2027-09-30', status: 'open', price: '₱3,500.00 (weekday rate)' });
    expect(result.slots[1]).toEqual({ date: '2027-10-01', unit: 'Garden Room', slot: 'Night', status: 'not yet bookable' });
    expect(result.not_yet_bookable?.dates).toEqual(['2027-10-01']);
    expect(result.not_yet_bookable?.meaning).toContain('30 September 2027');
  });

  it('a resolved date ("bukas") reaches the rooms check too', async () => {
    await executeTool(HARBOR, precheck('May kwarto ba kayo bukas?')[0]!);
    expect(rooms).toHaveBeenCalledWith(HARBOR, expect.objectContaining({ from: '2026-09-28' }));
  });

  it('a BookingInputError (too many rows, a past date) goes back to the model as an error', async () => {
    rooms.mockRejectedValueOnce(new BookingInputError('That is 200 results, more than 150.'));
    const { record } = await executeTool(HARBOR, { id: 'c1', name: 'check_availability', arguments: '{"date_from":"2026-09-28","date_to":"2026-10-28"}' });
    expect(record.result).toEqual({ error: 'That is 200 results, more than 150.' });
  });

  it('a whole_resort tenant with no rate still gets the slots check, untouched', async () => {
    config.mockResolvedValue({ timezone: 'Asia/Manila', bookingType: 'whole_resort', weekendDays: [5, 6, 7], currency: 'PHP' } as never);
    await executeTool(TENANT, { id: 'c1', name: 'check_availability', arguments: '{"date_from":"2026-09-28"}' });
    expect(check).toHaveBeenCalled();
    expect(rooms).not.toHaveBeenCalled();
    expect(priced).not.toHaveBeenCalled();
  });

  // D-074: a whole-resort tenant whose unit has a rate (villa) is priced from
  // the same function as a room, and its rows carry the price as text.
  it('a whole_resort tenant WITH a rate gets priced rows, from checkPricedAvailability', async () => {
    config.mockResolvedValue({ timezone: 'Asia/Manila', bookingType: 'whole_resort', weekendDays: [5, 6, 7], currency: 'PHP' } as never);
    hasPage.mockResolvedValue(true);
    priced.mockResolvedValue([
      {
        date: '2026-09-28',
        unit: 'Whole property',
        capacity: 45,
        standardCapacity: 30,
        extraPersonRate: 25000,
        slot: 'Overnight',
        status: 'open',
        price: 1600000,
        rateKind: 'weekend',
        dayPrice: 1600000,
        extraGuestPrice: 50000,
        total: 1650000,
      },
    ] as never);
    const { record } = await executeTool(TENANT, { id: 'c1', name: 'check_availability', arguments: '{"date_from":"2026-09-28","guests":32}' });
    expect(priced).toHaveBeenCalledWith(TENANT, expect.objectContaining({ from: '2026-09-28', guests: 32 }));
    expect(check).not.toHaveBeenCalled();
    expect(rooms).not.toHaveBeenCalled();
    const [row] = (record.result as { slots: Record<string, unknown>[] }).slots;
    expect(row).toMatchObject({
      unit: 'Whole property',
      slot: 'Overnight',
      status: 'open',
      included_guests: 30,
      extra_guest_fee: '₱250.00',
      price: '₱16,000.00 (weekend rate)',
      extra_guest_charge: '₱500.00',
      total: '₱16,500.00',
    });
  });
});


describe('rateCardReply (plan/tables.md Phase 2, § 7 q1)', () => {
  const page = vi.mocked(bookingPage);
  const unit = (name: string, rates: { slot: string; weekdayPrice: number; weekendPrice: number; holidayPrice: number | null }[]) => ({
    id: 1,
    name,
    description: null,
    capacity: 4,
    standardCapacity: 2,
    extraPersonRate: 25000,
    rates: rates.map((r, i) => ({ slotId: i + 1, ...r })),
  });
  const PAGE = { currency: 'PHP', units: [] as ReturnType<typeof unit>[] };

  it('one unit: a Slot column, no Room column, the weekend price where no holiday price is set', async () => {
    page.mockResolvedValueOnce({
      ...PAGE,
      units: [unit('Villa', [{ slot: 'Overnight', weekdayPrice: 1600000, weekendPrice: 2000000, holidayPrice: null }, { slot: 'Day Tour', weekdayPrice: 950000, weekendPrice: 1200000, holidayPrice: 1400000 }])],
    } as never);
    expect(await rateCardReply(TENANT, 'english')).toBe(
      'Here are our rates:\n\n' +
        '| Slot | Weekday | Weekend | Holiday |\n|---|---|---|---|\n' +
        '| Overnight | ₱16,000.00 | ₱20,000.00 | ₱20,000.00 |\n' +
        '| Day Tour | ₱9,500.00 | ₱12,000.00 | ₱14,000.00 |\n\n' +
        'The rate depends on whether your date falls on a weekday, a weekend or a holiday, and a holiday can carry a surcharge. ' +
        'Tell me your preferred date and I can give you the exact rate.',
    );
  });

  it('several units: a Room column first, one row per unit and slot, in Tagalog', async () => {
    page.mockResolvedValueOnce({
      ...PAGE,
      units: [
        unit('Garden Room', [{ slot: 'Night', weekdayPrice: 350000, weekendPrice: 450000, holidayPrice: null }]),
        unit('Sea | View', [{ slot: 'Night', weekdayPrice: 800000, weekendPrice: 950000, holidayPrice: 1100000 }]),
      ],
    } as never);
    const reply = await rateCardReply(TENANT, 'tagalog');
    expect(reply).toContain('| Kwarto | Slot | Karaniwang araw | Sabado at Linggo | Pista opisyal |\n|---|---|---|---|---|\n');
    expect(reply).toContain('| Garden Room | Night | ₱3,500.00 | ₱4,500.00 | ₱4,500.00 |\n');
    // A pipe in a tenant-typed room name cannot split the row.
    expect(reply).toContain('| Sea View | Night | ₱8,000.00 | ₱9,500.00 | ₱11,000.00 |');
    expect(reply).toMatch(/^Narito po ang aming mga presyo:/);
  });

  it('null when there is no page to read, so the caller falls back to PRICE_NEEDS_DATE', async () => {
    page.mockRejectedValueOnce(new Error('nothing priced'));
    expect(await rateCardReply(TENANT, 'english')).toBeNull();
    page.mockResolvedValueOnce({ ...PAGE, units: [] } as never);
    expect(await rateCardReply(TENANT, 'english')).toBeNull();
  });
});
