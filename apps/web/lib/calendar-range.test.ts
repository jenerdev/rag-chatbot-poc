import { describe, expect, it } from 'vitest';
import { datesOf, isView, isoWeekday, monthOptions, mondayOf, rangeFor, step } from './calendar-range';

describe('isoWeekday and mondayOf', () => {
  it('counts Monday as 1 and Sunday as 7', () => {
    expect(isoWeekday('2026-10-05')).toBe(1);
    expect(isoWeekday('2026-10-11')).toBe(7);
  });

  it('finds the Monday of a week, across a month edge', () => {
    expect(mondayOf('2026-10-09')).toBe('2026-10-05');
    expect(mondayOf('2026-10-05')).toBe('2026-10-05');
    expect(mondayOf('2026-11-01')).toBe('2026-10-26');
  });
});

describe('rangeFor', () => {
  it('a day is that day', () => {
    expect(rangeFor('day', '2026-10-09')).toEqual({ from: '2026-10-09', to: '2026-10-09' });
  });

  it('a week is Monday to Sunday', () => {
    expect(rangeFor('week', '2026-10-09')).toEqual({ from: '2026-10-05', to: '2026-10-11' });
  });

  it('a month is its whole grid, neighbouring days included', () => {
    // October 2026: Thursday the 1st, Saturday the 31st.
    expect(rangeFor('month', '2026-10-09')).toEqual({ from: '2026-09-28', to: '2026-11-01' });
    // February 2027 starts on a Monday and ends on a Sunday: exactly 4 weeks.
    expect(rangeFor('month', '2027-02-14')).toEqual({ from: '2027-02-01', to: '2027-02-28' });
  });

  it('never needs more than six weeks', () => {
    // August 2027: Sunday the 1st, Tuesday the 31st, the longest grid.
    const { from, to } = rangeFor('month', '2027-08-15');
    expect(datesOf(from, to)).toHaveLength(42);
  });
});

describe('step', () => {
  it('moves a month to the 1st, so the 31st never skips a month', () => {
    expect(step('month', '2027-01-31', 1)).toBe('2027-02-01');
    expect(step('month', '2027-01-31', -1)).toBe('2026-12-01');
  });

  it('moves a week by seven days and a day by one', () => {
    expect(step('week', '2026-10-09', 1)).toBe('2026-10-16');
    expect(step('day', '2026-12-31', 1)).toBe('2027-01-01');
  });
});

describe('isView', () => {
  it('accepts the three views and nothing else', () => {
    expect(isView('month')).toBe(true);
    expect(isView('year')).toBe(false);
    expect(isView(null)).toBe(false);
  });
});

describe('monthOptions', () => {
  it('offers a year either side of today, across year ends', () => {
    const months = monthOptions('2026-10-09', '2026-10-09');
    expect(months).toHaveLength(25);
    expect(months[0]).toBe('2025-10');
    expect(months[24]).toBe('2027-10');
    expect(months).toContain('2027-01');
  });

  it('keeps the month on screen when it is further out', () => {
    const months = monthOptions('2026-10-09', '2029-03-15');
    expect(months).toHaveLength(26);
    expect(months.at(-1)).toBe('2029-03');
  });
});
