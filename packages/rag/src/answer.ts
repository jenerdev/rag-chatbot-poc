// answer.ts — the query pipeline, from a typed question to a grounded answer.

import { chat, chatStream, embed } from '@rag/openai';
import { supabase } from '@rag/db';
import { MAX_HISTORY, NO_ANSWER } from './constants.js';
import { buildPrompt } from './prompt.js';
import { retrieve, rewriteQuestion } from './retrieve.js';
import type { Answer, HistoryMessage, RetrievedChunk, Source, StreamMeta } from './types.js';

interface Prepared {
  id: string;
  history: HistoryMessage[];
  searchQuery: string;
  matches: RetrievedChunk[];
  sources: Source[];
}

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
async function prepareAnswer({
  conversationId,
  message,
}: {
  conversationId: string | null;
  message: string;
}): Promise<Prepared> {
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
  const matches = await retrieve(searchQuery, questionVector!);
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

  const sources: Source[] = matches.map((m) => ({
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
export async function answerQuestion({
  conversationId,
  message,
}: {
  conversationId: string | null;
  message: string;
}): Promise<Answer> {
  const { id, history, searchQuery, matches, sources } = await prepareAnswer({
    conversationId,
    message,
  });

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
 */
export async function answerQuestionStream({
  conversationId,
  message,
  onMeta,
  onDelta,
}: {
  conversationId: string | null;
  message: string;
  onMeta: (meta: StreamMeta) => void;
  onDelta: (text: string) => void;
}): Promise<string> {
  const { id, history, searchQuery, matches, sources } = await prepareAnswer({
    conversationId,
    message,
  });

  onMeta({ conversationId: id, searchQuery, sources });

  // The short circuit again. Emitted as a single delta so the client needs no
  // special case: a refusal arrives down the same channel as any other answer.
  if (matches.length === 0) {
    onDelta(NO_ANSWER);
    await saveMessages(id, message, NO_ANSWER);
    return NO_ANSWER;
  }

  try {
    const reply = await chatStream(buildPrompt(matches, history, message), onDelta);
    await saveMessages(id, message, reply);
    return reply;
  } catch (error) {
    // The client was handed this conversationId in `meta` and will send it
    // with the next question. If nothing is persisted here, that next turn
    // loads a history with a hole in it: the user can see their question on
    // screen while the retriever and the rewriter (D-016) cannot, so a
    // follow-up resolves against the wrong turn.
    //
    // So save what actually happened, including a partial answer if the
    // stream died mid-sentence, and mark it rather than passing a truncated
    // reply off as the assistant's considered answer.
    const maybePartial = (error as { partial?: unknown }).partial;
    const partial = typeof maybePartial === 'string' ? maybePartial : '';
    await saveMessages(
      id,
      message,
      partial === '' ? '[no answer — the request failed]' : `${partial} […answer interrupted]`,
    );
    throw error;
  }
}

/**
 * Persist one turn: the user's message and the assistant's reply.
 *
 * Both rows in one insert. Refusals are saved too — a transcript with gaps in
 * it would make a later follow-up ("what about the second one?") resolve
 * against the wrong turn.
 */
async function saveMessages(
  conversationId: string,
  userMessage: string,
  assistantMessage: string,
): Promise<void> {
  const { error } = await supabase.from('messages').insert([
    { conversation_id: conversationId, role: 'user', content: userMessage },
    { conversation_id: conversationId, role: 'assistant', content: assistantMessage },
  ]);
  if (error) throw new Error(`Could not save messages: ${error.message}`);
}

/** Every message in a conversation, oldest first. Used to restore the UI. */
export async function getMessages(
  conversationId: string,
): Promise<{ role: 'user' | 'assistant'; content: string; created_at: string }[]> {
  const { data, error } = await supabase
    .from('messages')
    .select('role, content, created_at')
    .eq('conversation_id', conversationId)
    .order('id', { ascending: true });
  if (error) throw new Error(`Could not load messages: ${error.message}`);
  return data;
}
