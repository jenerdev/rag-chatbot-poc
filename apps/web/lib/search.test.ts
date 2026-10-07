import { describe, expect, it } from 'vitest';
import { fold, matches } from './search';

describe('fold', () => {
  it('drops case, accents and extra space', () => {
    expect(fold('  Paraná   CHECK-in ')).toBe('parana check-in');
    expect(fold('Señora Niña')).toBe('senora nina');
  });
});

describe('matches', () => {
  it('matches everything on an empty query', () => {
    expect(matches('anything', '')).toBe(true);
    expect(matches('anything', '   ')).toBe(true);
  });

  it('needs every word, in any order', () => {
    expect(matches('What time is check-in?', 'check time')).toBe(true);
    expect(matches('What time is check-in?', 'check out')).toBe(false);
  });

  it('finds a word inside another', () => {
    expect(matches('What time is check-in?', 'check')).toBe(true);
    expect(matches('Pwede po bang magdala ng aso?', 'dala')).toBe(true);
  });

  it('ignores case and accents on both sides', () => {
    expect(matches('Magkano ang Señorita Suite?', 'senorita')).toBe(true);
    expect(matches('Magkano ang Senorita Suite?', 'SEÑORITA')).toBe(true);
  });

  it('reads Tagalog the same way (villa and harbor ask in it)', () => {
    expect(matches('May bakanteng kwarto ba bukas?', 'bakante bukas')).toBe(true);
    expect(matches('May bakanteng kwarto ba bukas?', 'mamaya')).toBe(false);
  });
});
