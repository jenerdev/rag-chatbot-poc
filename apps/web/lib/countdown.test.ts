import { describe, expect, it } from 'vitest';
import { timeLeft } from './countdown';

const s = 1000;
const m = 60 * s;
const h = 60 * m;

describe('timeLeft', () => {
  it.each([
    [2 * 24 * h + 3 * h + 41 * m + 5 * s, '2d 3h 41m 05s'],
    [24 * h, '1d 0h 0m 00s'],
    [23 * h + 41 * m + 59 * s, '23h 41m 59s'],
    [h, '1h 0m 00s'],
    [41 * m + 5 * s, '41m 05s'],
    [9 * s + 999, '0m 09s'],
    [0, '0m 00s'],
    [-5 * m, '0m 00s'],
  ])('%i ms → %s', (left, words) => {
    expect(timeLeft(left)).toBe(words);
  });
});
