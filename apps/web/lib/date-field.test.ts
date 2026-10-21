import { describe, expect, it } from 'vitest';
import {
  clampDate,
  clockLabel,
  dayName,
  dayState,
  fieldDateLabel,
  isClock,
  isDate,
  monthTitle,
  monthWeeks,
  moveDate,
  normalizeClock,
  openAt,
  reasonWords,
  stepMonth,
} from './date-field';

describe('labels', () => {
  it('shows a date the way the booking page does', () => {
    expect(fieldDateLabel('2027-10-21')).toBe('Thu, 21 Oct 2027');
    expect(fieldDateLabel('2026-02-01')).toBe('Sun, 1 Feb 2026');
  });

  it('titles a month', () => {
    expect(monthTitle('2027-10')).toBe('October 2027');
  });

  it('knows a real date from a near miss', () => {
    expect(isDate('2026-02-28')).toBe(true);
    expect(isDate('2026-02-30')).toBe(false);
    expect(isDate('2026-2-3')).toBe(false);
    expect(isDate('')).toBe(false);
  });
});

describe('monthWeeks', () => {
  it('starts on Monday and pads the first and last rows with blanks', () => {
    // February 2026 starts on a Sunday and has 28 days: six blanks, then 1.
    const feb = monthWeeks('2026-02');
    expect(feb[0]).toEqual([null, null, null, null, null, null, '2026-02-01']);
    expect(feb.length).toBe(5);
    expect(feb[4]).toEqual(['2026-02-23', '2026-02-24', '2026-02-25', '2026-02-26', '2026-02-27', '2026-02-28', null]);
  });

  it('holds every day of the month exactly once', () => {
    const days = monthWeeks('2026-10').flat().filter((d) => d !== null);
    expect(days.length).toBe(31);
    expect(days[0]).toBe('2026-10-01');
    expect(days[30]).toBe('2026-10-31');
    expect(monthWeeks('2026-10')[0]![3]).toBe('2026-10-01'); // a Thursday
  });

  it('steps months across a year end', () => {
    expect(stepMonth('2026-12', 1)).toBe('2027-01');
    expect(stepMonth('2026-01', -1)).toBe('2025-12');
    expect(stepMonth('2026-03', 12)).toBe('2027-03');
  });
});

describe('moveDate', () => {
  it('moves by a day, a week, to the ends of the week', () => {
    expect(moveDate('2026-10-21', 'ArrowLeft')).toBe('2026-10-20');
    expect(moveDate('2026-10-21', 'ArrowRight')).toBe('2026-10-22');
    expect(moveDate('2026-10-21', 'ArrowUp')).toBe('2026-10-14');
    expect(moveDate('2026-10-21', 'ArrowDown')).toBe('2026-10-28');
    expect(moveDate('2026-10-21', 'Home')).toBe('2026-10-19'); // Monday
    expect(moveDate('2026-10-21', 'End')).toBe('2026-10-25'); // Sunday
  });

  it('crosses a month and a year', () => {
    expect(moveDate('2026-10-31', 'ArrowRight')).toBe('2026-11-01');
    expect(moveDate('2026-12-29', 'ArrowDown')).toBe('2027-01-05');
  });

  it('pages by a month, keeping the day where it exists and the last day otherwise', () => {
    expect(moveDate('2026-10-15', 'PageDown')).toBe('2026-11-15');
    expect(moveDate('2026-10-31', 'PageDown')).toBe('2026-11-30');
    expect(moveDate('2026-03-31', 'PageUp')).toBe('2026-02-28');
    expect(moveDate('2026-10-15', 'PageDown', true)).toBe('2027-10-15');
  });

  it('ignores other keys', () => {
    expect(moveDate('2026-10-21', 'Enter')).toBeNull();
    expect(moveDate('2026-10-21', 'a')).toBeNull();
  });
});

describe('bounds and reasons', () => {
  const closed = new Map([['2026-12-25', 'Christmas']]);
  const bounds = { min: '2026-10-21', max: '2027-10-21', closed };

  it('clamps', () => {
    expect(clampDate('2026-01-01', '2026-10-21', '2027-10-21')).toBe('2026-10-21');
    expect(clampDate('2030-01-01', '2026-10-21', '2027-10-21')).toBe('2027-10-21');
    expect(clampDate('2026-12-01', '2026-10-21', '2027-10-21')).toBe('2026-12-01');
    expect(clampDate('2026-12-01')).toBe('2026-12-01');
  });

  it('says why a day cannot be chosen', () => {
    expect(dayState('2026-10-20', bounds)).toEqual({ selectable: false, reason: 'before' });
    expect(dayState('2027-10-22', bounds)).toEqual({ selectable: false, reason: 'after' });
    expect(dayState('2026-12-25', bounds)).toEqual({ selectable: false, reason: 'closed', label: 'Christmas' });
    expect(dayState('2026-12-24', bounds)).toEqual({ selectable: true, reason: null });
    expect(reasonWords(dayState('2026-10-20', bounds), bounds)).toBe('before the earliest date, Wed, 21 Oct 2026');
    expect(reasonWords(dayState('2026-12-25', bounds), bounds)).toBe('closed (Christmas)');
    expect(reasonWords(dayState('2026-12-24', bounds), bounds)).toBe('');
  });

  it('names a day with today and its reason', () => {
    expect(dayName('2026-10-21', '2026-10-21', dayState('2026-10-21', bounds), bounds)).toBe('Wednesday 21 October 2026, today');
    expect(dayName('2026-12-25', '2026-10-21', dayState('2026-12-25', bounds), bounds)).toBe('Friday 25 December 2026, closed (Christmas)');
  });

  it('opens on the value, else today within the bounds, else the earliest day, else the fallback', () => {
    expect(openAt('2027-01-05', '2026-10-21', bounds, '2000-01-01')).toBe('2027-01-05');
    expect(openAt('', '2026-10-21', bounds, '2000-01-01')).toBe('2026-10-21');
    expect(openAt('', '2026-01-01', bounds, '2000-01-01')).toBe('2026-10-21'); // today before min: clamped
    expect(openAt('', undefined, bounds, '2000-01-01')).toBe('2026-10-21');
    expect(openAt('', undefined, {}, '2026-05-05')).toBe('2026-05-05');
    expect(openAt('not a date', undefined, {}, '2026-05-05')).toBe('2026-05-05');
  });
});

describe('the time field', () => {
  it('reads a 24-hour time as 12-hour words', () => {
    expect(clockLabel('14:00')).toBe('2:00 PM');
    expect(clockLabel('00:05')).toBe('12:05 AM');
    expect(clockLabel('12:30')).toBe('12:30 PM');
    expect(clockLabel('24:00')).toBeNull();
    expect(clockLabel('9:00')).toBeNull();
    expect(isClock('09:00')).toBe(true);
  });

  it('puts the colon in as the person types and keeps a half-typed time', () => {
    expect(normalizeClock('1')).toBe('1');
    expect(normalizeClock('14')).toBe('14');
    expect(normalizeClock('140')).toBe('14:0');
    expect(normalizeClock('1400')).toBe('14:00');
    expect(normalizeClock('14:00')).toBe('14:00');
    expect(normalizeClock('14:')).toBe('14:');
    expect(normalizeClock('2 pm')).toBe('2');
    expect(normalizeClock('14:005')).toBe('14:00');
  });
});
