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

const EMBEDDINGS_URL = 'https://api.openai.com/v1/embeddings';
const CHAT_URL = 'https://api.openai.com/v1/chat/completions';

/** The three roles this project sends. OpenAI accepts others; nothing here uses them. */
export type ChatRole = 'system' | 'user' | 'assistant';

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export interface ChatOptions {
  /** Only sent when set — see the comment at the call site. */
  maxTokens?: number;
  temperature?: number;
  /** Distinguishes the two kinds of call in the cost log. */
  label?: string;
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
  choices: { message: { content: string } }[];
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
export async function chat(messages: ChatMessage[], options: ChatOptions = {}): Promise<string> {
  const { maxTokens, temperature = 0.2, label = 'chat' } = options;

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
    }),
  });

  if (!res.ok) throw await toError(res);

  const body = (await res.json()) as ChatResponse;
  // `label` distinguishes the two kinds of call in the log, so the cost of
  // query rewriting is visible rather than blended into the answer's cost.
  console.log(`[openai] ${label}: ${body.usage.prompt_tokens} in + ${body.usage.completion_tokens} out`);
  return body.choices[0]!.message.content;
}

interface StreamChunk {
  error?: { message?: string };
  usage?: { prompt_tokens: number; completion_tokens: number };
  choices?: { delta?: { content?: string } }[];
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
 * @param onDelta called with each fragment as it lands
 * @returns the complete answer
 */
export async function chatStream(
  messages: ChatMessage[],
  onDelta: (text: string) => void,
  options: { temperature?: number } = {},
): Promise<string> {
  const { temperature = 0.2 } = options;

  const res = await fetch(CHAT_URL, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({
      model: process.env.OPENAI_CHAT_MODEL,
      messages,
      temperature,
      stream: true,
      stream_options: { include_usage: true },
    }),
  });

  if (!res.ok) throw await toError(res);

  const decoder = new TextDecoder();
  let buffer = '';
  let answer = '';
  let usage: StreamChunk['usage'] = undefined;
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

        const text = parsed.choices?.[0]?.delta?.content;
        if (text) {
          answer += text;
          onDelta(text);
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

  if (usage) {
    console.log(`[openai] stream: ${usage.prompt_tokens} in + ${usage.completion_tokens} out`);
  }
  return answer;
}
