// src/rag.js — the pipelines. This file should read top-to-bottom like the
// flowcharts in architecture.md § 3.
//
// It orchestrates the other three modules and contains no HTTP handling: no
// req, no res, no status codes. It throws; server.js decides what that means
// to a browser.

import { chunkText } from './chunker.js';
import { embed, chat, chatStream } from './openai.js';
import { supabase } from './supabase.js';

// ---------------------------------------------------------------------------
// INGEST:  text -> chunks -> embeddings -> rows
// ---------------------------------------------------------------------------

/**
 * Store a document and make it searchable.
 *
 * The flow, matching architecture.md § 3.1:
 *   1. split the text into overlapping chunks
 *   2. insert the documents row
 *   3. embed every chunk in ONE OpenAI call
 *   4. insert the chunks rows, each with its vector
 *
 * @param {{title: string, source?: string, content: string}} input
 * @returns {Promise<{id: number, title: string, chunkCount: number}>}
 */
export async function ingestDocument({ title, source, content }) {
  // 1. Chunk first, before touching the database or the network.
  //    If the text produces nothing, there is no point creating a row.
  const chunks = chunkText(content);
  if (chunks.length === 0) throw new Error('Document is empty after trimming — nothing to ingest');
  console.log(`[ingest] "${title}": ${content.length} chars -> ${chunks.length} chunks`);

  // 2. Insert the parent row. We need its id before the chunks can reference it.
  const { data: doc, error: docError } = await supabase
    .from('documents')
    .insert({ title, source: source || null, content })
    .select('id, title')
    .single();
  if (docError) throw new Error(`Could not save the document: ${docError.message}`);

  // From here on the documents row EXISTS. If anything below fails we must
  // remove it, or we are left with a document that appears in the list but has
  // zero chunks and can therefore never be retrieved — visible, useless, and
  // with nothing to explain why (R-7). This is cleanup, not a transaction:
  // supabase-js speaks HTTP, so there is no BEGIN/COMMIT to wrap this in.
  try {
    // 3. One embeddings call for every chunk in the document (F-3).
    const vectors = await embed(chunks);
    console.log(`[ingest] embedded ${vectors.length} chunks, ${vectors[0].length} dims each`);

    // 4. One insert for all the chunk rows. chunk_index records the position
    //    within the document, which is what lets the admin page show the
    //    chunks in order and makes the overlap visible when you read them.
    const rows = chunks.map((text, index) => ({
      document_id: doc.id,
      chunk_index: index,
      content: text,
      embedding: vectors[index],
    }));

    const { error: chunkError } = await supabase.from('chunks').insert(rows);
    if (chunkError) throw new Error(`Could not save the chunks: ${chunkError.message}`);

    return { id: doc.id, title: doc.title, chunkCount: chunks.length };
  } catch (error) {
    // Roll back the orphan. Deleting the document cascades to any chunks that
    // did land, so this is safe whether the failure happened before or after
    // the chunk insert.
    console.error(`[ingest] failed after creating document ${doc.id} — cleaning up`);
    await supabase.from('documents').delete().eq('id', doc.id);
    throw error;
  }
}

// ---------------------------------------------------------------------------
// The two supporting reads. Plain queries, no pipeline.
// ---------------------------------------------------------------------------

/**
 * Every document, newest first, with how many chunks it became.
 *
 * `chunks(count)` is PostgREST's aggregate over the foreign-key relationship —
 * it counts the related rows without fetching them, which matters because the
 * embeddings are ~6 KB each and we want none of them here.
 *
 * A document showing 0 chunks is the orphan from R-7 and the admin page flags
 * it. It should never happen now that ingest cleans up after itself, but the
 * badge stays: a symptom you can see beats one you cannot.
 */
