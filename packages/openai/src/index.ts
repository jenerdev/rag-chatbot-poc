// @rag/openai — the only two HTTP calls this project makes to OpenAI.
//
// Written with the built-in fetch rather than the `openai` SDK (D-002). These
// are the two most instructive requests in the whole project, and the SDK would
// turn them into method calls with the request body hidden inside. Node 18+
// ships fetch globally, so this costs zero dependencies.
//
// This module knows NOTHING about chunks, documents, prompts or retrieval. It
// takes text and returns vectors; it takes messages and returns a string.
// Everything RAG-specific lives in @rag/pipeline.
//
// Offered tools, it returns the tool calls the model asked for as well
// (plan/bookings.md Phase 5), and it still runs none of them. It does not
// know what a tool does, and it does not parse the arguments. The loop that
// runs tools and sends their results back is @rag/pipeline's, and it is
// hand-written for the same reason these two requests are (D-002).

const EMBEDDINGS_URL = 'https://api.openai.com/v1/embeddings';
const CHAT_URL = 'https://api.openai.com/v1/chat/completions';
const TRANSCRIBE_URL = 'https://api.openai.com/v1/audio/transcriptions';
const SPEECH_URL = 'https://api.openai.com/v1/audio/speech';

/**
 * The four roles this project sends.
 *
 * `tool` arrived with tool calling (plan/bookings.md Phase 5). It is how the
 * RESULT of a tool goes back to the model: one message per call, pointing at
 * the call's id. The model never runs anything. It asks for a call, and this
 * side runs it and pastes the result into the conversation as text, which is
 * the same move as pasting retrieved chunks into the system message.
 */
export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

/**
 * One message in the array sent to the model.
 *
 * A union, not one interface, because the four roles carry different fields.
 * An assistant turn that asked for tools has `tool_calls` and may have
 * `content: null`. A tool result has `tool_call_id`. `{ role, content }`
 * with a string content is still a valid ChatMessage, which is all that
 * buildPrompt() and the query rewriter ever build.
 */
export type ChatMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: WireToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };

/**
 * A tool the model may ask to call, in the shape the Chat Completions API
 * takes. `parameters` is a JSON Schema object. The model reads the
 * description and the schema, and nothing else, so they are the whole
 * interface, which makes them prompt text.
 */
export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

/**
 * A tool call as the model asked for it.
 *
 * `arguments` is a STRING, and it stays one here. It is JSON the model wrote,
 * so it can be malformed, and parsing it is the job of whoever runs the tool
 * and can say what "malformed" means to the model. This module is transport.
 */
export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

/** A tool call as it travels inside an assistant message, both from OpenAI and back to it. */
export interface WireToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

/**
 * The model's reply to a request that offered tools.
 *
 * Either or both can be present. `toolCalls` empty means the model answered
 * in text. `content` null or empty with calls present means it wants the
 * tools run first.
 */
export interface ChatTurn {
  content: string | null;
  toolCalls: ToolCall[];
}

export interface ChatOptions {
  /** Only sent when set — see the comment at the call site. */
  maxTokens?: number;
  temperature?: number;
  /** Distinguishes the two kinds of call in the cost log. */
  label?: string;
}

export interface ToolChatOptions extends ChatOptions {
  /** Offered to the model. Non-empty: an empty array is a caller bug, and is refused. */
  tools: ToolDefinition[];
}

/** The assistant message that records a tool request, to append before the tool results. */
export function assistantToolCallMessage(turn: ChatTurn): ChatMessage {
  return {
    role: 'assistant',
    content: turn.content,
    tool_calls: turn.toolCalls.map((call) => ({
      id: call.id,
      type: 'function',
      function: { name: call.name, arguments: call.arguments },
    })),
  };
}

/** A tool's result, as the message the model reads it from. */
export function toolResultMessage(toolCallId: string, content: string): ChatMessage {
  return { role: 'tool', tool_call_id: toolCallId, content };
}

