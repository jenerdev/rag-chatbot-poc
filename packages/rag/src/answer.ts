// answer.ts — the query pipeline, from a typed question to a grounded answer.

import { assistantToolCallMessage, chat, chatStream, embed, toolResultMessage } from '@rag/openai';
import type { ChatMessage, ChatTurn } from '@rag/openai';
import { MAX_HISTORY, MAX_TOOL_ROUNDS, NO_ANSWER } from './constants.js';
import { greetingReply } from './greeting.js';
import { buildPrompt } from './prompt.js';
import { retrieve, rewriteQuestion } from './retrieve.js';
import { executeTool, toolsFor } from './tools.js';
import type {
  Answer,
  HistoryMessage,
  RetrievedChunk,
  Source,
  StreamMeta,
  TenantContext,
  ToolCallRecord,
} from './types.js';

/**
 * Find or create the conversation row.
 *
 * Created lazily on the first message of a session. Extracted from
 * prepareAnswer() because the greeting path needs an id too — it still saves
 * the turn, so the transcript has no gap in it, but it never retrieves.
 *
 * A client-supplied id is VERIFIED, not trusted (plan.md § 2.2). It used to be
 * returned as-is, which was harmless with one tenant. With several, posting
 * tenant A's conversation id to tenant B's chat would load A's last six
 * messages as history and paste them into B's prompt: the chunks would be B's,
 * but the conversation would not. So the id is used only if this tenant owns
 * it. Otherwise, whether it belongs to another tenant or does not exist at
 * all, a new conversation is started, and the caller gets the new id back in
 * the reply.
 */