export async function listDocuments() {
  const { data, error } = await supabase
    .from('documents')
    .select('id, title, source, created_at, chunks(count)')
    .order('created_at', { ascending: false });
  if (error) throw new Error(`Could not list documents: ${error.message}`);

  return data.map((doc) => ({
    id: doc.id,
    title: doc.title,
    source: doc.source,
    created_at: doc.created_at,
    chunkCount: doc.chunks[0]?.count ?? 0,
  }));
}

/**
 * Delete a document. Its chunks go with it.
 *
 * The cascade is declared in schema.sql (`on delete cascade`) and Postgres
 * enforces it, so there is no second delete to write here. This is the half of
 * the project's success criterion that proves retrieval is real: delete the
 * document, ask the same question, and the bot must stop knowing the answer.
 */
export async function deleteDocument(id) {
  const { error, count } = await supabase
    .from('documents')
    .delete({ count: 'exact' })
    .eq('id', id);
  if (error) throw new Error(`Could not delete the document: ${error.message}`);
  return count > 0;
}

/**
 * Every chunk of one document, in order, without its embedding.
 *
 * Powers the expandable row on the admin page. Seeing your own text sliced up —
 * and seeing the overlap repeat across each boundary — is what makes chunking
 * concrete rather than theoretical (screens.md § S-2).
 *
 * The embedding column is deliberately not selected: it is ~6 KB per chunk and
 * a screenful of floats tells you nothing.
 */
export async function getChunks(documentId) {
  const { data, error } = await supabase
    .from('chunks')
    .select('id, chunk_index, content')
    .eq('document_id', documentId)
    .order('chunk_index', { ascending: true });
  if (error) throw new Error(`Could not load chunks: ${error.message}`);
  return data;
}

// ---------------------------------------------------------------------------
// QUERY:  question -> embed -> search -> prompt -> answer
// ---------------------------------------------------------------------------

// How many chunks to retrieve. Every one is pasted into the prompt and billed
// as input tokens on every turn, so this is a direct cost/quality dial.
// 5 × ~1000 chars is roughly 1,250 tokens — comfortable. Phase 5.4 tries 1 and 20.
export const MATCH_COUNT = 5;

// --- hybrid search (post-MVP, D-015) ---------------------------------------

// How many candidates each of the two searches contributes before fusion.
// Retrieving a few more than MATCH_COUNT gives the fusion something to choose
// between; the final list is still trimmed to MATCH_COUNT, so this costs
// database work but not a single extra prompt token.
export const CANDIDATE_COUNT = 10;

// The constant in Reciprocal Rank Fusion. 60 is the value from the original
// paper and is what almost everyone uses. Larger k flattens the difference
// between ranks; smaller k makes the top rank dominate.
export const RRF_K = 60;

// The "do I actually know this?" gate. Below this score, we refuse.
//
// Chosen from measured scores, not guessed (Q-1, roadmap 3.2). Measured on the
// Northwind test corpus with scratch/score-probe.js:
//
//     direct hits          0.46 – 0.54
//     paraphrased          0.40 – 0.45
//     exact identifier     0.28    <- "extension 4417"; vectors are weak here
//     completely off topic 0.04 – 0.10
//
// 0.25 sits in the wide empty gap between 0.10 and 0.28. The original 0.30
// guess would have rejected the "extension 4417" question, which IS answerable
// from the documents — a false refusal.
//
// Note what a threshold CANNOT do: "what is the policy on safety goggles?"
// scored 0.427 — squarely in direct-hit territory — even though the handbook
// never mentions goggles. Same domain, same vocabulary, absent fact. No
// threshold rejects that; only the system prompt's refusal instruction can.
// That is why D-008 calls the short circuit belt-and-braces, not the defence.
//
// This number is corpus-dependent. Re-measure if the documents change a lot.
export const MIN_SIMILARITY = 0.25;

// How many past messages to re-send. The model is stateless: the ENTIRE array
// is uploaded and re-billed on every single turn, so unbounded history makes
// cost grow with the square of conversation length (D-011, costs.md).
export const MAX_HISTORY = 6;