/**
 * Tools go in the request body only when there are tools.
 *
 * A request without tools must be byte-identical to the request this module
 * sent before tool calling existed. That is how Northwind, which has no tools,
 * is guaranteed to behave exactly as it did (plan/bookings.md Rule 1). Sending
 * `tools: []` would not be identical, and OpenAI rejects an empty array anyway.
 */
function toolsField(tools: ToolDefinition[] | undefined): { tools?: ToolDefinition[] } {
  if (tools === undefined) return {};
  if (tools.length === 0) throw new Error('chat: `tools` was passed but is empty. Omit it instead.');
  return { tools };
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/**
 * An OpenAI failure, carrying the status code the route layer maps to HTTP.
 *
 * In the JS original this was a plain Error with a `status` property bolted on
 * after construction. The behaviour is identical; the only change is that
 * `status` is now part of the type, because the error map in the web app
 * (`401 and 429 pass through, >= 500 becomes 502`) is built entirely on this
 * property existing. Typing it as `any` would leave the one piece of the
 * contract that matters unchecked.
 */
export class OpenAIError extends Error {
  readonly status: number;
  /**
   * Set only by chatStream, when a stream ends before its terminator.
   *
   * `declare`, not a plain field. Under `target: ES2022` TypeScript compiles a
   * declared field to a `defineProperty` in the constructor, so every error
   * would carry `partial: undefined` — harmless to the code that reads it
   * (`typeof x === 'string'` either way) but visible in every stack dump, and
   * a difference from the JS this was ported from. `declare` emits nothing, so
   * the property is absent unless it is actually set.
   */
  declare readonly partial?: string;

  constructor(message: string, status: number, partial?: string) {
    super(message);
    this.name = 'OpenAIError';
    this.status = status;
    if (partial !== undefined) this.partial = partial;
  }
}

/**
 * Turn an HTTP failure into an error a human can act on.
 *
 * `architecture.md` § 9: no retry loops, no exponential backoff, no swallowing.
 * The two failures you will actually hit are 401 and 429, and they mean very
 * different things, so they get their own sentences. The `status` property is
 * what the route layer uses to pick an HTTP status code — error mapping happens
 * in exactly one place, and this is not it.
 */
async function toError(res: Response): Promise<OpenAIError> {
  const raw = await res.text();
  let detail = raw;
  try {
    // OpenAI returns { error: { message, type, code } } on failure.
    const parsed: unknown = JSON.parse(raw);
    detail = errorMessageOf(parsed) ?? raw;
  } catch {
    // Not JSON — a proxy or gateway error page. Use the raw text.
  }

  let message: string;
  if (res.status === 401) message = 'OpenAI rejected the API key — check OPENAI_API_KEY in .env';
  else if (res.status === 429) message = 'Out of OpenAI credits or rate limited';
  else if (res.status === 404) message = 'OpenAI does not recognise that model name — check the model env vars';
  else if (res.status >= 500) message = 'OpenAI is having a problem on their end';
  else message = 'OpenAI request failed';

  return new OpenAIError(`${message} (HTTP ${res.status}): ${detail}`, res.status);
}

/** Read `.error.message` out of a parsed body without asserting its shape. */
function errorMessageOf(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const error = (body as { error?: unknown }).error;
  if (typeof error !== 'object' || error === null) return undefined;
  const message = (error as { message?: unknown }).message;
  return typeof message === 'string' ? message : undefined;
}

function authHeaders(): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
  };
}

interface EmbeddingsResponse {
  data: { index: number; embedding: number[] }[];
}

interface ChatResponse {
  choices: { message: { content: string | null; tool_calls?: WireToolCall[] } }[];
  usage: { prompt_tokens: number; completion_tokens: number };
}