async function ensureConversation(
  tenant: TenantContext,
  conversationId: string | null,
): Promise<string> {
  if (conversationId) {
    const { data: owned, error } = await tenant.db
      .from('conversations')
      .select('id')
      .eq('tenant_id', tenant.id)
      .eq('id', conversationId)
      .maybeSingle();
    if (error) throw new Error(`Could not load the conversation: ${error.message}`);
    if (owned) return owned.id;
    console.log(`[query] ${tenant.slug}: conversation ${conversationId} is not this tenant's; starting a new one`);
  }

  const { data, error } = await tenant.db
    .from('conversations')
    .insert({ tenant_id: tenant.id })
    .select('id')
    .single();
  if (error) throw new Error(`Could not start a conversation: ${error.message}`);
  return data.id;
}

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
  tenant,
  conversationId,
  message,
}: {
  tenant: TenantContext;
  conversationId: string | null;
  message: string;
}): Promise<Prepared> {
  // 1. Conversation row, created lazily, and verified to be this tenant's.
  const id = await ensureConversation(tenant, conversationId);

  // 2. Recent history: newest-first from the database, then reversed, because
  //    "the last 6" needs a descending query but the model needs chronological
  //    order. Ordered by id rather than created_at — two rows written in the
  //    same millisecond would otherwise have no defined order.
  const { data: recent, error: historyError } = await tenant.db
    .from('messages')
    .select('role, content')
    .eq('tenant_id', tenant.id)
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
  const matches = await retrieve(tenant, searchQuery, questionVector!);
  console.log(
    `[query] "${searchQuery}" -> ${matches.length} chunks`,
    matches.map((m) => `${m.similarity.toFixed(3)}/${m.foundBy}`).join(' '),
  );

  // 6. Nothing cleared the threshold: no sources to describe.
  if (matches.length === 0) return { id, history, searchQuery, matches, sources: [] };

  // 7. Attach document titles. match_chunks returns document_id but not the
  //    title, and the sources panel needs a human-readable label. One extra
  //    query is simpler than joining inside the SQL function. Tenant-filtered
  //    too: a title is not a secret, but another tenant's title in this
  //    tenant's sources panel is a leak.
  const documentIds = [...new Set(matches.map((m) => m.document_id))];
  const { data: docs, error: titleError } = await tenant.db
    .from('documents')
    .select('id, title')
    .eq('tenant_id', tenant.id)
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
 * The tool loop, shared by both answer paths (plan/bookings.md Phase 6).
 *
 * Ask the model with the tools offered. If it asks for calls, run each one,
 * append the request and the results to the conversation, and ask again. Stop
 * when it answers in text. `complete` is the only thing that differs between
 * the two paths: chat() or chatStream().
 *
 * Bounded by MAX_TOOL_ROUNDS. A model still asking for tools after that many
 * rounds is looping, and this throws rather than retrying (architecture.md
 * § 9). The error names the limit, so it reaches the user as a real reason.
 *
 * `messages` is a local copy. The tool request and result messages exist only
 * for this turn. They are not saved (messages.role allows only user and
 * assistant), and the next turn calls the tool again, which is what you want
 * for data that changes (plan/bookings.md § 2.6).
 */
async function toolLoop(
  tenant: TenantContext,
  prompt: ChatMessage[],
  complete: (messages: ChatMessage[]) => Promise<ChatTurn>,
  onTool?: (record: ToolCallRecord) => void,
): Promise<{ text: string; records: ToolCallRecord[] }> {
  const messages = [...prompt];
  const records: ToolCallRecord[] = [];
  let text = '';

  for (let round = 0; ; round++) {
    const turn = await complete(messages);
    text += turn.content ?? '';
    if (turn.toolCalls.length === 0) return { text, records };

    if (round >= MAX_TOOL_ROUNDS) {
      throw new Error(
        `The model asked for tools again after ${MAX_TOOL_ROUNDS} rounds (MAX_TOOL_ROUNDS). Stopping rather than looping.`,
      );
    }

    messages.push(assistantToolCallMessage(turn));
    for (const call of turn.toolCalls) {
      const { record, content } = await executeTool(tenant, call);
      records.push(record);
      onTool?.(record);
      messages.push(toolResultMessage(call.id, content));
    }
  }
}

/**
 * D-035, the zero-match rule. It amends D-008 rather than removing it.
 *
 * With no retrieved chunk, the model's reply is accepted ONLY if it called a
 * tool on this turn. Otherwise it is replaced with the refusal. So with zero
 * chunks, the only possible outputs are the refusal and an answer built from
 * a tool result. It can never be an answer from training data, which is what
 * D-008 exists to prevent.
 *
 * For a tenant without tools, the model is not called at all when there are
 * zero chunks, which is exactly D-008's short circuit. That path is in the two
 * functions below, unchanged.
 */
function acceptReply(matches: RetrievedChunk[], records: ToolCallRecord[], text: string): string {
  if (matches.length === 0 && records.length === 0) {
    console.log('[query] zero chunks and no tool call: the reply is replaced with the refusal (D-035)');
    return NO_ANSWER;
  }
  return text;
}

/**
 * Answer a question from the knowledge base, returning the whole reply.
 *
 * The flow, matching architecture.md § 3.2:
 *   1-7. prepareAnswer() above
 *   8.   no tools, and nothing above the threshold? refuse WITHOUT calling
 *        OpenAI (D-008)
 *   9.   otherwise build the prompt (with the ORIGINAL question) and ask. With
 *        tools, run the tool loop, then apply D-035's zero-match rule
 *   10.  save both messages, return the answer, its sources and its tool calls
 */
export async function answerQuestion({
  tenant,
  conversationId,
  message,
}: {
  tenant: TenantContext;
  conversationId: string | null;
  message: string;
}): Promise<Answer> {
  // Small talk, answered before anything is retrieved or embedded. A greeting
  // has nothing to look up, so running it through the pipeline can only end in
  // the refusal — see greeting.ts for why this is not a document.
  const greeting = greetingReply(message, tenant);
  if (greeting !== null) {
    const id = await ensureConversation(tenant, conversationId);
    await saveMessages(tenant, id, message, greeting);
    return { conversationId: id, reply: greeting, sources: [], searchQuery: message, toolCalls: [] };
  }

  const [{ id, history, searchQuery, matches, sources }, tools] = await Promise.all([
    prepareAnswer({ tenant, conversationId, message }),
    toolsFor(tenant),
  ]);

  // No tools: the path is exactly what it was before tools existed.
  if (tools.definitions.length === 0) {
    // The short circuit (D-008). Faster, free, and it removes any chance of the
    // model ignoring its instructions and answering from training data anyway.
    if (matches.length === 0) {
      await saveMessages(tenant, id, message, NO_ANSWER);
      return { conversationId: id, reply: NO_ANSWER, sources: [], searchQuery, toolCalls: [] };
    }

    const reply = await chat(buildPrompt(tenant, matches, history, message));
    await saveMessages(tenant, id, message, reply);

    // searchQuery is returned so the UI can show what was actually searched for
    // when it differs from what the user typed. Retrieval silently searching for
    // something other than the question is exactly the kind of thing that should
    // be visible rather than hidden (same argument as the sources panel, D-012).
    return { conversationId: id, reply, sources, searchQuery, toolCalls: [] };
  }

  // With tools the model is called even with zero chunks, because a tool may
  // answer what the documents cannot. D-035 then decides whether its reply is
  // allowed out.
  const { text, records } = await toolLoop(
    tenant,
    buildPrompt(tenant, matches, history, message, tools.prompt),
    (messages) => chat(messages, { tools: tools.definitions }),
  );
  const reply = acceptReply(matches, records, text);
  await saveMessages(tenant, id, message, reply);
  return { conversationId: id, reply, sources, searchQuery, toolCalls: records };
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
  tenant,
  conversationId,
  message,
  onMeta,
  onDelta,
  onTool,
}: {
  tenant: TenantContext;
  conversationId: string | null;
  message: string;
  onMeta: (meta: StreamMeta) => void;
  onDelta: (text: string) => void;
  /** Fires as each tool call completes, before the answer that uses it is written. */
  onTool?: (record: ToolCallRecord) => void;
}): Promise<string> {
  // Same short circuit as the non-streaming path. `meta` still fires, with no
  // sources, so the client's state machine needs no special case: a greeting
  // arrives down exactly the same channel as an answer.
  const greeting = greetingReply(message, tenant);
  if (greeting !== null) {
    const id = await ensureConversation(tenant, conversationId);
    onMeta({ conversationId: id, searchQuery: message, sources: [] });
    onDelta(greeting);
    await saveMessages(tenant, id, message, greeting);
    return greeting;
  }

  const [{ id, history, searchQuery, matches, sources }, tools] = await Promise.all([
    prepareAnswer({ tenant, conversationId, message }),
    toolsFor(tenant),
  ]);

  onMeta({ conversationId: id, searchQuery, sources });

  // No tools: the short circuit again, unchanged. Emitted as a single delta so
  // the client needs no special case: a refusal arrives down the same channel
  // as any other answer.
  if (tools.definitions.length === 0 && matches.length === 0) {
    onDelta(NO_ANSWER);
    await saveMessages(tenant, id, message, NO_ANSWER);
    return NO_ANSWER;
  }

  try {
    if (tools.definitions.length === 0) {
      const reply = await chatStream(buildPrompt(tenant, matches, history, message), onDelta);
      await saveMessages(tenant, id, message, reply);
      return reply;
    }

    // With zero chunks the text is HELD, not streamed (plan/bookings.md
    // § 2.7). Whether it may be shown depends on whether a tool gets called,
    // and that is known only at the end. Text already on screen cannot be
    // replaced by the refusal. With chunks there is nothing to decide, so it
    // streams as it always has.
    const hold = matches.length === 0;
    const { text, records } = await toolLoop(
      tenant,
      buildPrompt(tenant, matches, history, message, tools.prompt),
      (messages) => chatStream(messages, onDelta, { tools: tools.definitions, holdContent: hold }),
      onTool,
    );
    const reply = acceptReply(matches, records, text);
    if (hold) onDelta(reply);
    await saveMessages(tenant, id, message, reply);
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
      tenant,
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
  tenant: TenantContext,
  conversationId: string,
  userMessage: string,
  assistantMessage: string,
): Promise<void> {
  // tenant_id on each row is checked by the composite foreign key against the
  // conversation's own tenant_id. A message cannot land in another tenant's
  // conversation even if this code were wrong.
  const { error } = await tenant.db.from('messages').insert([
    { tenant_id: tenant.id, conversation_id: conversationId, role: 'user', content: userMessage },
    { tenant_id: tenant.id, conversation_id: conversationId, role: 'assistant', content: assistantMessage },
  ]);
  if (error) throw new Error(`Could not save messages: ${error.message}`);
}

/**
 * Every message in a conversation, oldest first. Used to restore the UI.
 *
 * Returns `null` when this tenant has no such conversation, and `[]` when it
 * has one with no messages yet. Those are different answers. Only the first is
 * a 404, and "belongs to another tenant" is deliberately the same `null` as
 * "does not exist" (plan.md § 2.2). Before tenancy, any conversation's
 * transcript was readable by anyone who had its uuid.
 */
export async function getMessages(
  tenant: TenantContext,
  conversationId: string,
): Promise<{ role: 'user' | 'assistant'; content: string; created_at: string }[] | null> {
  const { data: owned, error: ownError } = await tenant.db
    .from('conversations')
    .select('id')
    .eq('tenant_id', tenant.id)
    .eq('id', conversationId)
    .maybeSingle();
  if (ownError) throw new Error(`Could not load the conversation: ${ownError.message}`);
  if (!owned) return null;

  const { data, error } = await tenant.db
    .from('messages')
    .select('role, content, created_at')
    .eq('tenant_id', tenant.id)
    .eq('conversation_id', conversationId)
    .order('id', { ascending: true });
  if (error) throw new Error(`Could not load messages: ${error.message}`);
  return data;
}
