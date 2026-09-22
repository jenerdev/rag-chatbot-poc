// retrieve.ts — question -> standalone query -> two searches -> one ranked list.

import { chat } from '@rag/openai';
import { supabase } from '@rag/db';
import type { FtsRow, MatchRow } from '@rag/db';
import { CANDIDATE_COUNT, MATCH_COUNT, MIN_SIMILARITY, REWRITE_MAX_TOKENS, RRF_K } from './constants.js';
import type { FoundBy, HistoryMessage, RetrievedChunk, TenantContext } from './types.js';

/**
 * Turn a follow-up question into one that can be searched on its own.
 *
 * THE PROBLEM THIS SOLVES
 * -----------------------
 * Conversation history is sent to the model, but it is never sent to the
 * retriever. The shape of the pipeline makes the gap obvious:
 *
 *     history  ------------------------------> buildPrompt -> model
 *     question -> embed -> search -----------> buildPrompt
 *
 * So a follow-up carrying no nouns of its own gets embedded as a vector
 * pointing nowhere. Measured on this build: after a turn about the Operations
 * Director, "When did they join?" retrieved ZERO chunks and returned the
 * refusal - even though the answer is in the document.
 *
 * The fix is one cheap model call that resolves the references before
 * embedding, so "When did they join?" plus the history becomes "When did
 * Marisol Venn join Northwind Labs?", which retrieves perfectly well.
 *
 * WHAT IS REWRITTEN AND WHAT IS NOT
 * ---------------------------------
 * Only the SEARCH QUERY. The model that writes the answer still receives the
 * user's original words, because an answer to a silently reworded question
 * reads strangely - the user asked "when did they join?" and should not get a
 * reply addressing "when did Marisol Venn join Northwind Labs?".
 *
 * COST
 * ----
 * One extra chat call per turn that has history: roughly the size of the
 * history in, a handful of tokens out. No call at all on the first message of
 * a conversation, which is the only guard that is always correct - a
 * pronoun-spotting heuristic would be cheaper and would sometimes be wrong.
 *
 * @returns the query to search with; the original question if nothing changed
 */