/**
 * Embed an array of strings. Returns an array of vectors, in the same order.
 *
 * ONE HTTP call for the whole array (F-3). The `input` field accepts a list,
 * so a 40-chunk document costs one request, not forty — which matters for
 * latency far more than for money. Embedding a chunk at a time would make
 * ingest roughly 40× slower for no benefit.
 *
 * The model is read from the environment on every call rather than captured at
 * import time, so it is always whatever .env currently says.
 *
 * ⚠️ THE constraint of this project: whatever model embeds the documents must
 * also embed the questions. Vectors from different models describe positions in
 * unrelated coordinate spaces, so comparing them yields similarity scores that
 * look perfectly reasonable and mean nothing — and nothing errors (D-004, R-3).
 * Both callers go through this one function, which is how that stays true.
 *
 * The 1536 dimensions are a RUNTIME fact about the model named in the env var,
 * not something the type system can promise. `vector(1536)` in the schema is
 * the other half of that coupling, and neither half is checked by a compiler.
 */
export async function embed(texts: string[]): Promise<number[][]> {
  if (!Array.isArray(texts)) throw new Error('embed: expected an array of strings');
  if (texts.length === 0) return [];

  const res = await fetch(EMBEDDINGS_URL, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({
      model: process.env.OPENAI_EMBEDDING_MODEL,
      input: texts,
    }),
  });

  if (!res.ok) throw await toError(res);

  const body = (await res.json()) as EmbeddingsResponse;

  // The response is { data: [{ index, embedding }, ...] }. OpenAI documents
  // that `data` comes back in input order, but it also hands you an explicit
  // `index` on every item — so sort by it rather than trusting the order. A
  // silent misalignment here would attach every chunk to the wrong vector,
  // which is exactly the kind of failure that produces confident nonsense.
  const vectors = body.data
    .slice()
    .sort((a, b) => a.index - b.index)
    .map((item) => item.embedding);

  if (vectors.length !== texts.length) {
    throw new Error(`embed: asked for ${texts.length} embeddings, got ${vectors.length}`);
  }

  return vectors;
}

/**
 * Send a conversation and get the assistant's reply as a string.
 *
 * `messages` is a plain array of { role, content }. The model is stateless:
 * it remembers nothing between calls, so this array is the entire world it can
 * see on this turn. That is precisely why RAG works the way it does — retrieved
 * chunks are not injected into the model, they are pasted into this array as
 * ordinary text (architecture.md § 6).
 */
//
// TOOL CALLING (plan/bookings.md Phase 5): pass `tools`, and the reply is a
// ChatTurn, `{ content, toolCalls }`, instead of a string. Two overloads rather
// than one union return type, so the existing callers (the answer and the
// query rewriter) still get a plain string and need no narrowing. The
// overload is decided by the `tools` key being present.
export async function chat(messages: ChatMessage[], options?: ChatOptions): Promise<string>;
export async function chat(messages: ChatMessage[], options: ToolChatOptions): Promise<ChatTurn>;
export async function chat(
  messages: ChatMessage[],
  options: ChatOptions | ToolChatOptions = {},
): Promise<string | ChatTurn> {
  const { maxTokens, temperature = 0.2, label = 'chat' } = options;
  const tools = 'tools' in options ? options.tools : undefined;

  const res = await fetch(CHAT_URL, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({
      model: process.env.OPENAI_CHAT_MODEL,
      messages,
      // Low temperature by default: the job is "read this context and report
      // what it says", which wants faithfulness, not invention.
      temperature,
      // Only sent when asked for. Used by the query rewriter, whose output is
      // one short line — capping it means a confused model cannot burn output
      // tokens writing an essay where a question was wanted.
      ...(maxTokens ? { max_tokens: maxTokens } : {}),
      ...toolsField(tools),
    }),
  });

  if (!res.ok) throw await toError(res);

  const body = (await res.json()) as ChatResponse;
  const message = body.choices[0]!.message;
  const toolCalls = (message.tool_calls ?? []).map((call) => ({
    id: call.id,
    name: call.function.name,
    arguments: call.function.arguments,
  }));

  // `label` distinguishes the two kinds of call in the log, so the cost of
  // query rewriting is visible rather than blended into the answer's cost.
  // The tool-call count is added only when tools were offered, so a call
  // without tools logs exactly the line it always did.
  console.log(
    `[openai] ${label}: ${body.usage.prompt_tokens} in + ${body.usage.completion_tokens} out` +
      (tools ? `, ${plural(toolCalls.length, 'tool call')}` : ''),
  );

  if (tools) return { content: message.content, toolCalls };
  // Without tools the model always answers in text. `?? ''` only covers a
  // null that the API does not send in this case, so the type can stay string.
  return message.content ?? '';
}

