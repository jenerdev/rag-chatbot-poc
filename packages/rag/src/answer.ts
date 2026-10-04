// answer.ts — the query pipeline, from a typed question to a grounded answer.

import { assistantToolCallMessage, chat, chatStream, embed, toolResultMessage } from '@rag/openai';
import type { ChatMessage, ChatTurn, ToolCall } from '@rag/openai';
import { roomPhotos } from '@rag/bookings';
import { LANGUAGE_SCAN_MESSAGES, MAX_HISTORY, MAX_TOOL_ROUNDS, NO_ANSWER } from './constants.js';
import { asksExtraGuest, asksHorizon, asksRoomList, asksUndatedPrice, planDates, PRICE_NEEDS_DATE, ROOM_LIST_LINES, roomListReply, WHOLE_PROPERTY_ROOM_LINES } from './dates.js';
import { classifySmallTalk, smallTalkLanguage, smallTalkReply, thanksPrefix } from './greeting.js';
import { languageInstructions, replyLanguage, requestReply } from './language.js';
import type { LanguagePreference } from './language.js';
import { buildPrompt } from './prompt.js';
import { displayReply, isRefusal, refusalFilter, refusalText, storedReply } from './refusal.js';
import { retrieve, rewriteQuestion } from './retrieve.js';
import { executeTool, extraGuestLines, horizonLines, rateCardReply, toolsFor } from './tools.js';
import type { PromptTools, TenantTools } from './tools.js';
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
  /** The language block's lines for this turn, from language.ts; [] for an English reply. */
  language: string[];
  /** The reply language itself, for the friendly refusal's default wording (D-047). */
  replyIn: LanguagePreference;
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
  //
  //    Alongside it, the user's own messages, further back than the history
  //    window, for the reply language (D-043): an explicit request ("Tagalog
  //    lang po") must outlive MAX_HISTORY, and a bare "10 October" takes the
  //    language of the message before it. Read by language.ts in code and
  //    never sent to the model, so they cost no token.
  const [
    { data: recent, error: historyError },
    { data: asked, error: askedError },
  ] = await Promise.all([
    tenant.db
      .from('messages')
      .select('role, content')
      .eq('tenant_id', tenant.id)
      .eq('conversation_id', id)
      .order('id', { ascending: false })
      .limit(MAX_HISTORY),
    tenant.db
      .from('messages')
      .select('content')
      .eq('tenant_id', tenant.id)
      .eq('conversation_id', id)
      .eq('role', 'user')
      .order('id', { ascending: false })
      .limit(LANGUAGE_SCAN_MESSAGES),
  ]);
  if (historyError) throw new Error(`Could not load history: ${historyError.message}`);
  if (askedError) throw new Error(`Could not load the language preference: ${askedError.message}`);
  const history = recent.reverse();
  // Newest first, the current message ahead of the stored ones.
  const choice = replyLanguage([message, ...asked.map((m) => m.content)]);
  console.log(`[query] reply language: ${choice.language}${choice.asked ? ' (asked for)' : ''}`);
  const language = languageInstructions(choice);

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
  if (matches.length === 0) return { id, history, language, replyIn: choice.language, searchQuery, matches, sources: [] };

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

  return { id, history, language, replyIn: choice.language, searchQuery, matches, sources };
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
  precheck: ToolCall[] = [],
): Promise<{ text: string; records: ToolCallRecord[] }> {
  const messages = [...prompt];
  const records: ToolCallRecord[] = [];
  let text = '';

  // D-046: calls the pipeline makes itself, before the model's first turn, for
  // a date resolved in code. Written into the conversation exactly as if the
  // model had asked for them, and run through the same executeTool(), so the
  // enablement check, the validation and the "Checked availability" record
  // are the ones every call gets.
  if (precheck.length > 0) {
    messages.push(assistantToolCallMessage({ content: null, toolCalls: precheck }));
    for (const call of precheck) {
      const { record, content } = await executeTool(tenant, call);
      records.push(record);
      onTool?.(record);
      messages.push(toolResultMessage(call.id, content));
    }
  }

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
 * Small talk for this turn (D-049): the reply, and the conversation it
 * belongs to, or null when the message is not small talk.
 *
 * Only a message that IS small talk costs a query: classifySmallTalk() is
 * pure and runs first. Then one read of this conversation's recent messages,
 * tenant-filtered like every query here (rule 6), decides two things:
 *
 *   - the reply language, by D-043's rules (an explicit "English please"
 *     still wins), with the small talk's own Tagalog as the tie-breaker on a
 *     first turn ("Salamat po", "Kamusta");
 *   - whether the bot's last message was a question. Then "okay" or "sige"
 *     answers it, and `reply` is null so the pipeline, which has the
 *     history, handles it. `id` is returned anyway, so the conversation
 *     created here is the one the pipeline continues.
 */
