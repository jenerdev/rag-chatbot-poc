import { describe, expect, it } from 'vitest';
import { listQuery, parseListFilters, questionsLabel, timeLabel, whenLabel } from './conversation-words';

describe('parseListFilters', () => {
  it('reads the three filters', () => {
    expect(parseListFilters({ days: '7', q: 'pool', refused: '1' })).toEqual({ days: 7, q: 'pool', refused: true });
  });
  it('makes anything odd the default', () => {
    expect(parseListFilters({ days: '45', refused: 'yes' })).toEqual({ days: 30, q: '', refused: false });
    expect(parseListFilters({ days: ['90', '7'], q: ['a', 'b'] })).toEqual({ days: 90, q: 'a', refused: false });
  });
});

describe('listQuery', () => {
  it('leaves the defaults out', () => {
    expect(listQuery({ days: 30, q: '  ', refused: false })).toBe('');
  });
  it('round-trips through parseListFilters', () => {
    const f = { days: 90 as const, q: 'check-in & pool', refused: true };
    const query = listQuery(f);
    expect(query).toBe('?days=90&q=check-in+%26+pool&refused=1');
    expect(parseListFilters(Object.fromEntries(new URLSearchParams(query)))).toEqual(f);
  });
});

describe('times in the tenant zone', () => {
  // 16:30 UTC is 00:30 the NEXT day in Manila: the date moves with the zone.
  const iso = '2026-10-12T16:30:00Z';
  it('whenLabel', () => {
    expect(whenLabel(iso, 'Asia/Manila')).toBe('13 Oct 2026, 00:30');
    expect(whenLabel(iso, 'UTC')).toBe('12 Oct 2026, 16:30');
    expect(whenLabel('nope', 'UTC')).toBe('');
  });
  it('timeLabel', () => {
    expect(timeLabel(iso, 'Asia/Manila')).toBe('00:30');
  });
});

describe('questionsLabel', () => {
  it('counts', () => {
    expect(questionsLabel(1)).toBe('1 question');
    expect(questionsLabel(3)).toBe('3 questions');
  });
});