interface StreamChunk {
  error?: { message?: string };
  usage?: { prompt_tokens: number; completion_tokens: number };
  choices?: {
    delta?: {
      content?: string | null;
      tool_calls?: { index: number; id?: string; function?: { name?: string; arguments?: string } }[];
    };
  }[];
}

export interface StreamOptions {
  temperature?: number;
}

export interface ToolStreamOptions extends StreamOptions {
  tools: ToolDefinition[];
  /**
   * Collect the text instead of calling onDelta with it.
   *
   * For the zero-match case of plan/bookings.md § 2.4. With no retrieved
   * chunk, a reply is allowed out only if the model called a tool, and that
   * is not known until the stream ends. Text already on screen cannot be
   * taken back, so it is held.
   */
  holdContent?: boolean;
}

/**
 * Same call as chat(), but delivers the answer token by token (D-019).
 *
 * Adding `stream: true` changes the response from one JSON body into a
 * **Server-Sent Events** stream: a sequence of `data:` lines separated by
 * blank lines, ending with the literal `data: [DONE]`.
 *
 *     data: {"choices":[{"delta":{"content":"The"}}]}
 *
 *     data: {"choices":[{"delta":{"content":" Quiet"}}]}
 *
 *     data: [DONE]
 *
 * So this function does three things the non-streaming version does not:
 *
 *   1. reads the response body as a stream rather than awaiting a whole JSON
 *   2. buffers, because a network chunk can split an event in half — the
 *      boundary between TCP packets has nothing to do with the boundary
 *      between SSE events, and assuming otherwise works right up until it
 *      doesn't
 *   3. reassembles the deltas into the complete answer, which we still need
 *      in order to save it to the database
 *
 * `stream_options.include_usage` asks OpenAI for a final chunk carrying the
 * token counts, which a streamed response would otherwise never report.
 *
 * TOOL CALLING (plan/bookings.md § 2.7). With `tools`, a tool call arrives in
 * pieces too, keyed by `index`:
 *
 *     data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_x","function":{"name":"check_availability","arguments":""}}]}}]}
 *     data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\"date_fr"}}]}}]}
 *     data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"om\":\"2026-10-12\"}"}}]}}]}
 *
 * The id and name come once, in the first fragment. The `arguments` string is
 * spread over many fragments, and it is not JSON until the last one has
 * arrived. So fragments are appended per index and nothing is parsed here.
 * Two calls in one turn interleave, which is why it is per index and not
 * "the current call".
 *
 * @param onDelta called with each fragment of TEXT as it lands (never with tool-call fragments)
 * @returns the complete answer, or with `tools`, the complete ChatTurn
 */
