import { describe, expect, it } from 'vitest';
import { dayWords, slotEnd } from './slot-span';

describe('slotEnd', () => {
  it.each([
    ['08:00', 420, { time: '15:00', days: 0 }],
    ['14:00', 1320, { time: '12:00', days: 1 }],
    ['22:30', 90, { time: '00:00', days: 1 }],
    ['09:15', 45, { time: '10:00', days: 0 }],
    ['06:00', 2880, { time: '06:00', days: 2 }],
  ])('%s for %i minutes → %o', (start, minutes, end) => {
    expect(slotEnd(start, minutes)).toEqual(end);
  });
  it('is null for a missing start or a length of zero', () => {
    expect(slotEnd('', 60)).toBeNull();
    expect(slotEnd('08:00', 0)).toBeNull();
  });
});

describe('dayWords', () => {
  it('says the day in words', () => {
    expect([dayWords(0), dayWords(1), dayWords(2)]).toEqual(['the same day', 'the next day', '2 days later']);
  });
});