async function smallTalk(
  tenant: TenantContext,
  conversationId: string | null,
  message: string,
): Promise<{ id: string; reply: string | null } | null> {
  if (classifySmallTalk(message) === null) return null;
  const id = await ensureConversation(tenant, conversationId);
  const { data: recent, error } = await tenant.db
    .from('messages')
    .select('role, content')
    .eq('tenant_id', tenant.id)
    .eq('conversation_id', id)
    .order('id', { ascending: false })
    .limit(LANGUAGE_SCAN_MESSAGES);
  if (error) throw new Error(`Could not load the conversation: ${error.message}`);

  const choice = replyLanguage([message, ...recent.filter((m) => m.role === 'user').map((m) => m.content)]);
  const language = choice.asked ? choice.language : (smallTalkLanguage(message) ?? choice.language);
  const lastBot = recent.find((m) => m.role === 'assistant');
  const botAsked = lastBot?.content.trim().endsWith('?') ?? false;
  const reply = smallTalkReply(message, tenant, language, botAsked);
  console.log(`[query] small talk: ${classifySmallTalk(message)} (${language})${reply === null ? ', answers the bot: to the pipeline' : ''}`);
  return { id, reply };
}

/**
 * The tools block for this turn, with the message's relative dates resolved
 * against the TENANT'S today (D-046). "bukas" becomes 2026-09-28 in code, so
 * the model is handed the date instead of being trusted to count to it,
 * which it did not do: six relative-date questions out of six came back as
 * "Which date do you mean?" with no tool call.
 *
 * Only tenants with tools get dates: without check_availability there is
 * nothing to pass a date to, and the northwind prompt stays byte-identical.
 */