export async function chatStream(
  messages: ChatMessage[],
  onDelta: (text: string) => void,
  options?: StreamOptions,
): Promise<string>;
export async function chatStream(
  messages: ChatMessage[],
  onDelta: (text: string) => void,
  options: ToolStreamOptions,
): Promise<ChatTurn>;
export async function chatStream(
  messages: ChatMessage[],
  onDelta: (text: string) => void,
  options: StreamOptions | ToolStreamOptions = {},
): Promise<string | ChatTurn> {
  const { temperature = 0.2 } = options;
  const tools = 'tools' in options ? options.tools : undefined;
  const holdContent = 'holdContent' in options && options.holdContent === true;

  const res = await fetch(CHAT_URL, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({
      model: process.env.OPENAI_CHAT_MODEL,
      messages,
      temperature,
      stream: true,
      stream_options: { include_usage: true },
      ...toolsField(tools),
    }),
  });

  if (!res.ok) throw await toError(res);

  const decoder = new TextDecoder();
  let buffer = '';
  let answer = '';
  let usage: StreamChunk['usage'] = undefined;
  // One entry per tool-call index, filled in fragment by fragment. A Map, not
  // an array, so an index that arrives out of order leaves no hole.
  const calls = new Map<number, ToolCall>();
  // OpenAI ends a healthy stream with the literal `data: [DONE]`. Without
  // tracking it, ANY end of stream looks like success — including a dropped
  // connection halfway through a sentence. The partial text would then be
  // returned as if complete, saved to the database as the assistant's reply,
  // and reported to the browser as a finished answer. Silent truncation, no
  // error anywhere, and a corrupted transcript: precisely the failure shape
  // this project keeps running into (risks.md R-3).
  let sawDone = false;

  // Non-null, as in the JS: a streaming 200 always has a body, and if it
  // somehow did not, failing here is the same failure the original had.
  for await (const bytes of res.body!) {
    // `stream: true` on decode() keeps a partial multi-byte character back
    // until the rest of it arrives, rather than emitting a replacement char.
    buffer += decoder.decode(bytes, { stream: true }).replace(/\r/g, '');

    // Events are separated by a blank line. Anything after the last blank
    // line is an incomplete event and stays in the buffer for the next pass.
    let boundary: number;
    while ((boundary = buffer.indexOf('\n\n')) !== -1) {
      const event = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);

      for (const line of event.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '') continue;
        if (payload === '[DONE]') {
          sawDone = true;
          continue;
        }

        const parsed = JSON.parse(payload) as StreamChunk;

        // OpenAI can report a failure INSIDE a 200 response, once streaming
        // has started. Such a chunk has no `choices` and no `usage`, so
        // without this it is skipped in silence: the caller gets an empty
        // answer, an empty assistant row is written, and everything reports
        // success.
        if (parsed.error) {
          throw new OpenAIError(
            `OpenAI failed mid-stream: ${parsed.error.message ?? 'unknown error'}`,
            502,
          );
        }

        if (parsed.usage) usage = parsed.usage;

        const delta = parsed.choices?.[0]?.delta;

        const text = delta?.content;
        if (text) {
          answer += text;
          if (!holdContent) onDelta(text);
        }

        for (const fragment of delta?.tool_calls ?? []) {
          const call = calls.get(fragment.index) ?? { id: '', name: '', arguments: '' };
          if (fragment.id) call.id = fragment.id;
          // The name normally arrives whole, in the first fragment. Appending
          // costs nothing and is still right if it is ever split.
          if (fragment.function?.name) call.name += fragment.function.name;
          if (fragment.function?.arguments) call.arguments += fragment.function.arguments;
          calls.set(fragment.index, call);
        }
      }
    }
  }

  if (!sawDone) {
    // The stream ended without its terminator. Whatever arrived is incomplete,
    // and a half-answer presented as a whole one is worse than a visible
    // failure — the caller can decide what to do, but it must be told.
    throw new OpenAIError(
      `OpenAI stream ended early after ${answer.length} characters — the answer is incomplete`,
      502,
      answer,
    );
  }

  const toolCalls = [...calls.entries()].sort(([a], [b]) => a - b).map(([, call]) => call);

  if (usage) {
    console.log(
      `[openai] stream: ${usage.prompt_tokens} in + ${usage.completion_tokens} out` +
        (tools ? `, ${plural(toolCalls.length, 'tool call')}` : ''),
    );
  }

  if (!tools) return answer;

  // A call with no id or no name cannot be answered: a tool result has to name
  // the id it answers. Refuse it here, loudly, rather than hand the executor
  // something it will fail on less clearly.
  for (const call of toolCalls) {
    if (!call.id || !call.name) {
      throw new OpenAIError(`OpenAI streamed a tool call with no ${call.id ? 'name' : 'id'}`, 502);
    }
  }
  return { content: answer === '' ? null : answer, toolCalls };
}

