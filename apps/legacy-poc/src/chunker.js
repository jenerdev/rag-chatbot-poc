// src/chunker.js — text in, array of strings out.
//
// This file has no imports, no async and no I/O on purpose: chunking is pure
// string arithmetic, and keeping it isolated means you can read and reason
// about it without a network, a database or an API key anywhere in sight.
// (It is also why the same file can be served to the browser for the live
// chunk estimate on the admin page — see server.js.)
//
// Chunking decides retrieval quality more than the model does, and it is the
// step most people never look at.

// How big each chunk may get, in CHARACTERS (not tokens — D-007).
//
// Too small: a chunk loses the context that gave it meaning.
//   "It must be returned within 30 days." — returned where, by whom?
// Too large: the embedding becomes an average of several topics and matches
//   nothing well. One vector has to stand for the whole chunk, so a chunk
//   covering four subjects points somewhere between all four.
//
// Characters rather than tokens because counting tokens needs a tokenizer
// dependency, and ~4 characters ≈ 1 token for English is close enough here.
//
// Note this is a CEILING rather than a target: paragraph-aware chunking stops
// at the last paragraph that fits, so real chunks vary in size (D-018).
export const CHUNK_SIZE = 1000;

// How much of the previous chunk each chunk repeats.
//
// Without overlap, a hard cut can split a fact in two, leaving neither piece
// able to answer a question about it:
//   chunk 1: "...refunds are accepted within"
//   chunk 2: "30 days of delivery..."
// With overlap, the tail of chunk 1 is repeated at the head of chunk 2, so the
// sentence survives whole somewhere. The cost is duplicated text: roughly
// CHUNK_OVERLAP / CHUNK_SIZE extra stored and embedded, here about 15%.
//
// Paragraph-aware splitting makes mid-sentence cuts rare, but overlap stays as
// the safety net for the two cases it cannot help with: a paragraph longer
// than CHUNK_SIZE, and text pasted with no blank lines in it at all.
//
// ⚠️ Since D-018 the overlap is NOT always applied. When the carried tail plus
// the next paragraph would exceed CHUNK_SIZE, the tail is dropped so the
// paragraph itself survives whole — measured, that happens on every boundary
// once paragraphs pass roughly (CHUNK_SIZE - CHUNK_OVERLAP) characters. It is
// the right trade (a paragraph boundary is already a safe place to cut) but it
// does mean "every chunk repeats 150 characters of the last one" is no longer
// true, and anything shown to a user must not claim otherwise.
export const CHUNK_OVERLAP = 150;

// What counts as a paragraph break: a blank line, however much whitespace it
// happens to contain. Deliberately NOT a single newline — wrapped prose and
// list items use single newlines, and splitting on those would shred a list
// into one chunk per bullet.
const PARAGRAPH_BREAK = /\n\s*\n/;

/**
 * The last `overlap` characters of a chunk, to repeat at the head of the next.
 *
 * Trimmed forward to the next whitespace so the repeated text does not begin
 * mid-word, which would put a meaningless fragment into the embedding.
 */
function overlapTail(text, overlap) {
  if (overlap <= 0 || text.length <= overlap) return text;
  const tail = text.slice(-overlap);
  const firstSpace = tail.search(/\s/);
  return firstSpace === -1 ? tail : tail.slice(firstSpace + 1);
}

/**
 * Split one oversized paragraph with a sliding character window.
 *
 * This is the original naive chunker, kept as the fallback. It handles the two
 * cases paragraph boundaries cannot: a single paragraph longer than CHUNK_SIZE,
 * and text pasted as one unbroken wall with no blank lines in it at all.
 */
function splitLongParagraph(paragraph, size, overlap) {
  const step = size - overlap;
  const pieces = [];
  for (let start = 0; start < paragraph.length; start += step) {
    pieces.push(paragraph.slice(start, start + size));
    // Stop as soon as this piece reached the end, otherwise the loop keeps
    // stepping forward and emits ever-shorter tails already fully contained in
    // the piece before them.
    if (start + size >= paragraph.length) break;
  }
  return pieces;
}

