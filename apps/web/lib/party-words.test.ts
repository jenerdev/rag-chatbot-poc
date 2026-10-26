import { describe, expect, it } from 'vitest';
import { freeFieldLabel, freeGuestsWords, partyWords } from './party-words';

// D-147: the same strings packages/bookings/src/validate.test.ts pins for the
// package's copies (freeGuestsWords, partyWords), so the two cannot drift.
describe('party-words (D-147)', () => {
  it('prints the party the same everywhere', () => {
    expect(partyWords(4, 0)).toBe('4 guests');
    expect(partyWords(1, 0)).toBe('1 guest');
    expect(partyWords(4, 1)).toBe('4 guests + 1 child (free)');
    expect(partyWords(2, 2)).toBe('2 guests + 2 children (free)');
  });
  it('says the rule once, in one way', () => {
    expect(freeGuestsWords(null)).toBeNull();
    expect(freeGuestsWords(3)).toBe('Children aged 3 and below stay free.');
    expect(freeGuestsWords(0)).toBe('Infants under 1 stay free.');
    expect(freeFieldLabel(3)).toBe('Children aged 3 and below');
    expect(freeFieldLabel(0)).toBe('Infants under 1');
  });
});