async function withDates(
  tenant: TenantContext,
  tools: TenantTools,
  message: string,
  history: HistoryMessage[],
): Promise<{ prompt: PromptTools | null; precheck: ToolCall[] }> {
  const { prompt } = tools;
  if (!prompt) return { prompt: null, precheck: [] };
  // The user's earlier questions, so a bare "What about the day after
  // tomorrow?" after an availability question counts as one.
  const earlier = history.filter((h) => h.role === 'user').map((h) => h.content);
  const plan = planDates(message, prompt.today, earlier);
  if (plan.lines.length === 0) {
    // D-086: "How far ahead can I book?" from the bookings config, the
    // numbers the booking page enforces.
    if (tools.horizon && asksHorizon(message, prompt.today)) {
      console.log('[query] the booking horizon: the latest date from the config (D-086)');
      return { prompt: { ...prompt, dates: horizonLines(tools.horizon) }, precheck: [] };
    }
    // D-085: "How much is per extra guest?" needs no date; the fee is the
    // room's, from the database, in this turn's lines.
    if (tools.priced && asksExtraGuest(message, prompt.today)) {
      console.log('[query] the extra guest fee, no date: the terms from the database (D-085)');
      return { prompt: { ...prompt, dates: await extraGuestLines(tenant) }, precheck: [] };
    }
    // D-084: "What rooms do you have?" lists the rooms, with no price and no
    // question back. In the same per-turn slot as a date's lines. A tenant
    // booked as a whole lists the bedrooms its documents describe (D-087).
    if (asksRoomList(message, prompt.today)) {
      console.log(`[query] rooms asked with no date: the room list, no prices (D-084${tools.rooms ? '' : ', whole property'})`);
      return { prompt: { ...prompt, dates: tools.rooms ? ROOM_LIST_LINES : WHOLE_PROPERTY_ROOM_LINES }, precheck: [] };
    }
    return { prompt, precheck: [] };
  }

  const precheck: ToolCall[] = plan.calls.map((args, i) => ({
    id: `call_resolved_date_${i}`,
    name: 'check_availability',
    arguments: JSON.stringify(args),
  }));
  console.log(`[query] dates: ${plan.calls.map((c) => JSON.stringify(c)).join(', ') || 'ambiguous, asking'}`);
  return { prompt: { ...prompt, dates: plan.lines }, precheck };
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
 * D-081: a price asked with no date ("room rates please") is not a question
 * the documents cannot answer. The answer is "it depends on the date", in
 * the same words every time. Measured before this: villa's model asked
 * "Which date do you mean?" 4 of 4, and harbor's REFUSED 2 of 3 with four
 * chunks retrieved, which told the visitor we knew nothing of our prices.
 *
 * True only for a tenant whose tool quotes prices, on a message with a price
 * word and no date. Even then a reply is replaced only when no tool was
 * called and it holds NO FIGURE: an answer to "how much" names a number
 * ("the deposit is ₱2,000"), and that is kept. What is replaced is the
 * refusal, or a question back asking for the date.
 */
function asksPriceWithoutDate(tools: TenantTools, message: string): boolean {
  return tools.priced && tools.prompt !== null && asksUndatedPrice(message, tools.prompt.today);
}

/**
 * D-087: a per_room tenant's room-list turn. With ROOM_LIST_LINES in the
 * prompt, the model still answered "Which date do you mean?" to "What rooms
 * are available?" 4 of 4, because the tools block's "ask which date" rule
 * won. So the reply is checked: if it called no tool and does not name
 * every room, it is replaced by the list written in code. A reply that does
 * name them (with the documents' details) is kept.
 */
function roomListRooms(tools: TenantTools, message: string): { name: string; capacity: number | null }[] | null {
  return tools.rooms && tools.prompt && asksRoomList(message, tools.prompt.today) ? tools.rooms : null;
}

function explainRooms(
  rooms: { name: string; capacity: number | null }[] | null,
  records: ToolCallRecord[],
  reply: string,
  replyIn: LanguagePreference,
): string {
  if (!rooms || rooms.length === 0 || records.length > 0) return reply;
  const text = reply.toLowerCase();
  if (rooms.every((r) => text.includes(r.name.toLowerCase()))) return reply;
  console.log('[query] a room-list turn that did not name the rooms: the list written in code (D-087)');
  return roomListReply(rooms, replyIn);
}

function explainPrice(
  undatedPrice: boolean,
  records: ToolCallRecord[],
  reply: string,
  replyIn: LanguagePreference,
  rateCard: string | null,
): string {
  if (!undatedPrice || records.length > 0 || /\d/.test(reply)) return reply;
  // plan/tables.md Phase 2 (§ 7 q1): a tenant with rates gets the rate card,
  // written in code from the booking page's rows (rateCardReply); D-081's
  // sentence is the fallback when there is no card to give.
  if (rateCard !== null) {
    console.log('[query] a price with no date, answered with no figure: the reply is the rate card (D-091)');
    return rateCard;
  }
  console.log('[query] a price with no date, answered with no figure: the reply is PRICE_NEEDS_DATE (D-081)');
  return PRICE_NEEDS_DATE[replyIn];
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
  // Small talk (greetings, thanks, "okay", goodbyes), answered before anything
  // is retrieved or embedded: there is nothing to look up, so the pipeline
  // could only end in the refusal. See greeting.ts. Nor has a bare language
  // request ("Please respond in English"), see language.ts.
  const talk = await smallTalk(tenant, conversationId, message);
  const canned = talk?.reply ?? requestReply(message);
  if (canned !== null) {
    const id = talk?.id ?? (await ensureConversation(tenant, conversationId));
    await saveMessages(tenant, id, message, canned);
    return { conversationId: id, reply: canned, refused: false, sources: [], searchQuery: message, toolCalls: [] };
  }

  const [{ id, history, language, replyIn, searchQuery, matches, sources }, tools] = await Promise.all([
    prepareAnswer({ tenant, conversationId: talk?.id ?? conversationId, message }),
    toolsFor(tenant),
  ]);
  // "Thanks! Is it free tomorrow?": the thanks is answered in front of the
  // answer. Shown, never saved (see thanksPrefix).
  const prefix = thanksPrefix(message, replyIn) ?? '';
  const { prompt: promptTools, precheck } = await withDates(tenant, tools, message, history);
  // The marker is what is saved; this is what is shown (D-047).
  const friendly = refusalText(tenant, replyIn);

  // No tools: the path is exactly what it was before tools existed.
  if (tools.definitions.length === 0) {
    // The short circuit (D-008). Faster, free, and it removes any chance of the
    // model ignoring its instructions and answering from training data anyway.
    if (matches.length === 0) {
      await saveMessages(tenant, id, message, NO_ANSWER);
      return { conversationId: id, reply: prefix + friendly, refused: true, sources: [], searchQuery, toolCalls: [] };
    }

    const reply = await chat(buildPrompt(tenant, matches, history, message, null, language));
    await saveMessages(tenant, id, message, storedReply(reply));

    // searchQuery is returned so the UI can show what was actually searched for
    // when it differs from what the user typed. Retrieval silently searching for
    // something other than the question is exactly the kind of thing that should
    // be visible rather than hidden (same argument as the sources panel, D-012).
    return { conversationId: id, reply: prefix + displayReply(reply, friendly), refused: isRefusal(reply), sources, searchQuery, toolCalls: [] };
  }

  // With tools the model is called even with zero chunks, because a tool may
  // answer what the documents cannot. D-035 then decides whether its reply is
  // allowed out.
  const { text, records } = await toolLoop(
    tenant,
    buildPrompt(tenant, matches, history, message, promptTools, language),
    (messages) => chat(messages, { tools: tools.definitions }),
    undefined,
    precheck,
  );
  const undatedPrice = asksPriceWithoutDate(tools, message);
  const listRooms = roomListRooms(tools, message);
  const reply = explainRooms(
    listRooms,
    records,
    explainPrice(undatedPrice, records, acceptReply(matches, records, text), replyIn, undatedPrice ? await rateCardReply(tenant, replyIn) : null),
    replyIn,
  );
  await saveMessages(tenant, id, message, storedReply(reply));
  return {
    conversationId: id,
    reply: prefix + displayReply(reply, friendly),
    refused: isRefusal(reply),
    sources,
    searchQuery,
    toolCalls: records,
    // D-094: the rooms' photos at a per_room tenant, as cards on a room-list
    // turn, as a Photo column on any other table that names rooms.
    ...(tools.rooms ? { roomCards: await roomPhotos(tenant), roomCardsView: listRooms !== null ? 'cards' : 'column' } : {}),
  };
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
  const talk = await smallTalk(tenant, conversationId, message);
  const canned = talk?.reply ?? requestReply(message);
  if (canned !== null) {
    const id = talk?.id ?? (await ensureConversation(tenant, conversationId));
    onMeta({ conversationId: id, searchQuery: message, sources: [] });
    onDelta(canned);
    await saveMessages(tenant, id, message, canned);
    return canned;
  }

  const [{ id, history, language, replyIn, searchQuery, matches, sources }, tools] = await Promise.all([
    prepareAnswer({ tenant, conversationId: talk?.id ?? conversationId, message }),
    toolsFor(tenant),
  ]);
  const prefix = thanksPrefix(message, replyIn) ?? '';
  const { prompt: promptTools, precheck } = await withDates(tenant, tools, message, history);
  // The marker is what is saved; the friendly text is what is streamed (D-047).
  const friendly = refusalText(tenant, replyIn);

  // D-094: a per_room tenant's rooms' photos travel in `meta`, before the
  // model is called: cards on a room-list turn (known from the message
  // alone), a Photo column on any other table that names rooms.
  const roomCards = tools.rooms ? await roomPhotos(tenant) : undefined;
  const roomCardsView = roomListRooms(tools, message) !== null ? 'cards' : 'column';
  onMeta({ conversationId: id, searchQuery, sources, ...(roomCards ? { roomCards, roomCardsView } : {}) });
  // The thanks goes out first, ahead of whatever the answer turns out to be.
  if (prefix) onDelta(prefix);

  // No tools: the short circuit again, unchanged. Emitted as a single delta so
  // the client needs no special case: a refusal arrives down the same channel
  // as any other answer.
  if (tools.definitions.length === 0 && matches.length === 0) {
    onDelta(friendly);
    await saveMessages(tenant, id, message, NO_ANSWER);
    return prefix + friendly;
  }

  // Streamed text passes through this, so a model-written refusal is never on
  // screen as the marker: see refusalFilter.
  const filter = refusalFilter(onDelta, friendly);

  try {
    if (tools.definitions.length === 0) {
      const reply = await chatStream(buildPrompt(tenant, matches, history, message, null, language), filter.push);
      filter.finish();
      await saveMessages(tenant, id, message, storedReply(reply));
      return prefix + displayReply(reply, friendly);
    }

    // With zero chunks the text is HELD, not streamed (plan/bookings.md
    // § 2.7). Whether it may be shown depends on whether a tool gets called,
    // and that is known only at the end. Text already on screen cannot be
    // replaced by the refusal. With chunks there is nothing to decide, so it
    // streams as it always has.
    //
    // An undated price question is held too, with chunks or without: its
    // refusal is replaced by D-081's text, and a streamed one could not be.
    // So is a room-list turn (D-087), whose reply may be replaced by the list.
    const undatedPrice = asksPriceWithoutDate(tools, message);
    const listRooms = roomListRooms(tools, message);
    const hold = matches.length === 0 || undatedPrice || listRooms !== null;
    const { text, records } = await toolLoop(
      tenant,
      buildPrompt(tenant, matches, history, message, promptTools, language),
      (messages) => chatStream(messages, filter.push, { tools: tools.definitions, holdContent: hold }),
      onTool,
      precheck,
    );
    const reply = explainRooms(
      listRooms,
      records,
      explainPrice(undatedPrice, records, acceptReply(matches, records, text), replyIn, undatedPrice ? await rateCardReply(tenant, replyIn) : null),
      replyIn,
    );
    // Held text was never streamed, so it goes out whole, already swapped.
    if (hold) onDelta(displayReply(reply, friendly));
    else filter.finish();
    await saveMessages(tenant, id, message, storedReply(reply));
    return prefix + displayReply(reply, friendly);
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
  // Stored refusals are the marker; the reader sees the tenant's words (D-047).
  // English, as a reloaded transcript has no reply language to hand.
  const friendly = refusalText(tenant);
  return data.map((m) => (m.role === 'assistant' ? { ...m, content: displayReply(m.content, friendly) } : m));
}