/**
 * Split text into chunks, preferring paragraph boundaries.
 *
 * The rule: pack whole paragraphs into a chunk until the next one would not
 * fit, then start a new chunk. A paragraph larger than `size` is the only
 * thing that gets cut mid-flow, and it falls back to the sliding window.
 *
 * WHY THIS BEATS CUTTING AT CHARACTER 1000
 * ----------------------------------------
 * A chunk is represented by exactly one embedding. A chunk holding one
 * complete idea embeds cleanly; a chunk holding the end of one idea plus the
 * start of another embeds as a blur of the two. Cutting at a fixed offset
 * guarantees the second kind at every single boundary.
 *
 * It also stops a fact being orphaned from its subject. Measured on a test
 * document where "Presidential Suite" and its nightly rate landed in different
 * fixed-size chunks: the chunk holding the rate scored **0.384** against
 * "what is the nightly rate for the Presidential Suite?" while the chunk that
 * merely named the suite, without the price, scored **0.498**. The chunk with
 * the answer ranked BELOW the chunk without it, because the cut had separated
 * it from the words that made it findable.
 *
 * @param {string} text
 * @param {number} size    maximum characters per chunk
 * @param {number} overlap characters each chunk repeats from the previous one
 * @returns {string[]}
 */
export function chunkText(text, size = CHUNK_SIZE, overlap = CHUNK_OVERLAP) {
  if (typeof text !== 'string') throw new Error('chunkText: text must be a string');
  if (size <= 0) throw new Error('chunkText: size must be greater than 0');
  // If overlap >= size the sliding-window fallback never advances and the loop
  // runs forever. Fail loudly here rather than hanging the server later.
  if (overlap < 0 || overlap >= size) {
    throw new Error(`chunkText: overlap (${overlap}) must be >= 0 and < size (${size})`);
  }

  const clean = text.trim();
  if (clean === '') return [];
  if (clean.length <= size) return [clean];

  const paragraphs = clean
    .split(PARAGRAPH_BREAK)
    .map((p) => p.trim())
    .filter((p) => p !== '');

  const chunks = [];
  let current = '';
  // True when `current` holds nothing but the overlap carried over from the
  // previous chunk. Without this flag that carried tail gets emitted as a
  // chunk of its own at the end — a duplicate fragment with no new content.
  let carriedOnly = true;

  // Close off the chunk being built, and seed the next one with its overlap
  // tail so the boundary is covered from both sides.
  const flush = () => {
    if (current === '' || carriedOnly) return;
    chunks.push(current);
    current = overlapTail(current, overlap);
    carriedOnly = true;
  };

  for (const paragraph of paragraphs) {
    // Too big to ever fit: hard-split it with the sliding window, which
    // applies its own overlap internally.
    //
    // Whatever is already in `current` is folded into the front of the text
    // being split rather than flushed as a chunk of its own. Without that, the
    // extremely common shape
    //
    //     # Refund Policy
    //
    //     <1200 characters of policy>
    //
    // emits "# Refund Policy" as a 15-character chunk: it burns an embedding
    // and a MATCH_COUNT slot, carries no answer, and severs the heading from
    // the text it labels — which is the exact "fact orphaned from its subject"
    // failure this whole function exists to prevent.
    if (paragraph.length > size) {
      const combined = current === '' ? paragraph : `${current}\n\n${paragraph}`;
      const pieces = splitLongParagraph(combined, size, overlap);
      chunks.push(...pieces);
      current = overlapTail(pieces[pieces.length - 1], overlap);
      carriedOnly = true;
      continue;
    }

    const candidate = current === '' ? paragraph : `${current}\n\n${paragraph}`;
    if (candidate.length <= size) {
      current = candidate;
      carriedOnly = false;
      continue;
    }

    // Does not fit: close the current chunk, then start the next one from its
    // overlap tail plus this paragraph.
    flush();
    const withTail = current === '' ? paragraph : `${current}\n\n${paragraph}`;
    // If tail plus paragraph still busts the ceiling, drop the tail rather
    // than the content — the paragraph itself is what has to survive.
    current = withTail.length > size ? paragraph : withTail;
    carriedOnly = false;
  }

  if (current !== '' && !carriedOnly) chunks.push(current);

  return chunks;
}

/**
 * Roughly how many chunks a given length of text will produce.
 *
 * The admin page shows this live as you type, before anything is sent to the
 * server — chunking made visible *before* you commit to it (screens.md § S-2).
 *
 * It is an ESTIMATE and always was, but since D-018 it is a looser one, and it
 * errs in BOTH directions. Real chunks stop at the last paragraph that fits
 * rather than filling to exactly `size`, and the overlap is sometimes dropped.
 * Measured against the real chunker:
 *
 *     1050-char paragraph + 100-char paragraph  ->  predicts 2, actually 3
 *     six 300-char paragraphs                   ->  predicts 2, actually 3
 *
 * Computing the real number needs the text itself, not just its length — which
 * is what `chunkText` is for. This exists only to put a number on screen while
 * someone is still typing, and the UI must present it as approximate.
 */
export function estimateChunkCount(length, size = CHUNK_SIZE, overlap = CHUNK_OVERLAP) {
  if (length <= 0) return 0;
  if (length <= size) return 1;
  return Math.ceil((length - overlap) / (size - overlap));
}
