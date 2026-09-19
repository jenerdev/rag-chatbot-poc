// src/chunker.js — text in, array of strings out.
//
// This file has no imports, no async and no I/O on purpose: chunking is pure
// string arithmetic, and keeping it isolated means you can read and reason
// about it without a network, a database or an API key anywhere in sight.
//
// Chunking decides retrieval quality more than the model does, and it is the
// step most people never look at. The two knobs below are the whole of it.

// How big each chunk is, in CHARACTERS (not tokens — D-007).
//
// Too small: a chunk loses the surrounding context that gave it meaning.
//   "It must be returned within 30 days." — returned to where? by whom?
// Too large: the embedding becomes an average of several topics and matches
//   nothing well. One vector has to stand for the whole chunk, so a chunk
//   covering four subjects points somewhere between all four.
//
// Characters rather than tokens because counting tokens needs a tokenizer
// dependency, and ~4 characters ≈ 1 token for English is close enough here.
export const CHUNK_SIZE = 1000;

// How much of the previous chunk each chunk repeats.
//
// Without overlap, a hard cut can land mid-sentence and split a fact in two,
// leaving neither piece able to answer a question about it:
//   chunk 1: "...refunds are accepted within"
//   chunk 2: "30 days of delivery..."
// Neither chunk alone matches "how long do I have to return something?" well.
// With overlap, the tail of chunk 1 is repeated at the head of chunk 2, so the
// sentence survives whole somewhere. The cost is duplicated text: you store and
// embed roughly CHUNK_OVERLAP / CHUNK_SIZE extra, here about 15%.
export const CHUNK_OVERLAP = 150;

/**
 * Split text into overlapping fixed-size chunks.
 *
 * Deliberately naive (D-007). No sentence detection, no paragraph awareness,
 * no token counting — it cuts at a character index and moves on. Smarter
 * chunkers are a real improvement at scale, but starting with one means never
 * developing the intuition for *why* they are better. Phase 5 is about
 * changing these numbers and feeling the difference.
 *
 * @param {string} text
 * @param {number} size    characters per chunk
 * @param {number} overlap characters each chunk repeats from the previous one
 * @returns {string[]}
 */
export function chunkText(text, size = CHUNK_SIZE, overlap = CHUNK_OVERLAP) {
  if (typeof text !== 'string') throw new Error('chunkText: text must be a string');
  if (size <= 0) throw new Error('chunkText: size must be greater than 0');
  // If overlap >= size the window never advances and the loop runs forever.
  // Fail loudly here rather than hanging the server later.
  if (overlap < 0 || overlap >= size) {
    throw new Error(`chunkText: overlap (${overlap}) must be >= 0 and < size (${size})`);
  }

  const clean = text.trim();
  if (clean === '') return [];
  if (clean.length <= size) return [clean];

  // How far the window moves each time. The difference between size and step
  // IS the overlap — that is the entire mechanism.
  const step = size - overlap;
  const chunks = [];

  for (let start = 0; start < clean.length; start += step) {
    chunks.push(clean.slice(start, start + size));
    // Stop as soon as this chunk reached the end of the text. Without this the
    // loop would keep stepping forward and emit ever-shorter tail fragments
    // that are already fully contained in the chunk before them.
    if (start + size >= clean.length) break;
  }

  return chunks;
}

/**
 * How many chunks a given length of text will produce.
 *
 * The admin page shows this live as you type, before anything is sent to the
 * server — chunking made visible *before* you commit to it (screens.md § S-2).
 * Same arithmetic as the loop above, done in closed form.
 */
export function estimateChunkCount(length, size = CHUNK_SIZE, overlap = CHUNK_OVERLAP) {
  if (length <= 0) return 0;
  if (length <= size) return 1;
  return Math.ceil((length - overlap) / (size - overlap));
}