export async function rewriteQuestion(
  history: HistoryMessage[],
  question: string,
): Promise<string> {
  // Nothing to resolve against on the first message of a conversation.
  if (history.length === 0) return question;

  const transcript = history
    .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
    .join('\n');

  const rewritten = await chat(
    [
      {
        role: 'system',
        content: [
          'You rewrite a follow-up question into a standalone search query.',
          'Replace pronouns and references like "they", "that one" or "it"',
          'with the specific names and nouns from the conversation.',
          'If the question already stands on its own, repeat it unchanged.',
          'Reply with the rewritten question ONLY - no quotes, no explanation.',
        ].join('\n'),
      },
      {
        role: 'user',
        content: `Conversation so far:\n${transcript}\n\nFollow-up question: ${question}`,
      },
    ],
    // temperature 0: this is a mechanical transformation, not a creative one.
    // Two identical conversations should rewrite identically.
    { maxTokens: REWRITE_MAX_TOKENS, temperature: 0, label: 'rewrite' },
  );

  const cleaned = rewritten.trim().replace(/^["']|["']$/g, '');

  // Guard against a rewriter that misbehaves: an empty answer, or a paragraph
  // where a question was asked for. Searching with either would be worse than
  // searching with the original, so fall back rather than trust it blindly.
  if (cleaned === '' || cleaned.length > question.length + 200) {
    console.log('[rewrite] rejected an implausible rewrite; using the original question');
    return question;
  }

  if (cleaned !== question) console.log(`[rewrite] "${question}" -> "${cleaned}"`);
  return cleaned;
}

/**
 * Find the chunks most likely to answer a question, using BOTH searches.
 *
 * Why two searches (D-015). Embeddings encode meaning, so vector search is
 * good at paraphrases and bad at identifiers — measured here, "extension 4417"
 * scored 0.284 while a vague paraphrase scored 0.401, even though the exact
 * string is in the document. Keyword search has precisely the opposite bias.
 * Neither covers the other's blind spot, so run both.
 *
 * WHY FUSE BY RANK AND NOT BY SCORE
 * ---------------------------------
 * The two searches return numbers that cannot be compared. Cosine similarity
 * is roughly 0..1 and clusters tightly — everything relevant here lands
 * between 0.28 and 0.55. `ts_rank` is unbounded-ish, differently distributed,
 * and a "good" value depends on the document. Averaging them, or weighting
 * them 0.7/0.3, means inventing an exchange rate between two currencies that
 * have none.
 *
 * Reciprocal Rank Fusion sidesteps that entirely by throwing the scores away
 * and keeping only the ORDER each search put things in:
 *
 *     score(chunk) = sum over each list of  1 / (RRF_K + rank_in_that_list)
 *
 * Rank 1 contributes 1/61, rank 2 contributes 1/62, and so on. A chunk that
 * both searches liked collects two contributions and rises above a chunk that
 * only one of them found — which is exactly the behaviour we want, and it
 * needs no tuning to get it.
 *
 * TENANCY: both searches filter by tenant INSIDE the SQL function, before the
 * `limit`, so another tenant's chunk never takes up a candidate slot. Filtering
 * here, after the rows came back, would be too late: ten slots full of the
 * wrong tenant would fuse into zero results. Nothing in this function can
 * reach another tenant's chunks, because `p_tenant_id` is required in SQL and
 * in the types.
 *
 * @returns chunks ordered best-first, each tagged with which search found it
 */
export async function retrieve(
  tenant: TenantContext,
  question: string,
  questionVector: number[],
): Promise<RetrievedChunk[]> {
  // The two searches are independent, so run them at the same time. Both are
  // Postgres round trips; doing them in sequence would just be slower.
  const [vectorResult, keywordResult] = await Promise.all([
    supabase.rpc('match_chunks', {
      query_embedding: questionVector,
      p_tenant_id: tenant.id,
      match_count: CANDIDATE_COUNT,
      min_similarity: MIN_SIMILARITY,
    }),
    supabase.rpc('match_chunks_fts', {
      query_text: question,
      query_embedding: questionVector,
      p_tenant_id: tenant.id,
      match_count: CANDIDATE_COUNT,
    }),
  ]);

  if (vectorResult.error) throw new Error(`Vector search failed: ${vectorResult.error.message}`);
  if (keywordResult.error) {
    throw new Error(
      `Keyword search failed: ${keywordResult.error.message}. ` +
        'Has schema-hybrid.sql been run in the Supabase SQL editor?',
    );
  }

  const vectorHits: MatchRow[] = vectorResult.data;
  const keywordHits: FtsRow[] = keywordResult.data;

  // Fuse. Keyed by chunk id so the same chunk found by both searches is one
  // entry that accumulates both contributions.
  const fused = new Map<number, RetrievedChunk>();

  const add = (chunk: MatchRow, rank: number, foundBy: FoundBy): void => {
    const existing = fused.get(chunk.id);
    const contribution = 1 / (RRF_K + rank);
    if (existing) {
      existing.score += contribution;
      existing.foundBy = 'both';
      return;
    }
    fused.set(chunk.id, { ...chunk, score: contribution, foundBy });
  };

  // rank is 1-based: the first result of each list is rank 1.
  vectorHits.forEach((chunk, i) => add(chunk, i + 1, 'vector'));
  keywordHits.forEach((chunk, i) => add(chunk, i + 1, 'keyword'));

  const merged = [...fused.values()].sort((a, b) => b.score - a.score).slice(0, MATCH_COUNT);

  console.log(
    `[retrieve] ${tenant.slug} vector:${vectorHits.length} keyword:${keywordHits.length} ` +
      `-> fused:${merged.length} [${merged.map((c) => c.foundBy).join(' ')}]`,
  );

  // Note what is NOT filtered here: a chunk found only by keyword search keeps
  // its place even if its similarity is below MIN_SIMILARITY. That is the
  // whole point. The threshold is a gate on *semantic* evidence; an exact
  // keyword match is a different kind of evidence, and holding it to the
  // wrong standard is what made "extension 4417" unanswerable before.
  return merged;
}
