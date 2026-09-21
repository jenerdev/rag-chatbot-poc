// The chunker's own tests.
//
// `tools/parity.mjs` proves this package matches the JS it was ported from.
// That is a migration check and it dies with `apps/legacy-poc`. These tests
// outlive it: they state what the chunker is supposed to do, so that the next
// person to touch it finds out immediately rather than in a similarity score.
//
// Each case is one of the behaviours D-018 was written to get right.

import { describe, expect, it } from 'vitest';
import { CHUNK_OVERLAP, CHUNK_SIZE, chunkText, estimateChunkCount } from './index.js';

describe('the frozen constants', () => {
  // These were set by measurement (notes.md § 5.1, § 5.2). A change here is a
  // change to every stored chunk, and it does not error — it just quietly
  // re-chunks the next document differently from the ones already in the
  // database.
  it('are 1000 and 150', () => {
    expect(CHUNK_SIZE).toBe(1000);
    expect(CHUNK_OVERLAP).toBe(150);
  });
});

describe('chunkText — the trivial cases', () => {
  it('returns nothing for empty or whitespace-only text', () => {
    expect(chunkText('')).toEqual([]);
    expect(chunkText('   \n\n  \t ')).toEqual([]);
  });

  it('returns one trimmed chunk when the text fits', () => {
    expect(chunkText('  Short enough.  ')).toEqual(['Short enough.']);
  });
});

describe('chunkText — paragraph boundaries', () => {
  it('packs whole paragraphs together rather than cutting at the ceiling', () => {
    const paragraph = 'z'.repeat(400);
    const chunks = chunkText([paragraph, paragraph, paragraph].join('\n\n'), 1000, 150);

    // Two 400s fit in 1000; the third starts a new chunk. Nothing is cut
    // mid-paragraph, so every chunk boundary falls on a blank line.
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toBe(`${paragraph}\n\n${paragraph}`);
    expect(chunks[1]?.endsWith(paragraph)).toBe(true);
  });

  it('does not split on a single newline', () => {
    // Wrapped prose and list items use single newlines. Splitting on those
    // would shred a list into one chunk per bullet.
    const list = Array.from({ length: 40 }, (_, i) => `- item number ${i}`).join('\n');
    expect(chunkText(list, 1000, 150)).toHaveLength(1);
  });

  it('carries an overlap tail that starts on a word boundary', () => {
    const a = `${'alpha '.repeat(80)}END-OF-FIRST`;
    const b = 'beta '.repeat(80);
    const chunks = chunkText(`${a}\n\n${b}`, 600, 150);

    expect(chunks.length).toBeGreaterThan(1);
    const second = chunks[1] ?? '';
    // The repeated text must not begin mid-word — a fragment like "pha" in an
    // embedding is noise standing where a word should be.
    expect(second.startsWith('pha') || second.startsWith('lpha')).toBe(false);
  });
});

describe('chunkText — the oversized-paragraph fallback', () => {
  it('slides a window over a paragraph longer than the ceiling', () => {
    const chunks = chunkText('x'.repeat(2500), 1000, 150);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(1000);
    // No trailing fragment already contained in the piece before it.
    expect(chunks.at(-1)?.length).toBeGreaterThan(CHUNK_OVERLAP);
  });

  it('keeps a heading attached to the long paragraph it labels', () => {
    // The shape that made this a special case: without folding `current` into
    // the split, "# Refund Policy" is emitted as a ~15-character chunk that
    // burns a MATCH_COUNT slot and carries no answer.
    const chunks = chunkText(`# Refund Policy\n\n${'word '.repeat(400)}`, 1000, 150);

    expect(chunks[0]?.startsWith('# Refund Policy')).toBe(true);
    expect(chunks[0]?.length).toBeGreaterThan(100);
  });

  it('handles text with no blank lines at all', () => {
    const wall = 'sentence. '.repeat(500);
    const chunks = chunkText(wall, 1000, 150);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join('')).toContain('sentence.');
  });
});

describe('chunkText — the guards', () => {
  it('rejects a non-string, because the browser has no types', () => {
    // @ts-expect-error — deliberately wrong, which is the point of the guard
    expect(() => chunkText(null)).toThrow(/must be a string/);
  });

  it('rejects an overlap that would make the window never advance', () => {
    // overlap >= size means step <= 0 and the fallback loop spins forever.
    expect(() => chunkText('text', 100, 100)).toThrow(/must be >= 0 and < size/);
    expect(() => chunkText('text', 100, 150)).toThrow(/must be >= 0 and < size/);
    expect(() => chunkText('text', 0)).toThrow(/greater than 0/);
  });
});

describe('estimateChunkCount', () => {
  it('is 0 for nothing and 1 for anything that fits', () => {
    expect(estimateChunkCount(0)).toBe(0);
    expect(estimateChunkCount(1)).toBe(1);
    expect(estimateChunkCount(CHUNK_SIZE)).toBe(1);
  });

  it('is an estimate, and is allowed to be wrong in both directions', () => {
    // Documented in the source: six 300-char paragraphs predicts 2, produces 3.
    const text = Array.from({ length: 6 }, () => 'y'.repeat(300)).join('\n\n');
    expect(estimateChunkCount(text.length)).toBe(2);
    expect(chunkText(text).length).toBe(3);
  });
});
