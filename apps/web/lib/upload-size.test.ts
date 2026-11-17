import { describe, expect, it } from 'vitest';
import { declaredSizeRefusal, ENVELOPE_BYTES } from './upload-size';

// Audit S-16 (D-171).
const MAX = 5 * 1024 * 1024;
const TOO_LARGE = 'The photo is too large; the limit is 5 MB.';

describe('declaredSizeRefusal', () => {
  it('refuses a missing, empty or unreadable length (411), before the body is read', () => {
    for (const header of [null, '', '  ', 'abc', '-5', '1.5', '12e6']) {
      expect(declaredSizeRefusal(header, MAX, TOO_LARGE)?.status).toBe(411);
    }
  });
  it('refuses a declared length over the limit plus the envelope, in the route\'s words (400)', () => {
    expect(declaredSizeRefusal(String(MAX + ENVELOPE_BYTES + 1), MAX, TOO_LARGE)).toEqual({ status: 400, error: TOO_LARGE });
  });
  it('lets a length within the limit and the envelope through', () => {
    expect(declaredSizeRefusal(String(MAX + ENVELOPE_BYTES), MAX, TOO_LARGE)).toBeNull();
    expect(declaredSizeRefusal('1024', MAX, TOO_LARGE)).toBeNull();
    expect(declaredSizeRefusal(' 2048 ', MAX, TOO_LARGE)).toBeNull();
  });
});
