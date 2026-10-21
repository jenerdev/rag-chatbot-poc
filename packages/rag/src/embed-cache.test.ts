import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EMBED_CACHE_SIZE } from './constants.js';
import { clearEmbedCache, embedCacheKey, embedCacheSize, embedQuery } from './embed-cache.js';

// A fake embedder: one vector per text, its length the text's length, and a
// count of the calls. The cache's whole job is to make that count stay put.
function fake() {
  const calls: string[][] = [];
  const embedder = async (texts: string[]) => {
    calls.push(texts);
    return texts.map((t) => [t.length, 0, 1]);
  };
  return { calls, embedder };
}

describe('embedQuery', () => {
  const model = process.env.OPENAI_EMBEDDING_MODEL;
  beforeEach(() => {
    clearEmbedCache();
    process.env.OPENAI_EMBEDDING_MODEL = 'text-embedding-3-small';
  });
  afterEach(() => {
    process.env.OPENAI_EMBEDDING_MODEL = model;
    clearEmbedCache();
  });

  it('asks the embedder once for a text, and answers the same text from memory', async () => {
    const { calls, embedder } = fake();
    const first = await embedQuery('What are your rates?', embedder);
    const second = await embedQuery('What are your rates?', embedder);
    expect(first).toEqual([20, 0, 1]);
    expect(second).toBe(first);
    expect(calls).toEqual([['What are your rates?']]);
    expect(embedCacheSize()).toBe(1);
  });

  it('a different text is a different call; the exact text is the key, case and spaces included', async () => {
    const { calls, embedder } = fake();
    await embedQuery('Rates?', embedder);
    await embedQuery('rates?', embedder);
    await embedQuery('Rates? ', embedder);
    expect(calls).toHaveLength(3);
  });

  // Trap 1: a vector from another model must never be served for this one.
  it('a change of embedding model misses, because the model is in the key', async () => {
    const { calls, embedder } = fake();
    await embedQuery('Wi-Fi?', embedder);
    process.env.OPENAI_EMBEDDING_MODEL = 'text-embedding-3-large';
    await embedQuery('Wi-Fi?', embedder);
    expect(calls).toHaveLength(2);
    expect(embedCacheKey('x', 'a')).not.toBe(embedCacheKey('x', 'b'));
    expect(embedCacheKey('x')).toBe('text-embedding-3-large\nx');
  });

  it('holds at most EMBED_CACHE_SIZE vectors, dropping the least recently used', async () => {
    const { calls, embedder } = fake();
    await embedQuery('keep', embedder);
    for (let i = 0; i < EMBED_CACHE_SIZE - 1; i += 1) await embedQuery(`q${i}`, embedder);
    expect(embedCacheSize()).toBe(EMBED_CACHE_SIZE);
    // A hit on the oldest entry makes it the newest, so the next miss evicts q0, not it.
    await embedQuery('keep', embedder);
    await embedQuery('one more', embedder);
    expect(embedCacheSize()).toBe(EMBED_CACHE_SIZE);
    const before = calls.length;
    await embedQuery('keep', embedder);
    expect(calls.length).toBe(before);
    await embedQuery('q0', embedder);
    expect(calls.length).toBe(before + 1);
  });

  it('fails loudly when the embedder hands back nothing, and caches nothing', async () => {
    await expect(embedQuery('x', async () => [])).rejects.toThrow('the embedder returned nothing');
    expect(embedCacheSize()).toBe(0);
  });
});