// Longest a rewritten search query may be. The rewriter should produce one
// short question; anything longer means it started explaining itself instead,
// and we fall back to the original rather than searching with prose.
export const REWRITE_MAX_TOKENS = 60;

// The exact refusal string. Defined once because two different code paths can
// produce it — the short circuit below, and the model following its system
// prompt — and the UI should not be able to tell them apart.
export const NO_ANSWER = "I don't know based on the documents I have.";

/**
 * Assemble the messages array sent to the chat model.
 *
 * This is the function frameworks hide, and it is the heart of RAG. Read it and
 * the "magic" disappears: the retrieved chunks are pasted into the system
 * message as plain text. There is no special knowledge-base channel into the
 * model. That is the entire trick (architecture.md § 6).
 */
export function buildPrompt(chunks, history, question) {
  const context = chunks.map((c, i) => `[${i + 1}] ${c.content}`).join('\n\n');

  return [
    {
      // This block is the correctness gate, and Phase 5 measured it failing in
      // BOTH directions, which is why it is worded the way it is.
      //
      // Too loose (5.5, instruction removed): the bot answered "the capital of
      // France is Paris" and produced a 400-word sourdough recipe while citing
      // lab-handbook chunks. Outside knowledge leaking in.
      //
      // Too strict (the original "Do not use outside knowledge. Do not guess."):
      // it refused "who do I contact on extension 4417?" even with the chunk
      // reading "...liaison, currently reachable at extension 4417" in front of
      // it, because answering needs one step of joining two stated facts. And
      // at MATCH_COUNT=1 it invented a reason for the Quiet Hour rather than
      // admit the retrieved chunk only held half the answer.
      //
      // So the wording now separates three things that "do not guess" had
      // collapsed into one: CONNECTING facts that are present (allowed),
      // ADDING facts that are absent (never), and PARTIAL answers (say what is
      // missing rather than invent it). D-017.
      role: 'system',
      content: [
        'You answer questions using ONLY the context below.',
        '',
        'You may connect facts that the context states. If the context says a',
        'person is reachable at an extension, you may answer a question about',
        'who to contact on that extension. Resolving a reference the user made',
        'earlier in the conversation is also allowed.',
        '',
        'You may NOT add any fact the context does not state. Never fall back',
        'on outside knowledge, no matter how confident you are.',
        '',
        'If the context answers only part of the question, give that part and',
        'say plainly which part the documents do not cover. Never fill a gap',
        'with something plausible.',
        '',
        'If the context does not answer the question at all, reply exactly:',
        `"${NO_ANSWER}"`,
        '',
        '--- CONTEXT ---',
        context,
        '--- END CONTEXT ---',
      ].join('\n'),
    },
    ...history, // oldest first, so the conversation reads in order
    { role: 'user', content: question },
  ];
}

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
export async function rewriteQuestion(history, question) {
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
 * @returns chunks ordered best-first, each tagged with which search found it
 */
export async function retrieve(question, questionVector) {
  // The two searches are independent, so run them at the same time. Both are
  // Postgres round trips; doing them in sequence would just be slower.
  const [vectorResult, keywordResult] = await Promise.all([
    supabase.rpc('match_chunks', {
      query_embedding: questionVector,
      match_count: CANDIDATE_COUNT,
      min_similarity: MIN_SIMILARITY,
    }),
    supabase.rpc('match_chunks_fts', {
      query_text: question,
      query_embedding: questionVector,
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

  const vectorHits = vectorResult.data;
  const keywordHits = keywordResult.data;

  // Fuse. Keyed by chunk id so the same chunk found by both searches is one
  // entry that accumulates both contributions.
  const fused = new Map();

  const add = (chunk, rank, foundBy) => {
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

  const merged = [...fused.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, MATCH_COUNT);

  console.log(
    `[retrieve] vector:${vectorHits.length} keyword:${keywordHits.length} ` +
    `-> fused:${merged.length} [${merged.map((c) => c.foundBy).join(' ')}]`,
  );

  // Note what is NOT filtered here: a chunk found only by keyword search keeps
  // its place even if its similarity is below MIN_SIMILARITY. That is the
  // whole point. The threshold is a gate on *semantic* evidence; an exact
  // keyword match is a different kind of evidence, and holding it to the
  // wrong standard is what made "extension 4417" unanswerable before.
  return merged;
}

/**
 * Answer a question from the knowledge base.
 *
 * The flow, matching architecture.md § 3.2:
 *   1. find or create the conversation
 *   2. load recent history (before saving this turn, or it would include itself)
 *   3. rewrite the question into a standalone search query (D-016)
 *   4. embed it — same model as ingest, guaranteed by using embed()
 *   5. hybrid search: vector + keyword, fused (D-015)
 *   6. nothing above the threshold? refuse WITHOUT calling OpenAI
 *   7. otherwise build the prompt (with the ORIGINAL question) and ask
 *   8. save both messages, return the answer and its sources
 */
/**
 * Everything both answer paths need, up to the point of calling the model.
 *
 * Steps 1-7 of the flow. Extracted so the streaming and non-streaming versions
 * share one pipeline rather than drifting apart: a retrieval fix applied to
 * only one of two near-identical copies is the kind of bug nobody finds.
 *
 * `matches` comes back empty when nothing cleared the threshold. Both callers
 * handle that case themselves, because what they do about it differs.
 */
async function prepareAnswer({ conversationId, message }) {
  // 1. Conversation row. Created lazily on the first message of a session.
  let id = conversationId;
  if (!id) {
    const { data, error } = await supabase
      .from('conversations')
      .insert({})
      .select('id')
      .single();
    if (error) throw new Error(`Could not start a conversation: ${error.message}`);
    id = data.id;
  }

  // 2. Recent history: newest-first from the database, then reversed, because
  //    "the last 6" needs a descending query but the model needs chronological
  //    order. Ordered by id rather than created_at — two rows written in the
  //    same millisecond would otherwise have no defined order.
  const { data: recent, error: historyError } = await supabase
    .from('messages')
    .select('role, content')
    .eq('conversation_id', id)
    .order('id', { ascending: false })
    .limit(MAX_HISTORY);
  if (historyError) throw new Error(`Could not load history: ${historyError.message}`);
  const history = recent.reverse();

  // 3. Resolve the question against the conversation before searching (D-016).
  //    The model gets the user's original words; only the search uses this.
  const searchQuery = await rewriteQuestion(history, message);

  // 4. Embed the search query.
  //
  //    THE constraint of the whole project: this must be the same model that
  //    embedded the documents. It is, because both go through embed() and read
  //    one env var. If they differed, the vectors would live in unrelated
  //    coordinate spaces, the similarity numbers would still look plausible,
  //    and nothing would error (D-004, R-3).
  const [questionVector] = await embed([searchQuery]);

  // 5. Retrieval: cosine search and keyword search, fused (D-015).
  const matches = await retrieve(searchQuery, questionVector);
  console.log(
    `[query] "${searchQuery}" -> ${matches.length} chunks`,
    matches.map((m) => `${m.similarity.toFixed(3)}/${m.foundBy}`).join(' '),
  );

  // 6. Nothing cleared the threshold: no sources to describe.
  if (matches.length === 0) return { id, history, searchQuery, matches, sources: [] };

  // 7. Attach document titles. match_chunks returns document_id but not the
  //    title, and the sources panel needs a human-readable label. One extra
  //    query is simpler than joining inside the SQL function.
  const documentIds = [...new Set(matches.map((m) => m.document_id))];
  const { data: docs, error: titleError } = await supabase
    .from('documents')
    .select('id, title')
    .in('id', documentIds);
  if (titleError) throw new Error(`Could not load document titles: ${titleError.message}`);
  const titleById = new Map(docs.map((d) => [d.id, d.title]));

  const sources = matches.map((m) => ({
    id: m.id,
    documentId: m.document_id,
    documentTitle: titleById.get(m.document_id) ?? '(deleted document)',
    content: m.content,
    similarity: m.similarity,
    // Which search found it: 'vector', 'keyword', or 'both'. Shown in the UI,
    // because "this answer came from an exact keyword match that the vector
    // search would have missed" is worth being able to see.
    foundBy: m.foundBy,
  }));

  return { id, history, searchQuery, matches, sources };
}

/**
 * Answer a question from the knowledge base, returning the whole reply.
 *
 * The flow, matching architecture.md § 3.2:
 *   1-7. prepareAnswer() above
 *   8.   nothing above the threshold? refuse WITHOUT calling OpenAI (D-008)
 *   9.   otherwise build the prompt (with the ORIGINAL question) and ask
 *   10.  save both messages, return the answer and its sources
 */
export async function answerQuestion({ conversationId, message }) {
  const { id, history, searchQuery, matches, sources } =
    await prepareAnswer({ conversationId, message });

  // The short circuit (D-008). Faster, free, and it removes any chance of the
  // model ignoring its instructions and answering from training data anyway.
  if (matches.length === 0) {
    await saveMessages(id, message, NO_ANSWER);
    return { conversationId: id, reply: NO_ANSWER, sources: [], searchQuery };
  }

  const reply = await chat(buildPrompt(matches, history, message));
  await saveMessages(id, message, reply);

  // searchQuery is returned so the UI can show what was actually searched for
  // when it differs from what the user typed. Retrieval silently searching for
  // something other than the question is exactly the kind of thing that should
  // be visible rather than hidden (same argument as the sources panel, D-012).
  return { conversationId: id, reply, sources, searchQuery };
}

/**
 * The same answer, delivered as it is generated (D-019).
 *
 * Identical pipeline; only the last step differs. `onMeta` fires once, as soon
 * as retrieval is done and **before** any of the answer exists — which is the
 * real win here beyond perceived speed: the sources panel can be on screen
 * while the model is still writing, so you can read what it was given at the
 * same time as what it made of it.
 *
 * Still returns the complete answer, because it has to be saved to the
 * database either way.
 *
 * @param {object} args
 * @param {(meta: object) => void} args.onMeta  conversationId, searchQuery, sources
 * @param {(text: string) => void} args.onDelta each fragment as it arrives
 * @returns {Promise<string>} the complete answer
 */
export async function answerQuestionStream({ conversationId, message, onMeta, onDelta }) {
  const { id, history, searchQuery, matches, sources } =
    await prepareAnswer({ conversationId, message });

  onMeta({ conversationId: id, searchQuery, sources });

  // The short circuit again. Emitted as a single delta so the client needs no
  // special case: a refusal arrives down the same channel as any other answer.
  if (matches.length === 0) {
    onDelta(NO_ANSWER);
    await saveMessages(id, message, NO_ANSWER);
    return NO_ANSWER;
  }

  const reply = await chatStream(buildPrompt(matches, history, message), onDelta);
  await saveMessages(id, message, reply);
  return reply;
}

/**
 * Persist one turn: the user's message and the assistant's reply.
 *
 * Both rows in one insert. Refusals are saved too — a transcript with gaps in
 * it would make a later follow-up ("what about the second one?") resolve
 * against the wrong turn.
 */
async function saveMessages(conversationId, userMessage, assistantMessage) {
  const { error } = await supabase.from('messages').insert([
    { conversation_id: conversationId, role: 'user', content: userMessage },
    { conversation_id: conversationId, role: 'assistant', content: assistantMessage },
  ]);
  if (error) throw new Error(`Could not save messages: ${error.message}`);
}

/** Every message in a conversation, oldest first. Used to restore the UI. */
export async function getMessages(conversationId) {
  const { data, error } = await supabase
    .from('messages')
    .select('role, content, created_at')
    .eq('conversation_id', conversationId)
    .order('id', { ascending: true });
  if (error) throw new Error(`Could not load messages: ${error.message}`);
  return data;
}