// --- voice (plan/voice.md, D-134) ---------------------------------------------
//
// Two more requests, by hand like the others (D-001). Voice is a way in and a
// way out of the pipeline, never a second pipeline (the plan's Rule 1): these
// turn audio into text and text into audio, and nothing here answers.

/** A timeout is an error with a status of its own, so the route can tell "too slow" from "refused". */
function timedOut(what: string, ms: number): OpenAIError {
  return new OpenAIError(`OpenAI ${what} took longer than ${Math.round(ms / 1000)} s`, 504);
}

/**
 * Audio in, text out: `/v1/audio/transcriptions`, multipart, one file.
 *
 * `mime` is the type the ROUTE checked by the bytes, never the browser's word
 * (the plan's Rule 5). The model is `OPENAI_TRANSCRIBE_MODEL`, read per call
 * like the chat model. No `language` is sent: the model hears English,
 * Tagalog and Taglish on its own (Phase 0: all three word for word), and the
 * reply language is decided later, in code, from the text (D-043).
 */
export async function transcribe(audio: Uint8Array, mime: string, options: { timeoutMs?: number } = {}): Promise<string> {
  const { timeoutMs = 30_000 } = options;
  const form = new FormData();
  form.append('model', process.env.OPENAI_TRANSCRIBE_MODEL ?? 'gpt-4o-mini-transcribe');
  // The file name's extension is how the service learns the container.
  const extension = mime.includes('mp4') ? 'mp4' : mime.includes('wav') ? 'wav' : mime.includes('mpeg') ? 'mp3' : 'webm';
  form.append('file', new Blob([audio], { type: mime }), `question.${extension}`);

  const started = Date.now();
  let res: Response;
  try {
    // No Content-Type of our own: fetch writes the multipart boundary.
    res = await fetch(TRANSCRIBE_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body: form,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'TimeoutError') throw timedOut('transcription', timeoutMs);
    throw error;
  }
  if (!res.ok) throw await toError(res);
  const body = (await res.json()) as { text?: unknown; usage?: { input_tokens?: number; output_tokens?: number } };
  if (typeof body.text !== 'string') throw new OpenAIError('OpenAI returned a transcription with no text', 502);
  console.log(
    `[openai] transcribe: ${audio.length} bytes → ${body.text.length} chars in ${Date.now() - started} ms` +
      (body.usage ? ` (${body.usage.input_tokens ?? '?'} in + ${body.usage.output_tokens ?? '?'} out)` : ''),
  );
  return body.text.trim();
}

/**
 * Text in, audio out: `/v1/audio/speech`. Returns the response body as it
 * arrives, so the route can stream it to the browser without holding it.
 *
 * `OPENAI_TTS_MODEL` defaults to `tts-1`: Phase 0 measured `gpt-4o-mini-tts`
 * at 116 s of OpenAI's own processing time and `tts-1` at 1.1 to 1.9 s to the
 * first byte. The timeout covers the wait for the HEADERS; a body that
 * started is not cut off.
 */
export async function speak(
  text: string,
  options: { voice: string; timeoutMs?: number },
): Promise<{ body: ReadableStream<Uint8Array>; contentType: string }> {
  const { voice, timeoutMs = 15_000 } = options;
  if (text.trim() === '') throw new Error('speak: nothing to say');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  let res: Response;
  try {
    res = await fetch(SPEECH_URL, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ model: process.env.OPENAI_TTS_MODEL ?? 'tts-1', voice, input: text, response_format: 'mp3' }),
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw timedOut('speech', timeoutMs);
    throw error;
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw await toError(res);
  if (!res.body) throw new OpenAIError('OpenAI returned speech with no body', 502);
  console.log(`[openai] speak: ${text.length} chars, first byte in ${Date.now() - started} ms`);
  return { body: res.body, contentType: res.headers.get('content-type') ?? 'audio/mpeg' };
}
