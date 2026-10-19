import { describe, expect, it } from 'vitest';
import { MAX_SPOKEN_CHARS, speakable } from './speakable';

describe('speakable', () => {
  it('leaves a plain sentence as it is', () => {
    expect(speakable('The pool opens at 8 AM.')).toBe('The pool opens at 8 AM.');
  });

  it('drops bold markers, emoji and web addresses', () => {
    expect(speakable('Hi! 👋 Our **Garden Room** sleeps 2 😊 See https://example.com/rooms for more.')).toBe(
      'Hi! Our Garden Room sleeps 2 See for more.',
    );
  });

  it('keeps a peso amount for the voice to read', () => {
    expect(speakable('The Overnight costs ₱20,000.00 on a weekend.')).toBe('The Overnight costs ₱20,000.00 on a weekend.');
  });

  it('turns list lines into sentences, without their bullets', () => {
    expect(speakable('We have:\n- a pool\n- a videoke\n1. a grill')).toBe('We have: a pool. a videoke. a grill.');
  });

  it('reads a table as the names in its first column, then points to the screen', () => {
    const reply = [
      'On 18 October 2026, a weekend, these rooms are open:',
      '',
      '| Room | Guests | Price |',
      '|---|---|---|',
      '| **Casa Uno** | up to 3 | ₱4,800.00 |',
      '| Casa Dos | up to 3 | ₱5,000.00 |',
      '| Familia | up to 6 | ₱8,000.00 |',
      '',
      'Would you like to book one?',
    ].join('\n');
    expect(speakable(reply)).toBe(
      'On 18 October 2026, a weekend, these rooms are open: Casa Uno, Casa Dos and Familia. The details are on your screen. Would you like to book one?',
    );
  });

  it('a one-row table names its one row; a table with empty first cells only points to the screen', () => {
    expect(speakable('| Room | Price |\n|---|---|\n| Loft | ₱4,800.00 |')).toBe('Loft. The details are on your screen.');
    expect(speakable('| Room | Price |\n|---|---|\n|  | ₱4,800.00 |')).toBe('The details are on your screen.');
  });

  it('a long reply ends on a sentence and says where the rest is', () => {
    const long = Array.from({ length: 40 }, (_, i) => `Sentence number ${i + 1} is here.`).join(' ');
    const spoken = speakable(long);
    expect(spoken.length).toBeLessThanOrEqual(MAX_SPOKEN_CHARS);
    expect(spoken).toMatch(/is here\. The rest is on your screen\.$/);
  });

  it('a reply of only emoji says nothing', () => {
    expect(speakable('👍🎉')).toBe('');
  });
});
