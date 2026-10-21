// embed-cache.ts — a question's embedding, remembered (2026-10-21).
//
// Every chat turn embeds its search query (answer.ts step 4). The same text
// comes back often: a tenant's suggested questions (D-089) are sent as
// written, and visitors repeat each other. The vector for a given text and
// model never changes, so the second request need not cross the network:
// one round trip to OpenAI, about 100–200 ms, saved per hit. The money is
// nothing either way (embeddings cost cents per million tokens); this buys
// latency.
//
// In memory, in THIS process, bounded, least recently used out first. Not a
// table: a table any token could read needs a policy (R-22), a definer and
// its checks, for a saving an in-process map gives for free; each server
// instance warms its own, which is fine for a cache.
//
// The key carries the MODEL. Trap 1 (CLAUDE.md): a vector from another
// model looks right and means nothing, so a change of OPENAI_EMBEDDING_MODEL
// in .env (read per call, D-005) must miss. It does: it is a different key.
//
// Only the QUERY side uses this. Ingest embeds chunks that are new by
// definition and would only fill the map.

import { embed } from '@rag/openai';
import { EMBED_CACHE_SIZE } from './constants.js';

type Embedder = (texts: string[]) => Promise<number[][]>;

/** Insertion order is the recency order: a hit is deleted and set again, so it moves to the end. */
const cache = new Map<string, number[]>();

/** Text and model together: the same words under another model are another vector. */
export function embedCacheKey(text: string, model: string | undefined = process.env.OPENAI_EMBEDDING_MODEL): string {
  return `${model ?? ''}\n${text}`;
}

/**
 * The embedding of one query, from the cache when it has been asked before
 * under the current model, else from `embedder` (OpenAI, by default; a fake
 * in tests). The vector handed back is the cached array itself: read it,
 * never change it.
 */
export async function embedQuery(text: string, embedder: Embedder = embed): Promise<number[]> {
  const key = embedCacheKey(text);
  const hit = cache.get(key);
  if (hit !== undefined) {
    cache.delete(key);
    cache.set(key, hit);
    console.log(`[query] embedding from cache (${cache.size} held)`);
    return hit;
  }
  const [vector] = await embedder([text]);
  if (vector === undefined) throw new Error('embedQuery: the embedder returned nothing');
  cache.set(key, vector);
  // Oldest first: the Map iterates in insertion order, and a hit re-inserts.
  while (cache.size > EMBED_CACHE_SIZE) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
  return vector;
}

/** How many vectors are held; for tests and the log. */
export function embedCacheSize(): number {
  return cache.size;
}

/** Forget everything; for tests. */
export function clearEmbedCache(): void {
  cache.clear();
}
