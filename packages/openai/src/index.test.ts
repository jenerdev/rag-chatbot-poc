// Tool calling over raw fetch, tested against RECORDED shapes, with no API key
// and no network.
//
// `fetch` is stubbed. Each streamed test hands chatStream a body split into
// network chunks at chosen byte offsets, because the bug that matters here is
// a boundary: an SSE event cut in half between two TCP reads, sometimes in
// the middle of a tool call's arguments string. A test that only ever
// delivers whole events cannot find that.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  OpenAIError,
  assistantToolCallMessage,
  chat,
  chatStream,
  speak,
  toolResultMessage,
  transcribe,
  type ChatMessage,
  type ToolDefinition,
} from './index.js';

const TOOLS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'check_availability',
      description: 'Whether each slot is open or taken on a date.',
      parameters: { type: 'object', properties: { date_from: { type: 'string' } }, required: ['date_from'] },
    },
  },
];
const MESSAGES: ChatMessage[] = [{ role: 'user', content: 'Is the 12th free?' }];

/** One SSE event line pair, the way OpenAI writes them. */
const event = (payload: unknown): string => `data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`;
const toolDelta = (fragment: object) => event({ choices: [{ delta: { tool_calls: [fragment] } }] });
const textDelta = (content: string) => event({ choices: [{ delta: { content } }] });
const USAGE = event({ choices: [], usage: { prompt_tokens: 120, completion_tokens: 18 } });
const DONE = event('[DONE]');

/** A streaming Response whose body arrives as these exact chunks, in order. */
function streamedResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  );
}

/** Split one string into pieces at the given offsets: the "network" boundaries. */
function splitAt(text: string, offsets: number[]): string[] {
  const pieces: string[] = [];
  let start = 0;
  for (const offset of offsets) {
    pieces.push(text.slice(start, offset));
    start = offset;
  }
  pieces.push(text.slice(start));
  return pieces;
}

let fetchMock: ReturnType<typeof vi.fn>;
/** The JSON body of the n-th fetch call. */
const sentBody = (n = 0): Record<string, unknown> => JSON.parse(fetchMock.mock.calls[n]![1].body as string);

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  // Read from the environment on every call. Unset, JSON.stringify would drop
  // the `model` key, and the key-list assertions below would describe a
  // request that is never sent for real.
  vi.stubEnv('OPENAI_CHAT_MODEL', 'gpt-4o-mini');
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('chatStream with tools', () => {
  it('reassembles a tool call split across three events (plan/bookings.md § 2.7)', async () => {
    fetchMock.mockResolvedValue(
      streamedResponse([
        toolDelta({ index: 0, id: 'call_x', function: { name: 'check_availability', arguments: '' } }),
        toolDelta({ index: 0, function: { arguments: '{"date_fr' } }),
        toolDelta({ index: 0, function: { arguments: 'om":"2026-10-12"}' } }),
        event({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
        USAGE,
        DONE,
      ]),
    );
    const onDelta = vi.fn();

    const turn = await chatStream(MESSAGES, onDelta, { tools: TOOLS });

    expect(turn.toolCalls).toEqual([{ id: 'call_x', name: 'check_availability', arguments: '{"date_from":"2026-10-12"}' }]);
    expect(JSON.parse(turn.toolCalls[0]!.arguments)).toEqual({ date_from: '2026-10-12' });
    expect(turn.content).toBeNull();
    // Tool-call fragments are never text. Nothing reached the browser.
    expect(onDelta).not.toHaveBeenCalled();
  });

  it('survives an event cut in half by the network, inside the arguments string', async () => {
    const wire =
      toolDelta({ index: 0, id: 'call_y', function: { name: 'check_availability', arguments: '{"date_from":' } }) +
      toolDelta({ index: 0, function: { arguments: '"2026-10-12","date_to":"2026-10-14"}' } }) +
      USAGE +
      DONE;
    // Cut inside the second event's JSON, mid-way through "2026-10-12", and
    // again one byte into the blank line that ends it.
    const cut = wire.indexOf('2026-10-12') + 4;
    const cut2 = wire.indexOf('\n\n', cut) + 1;
    fetchMock.mockResolvedValue(streamedResponse(splitAt(wire, [cut, cut2])));

    const turn = await chatStream(MESSAGES, vi.fn(), { tools: TOOLS });

    expect(JSON.parse(turn.toolCalls[0]!.arguments)).toEqual({ date_from: '2026-10-12', date_to: '2026-10-14' });
  });

  it('keeps two parallel calls apart when their fragments interleave', async () => {
    fetchMock.mockResolvedValue(
      streamedResponse([
        toolDelta({ index: 0, id: 'call_a', function: { name: 'check_availability', arguments: '{"date_from":"2026-' } }),
        toolDelta({ index: 1, id: 'call_b', function: { name: 'check_availability', arguments: '{"date_from":"2026-' } }),
        toolDelta({ index: 1, function: { arguments: '11-01"}' } }),
        toolDelta({ index: 0, function: { arguments: '10-01"}' } }),
        USAGE,
        DONE,
      ]),
    );

    const turn = await chatStream(MESSAGES, vi.fn(), { tools: TOOLS });

    expect(turn.toolCalls.map((c) => [c.id, JSON.parse(c.arguments).date_from])).toEqual([
      ['call_a', '2026-10-01'],
      ['call_b', '2026-11-01'],
    ]);
  });

  it('streams text as before when the model answers without a tool', async () => {
    fetchMock.mockResolvedValue(streamedResponse([textDelta('Yes, '), textDelta('it is open.'), USAGE, DONE]));
    const onDelta = vi.fn();

    const turn = await chatStream(MESSAGES, onDelta, { tools: TOOLS });

    expect(turn).toEqual({ content: 'Yes, it is open.', toolCalls: [] });
    expect(onDelta.mock.calls.map(([t]) => t)).toEqual(['Yes, ', 'it is open.']);
  });

  it('holds the text back with holdContent (the zero-match case, § 2.4)', async () => {
    fetchMock.mockResolvedValue(streamedResponse([textDelta('The capital of France is Paris.'), USAGE, DONE]));
    const onDelta = vi.fn();

    const turn = await chatStream(MESSAGES, onDelta, { tools: TOOLS, holdContent: true });

    // The caller has the text, and nothing is on screen yet. It can still be
    // replaced by the refusal.
    expect(turn.content).toBe('The capital of France is Paris.');
    expect(onDelta).not.toHaveBeenCalled();
  });

  it('still throws when the stream ends without [DONE], with the partial text', async () => {
    fetchMock.mockResolvedValue(
      streamedResponse([textDelta('Let me check'), toolDelta({ index: 0, id: 'call_z', function: { name: 'check_availability', arguments: '{"da' } })]),
    );

    const failure = await chatStream(MESSAGES, vi.fn(), { tools: TOOLS }).catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(OpenAIError);
    expect((failure as OpenAIError).status).toBe(502);
    expect((failure as OpenAIError).partial).toBe('Let me check');
  });

  it('refuses a tool call that never got an id', async () => {
    fetchMock.mockResolvedValue(
      streamedResponse([toolDelta({ index: 0, function: { name: 'check_availability', arguments: '{}' } }), USAGE, DONE]),
    );

    await expect(chatStream(MESSAGES, vi.fn(), { tools: TOOLS })).rejects.toThrow('tool call with no id');
  });

  it('sends the tools, and logs the tool-call count', async () => {
    fetchMock.mockResolvedValue(
      streamedResponse([toolDelta({ index: 0, id: 'c', function: { name: 'check_availability', arguments: '{}' } }), USAGE, DONE]),
    );

    await chatStream(MESSAGES, vi.fn(), { tools: TOOLS });

    expect(sentBody().tools).toEqual(TOOLS);
    expect(console.log).toHaveBeenCalledWith('[openai] stream: 120 in + 18 out, 1 tool call');
  });
});

describe('without tools, the request and the log are exactly what they were', () => {
  // plan/bookings.md Rule 1. Northwind has no tools. Its request body must
  // not gain a `tools` key, not even an empty one, or "Northwind is
  // unchanged" stops being true at the wire.
  it('chatStream: no tools key, a plain string back, the old log line', async () => {
    fetchMock.mockResolvedValue(streamedResponse([textDelta('An answer.'), USAGE, DONE]));

    const answer = await chatStream(MESSAGES, vi.fn());

    expect(answer).toBe('An answer.');
    expect(Object.keys(sentBody()).sort()).toEqual(['messages', 'model', 'stream', 'stream_options', 'temperature']);
    expect(console.log).toHaveBeenCalledWith('[openai] stream: 120 in + 18 out');
  });

  it('chat: no tools key, a plain string back, the old log line', async () => {
    fetchMock.mockResolvedValue(
      Response.json({ choices: [{ message: { content: 'An answer.' } }], usage: { prompt_tokens: 50, completion_tokens: 3 } }),
    );

    const answer = await chat(MESSAGES, { label: 'rewrite', maxTokens: 60 });

    expect(answer).toBe('An answer.');
    expect(Object.keys(sentBody()).sort()).toEqual(['max_tokens', 'messages', 'model', 'temperature']);
    expect(console.log).toHaveBeenCalledWith('[openai] rewrite: 50 in + 3 out');
  });

  it('an empty tools array is a caller bug, refused before any request', async () => {
    await expect(chat(MESSAGES, { tools: [] })).rejects.toThrow('Omit it instead');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('chat with tools (non-streaming)', () => {
  it('returns the calls as ToolCall, arguments still a string', async () => {
    fetchMock.mockResolvedValue(
      Response.json({
        choices: [
          {
            message: {
              content: null,
              tool_calls: [{ id: 'call_q', type: 'function', function: { name: 'check_availability', arguments: '{"date_from":"2026-10-12"}' } }],
            },
          },
        ],
        usage: { prompt_tokens: 200, completion_tokens: 20 },
      }),
    );

    const turn = await chat(MESSAGES, { tools: TOOLS });

    expect(turn).toEqual({
      content: null,
      toolCalls: [{ id: 'call_q', name: 'check_availability', arguments: '{"date_from":"2026-10-12"}' }],
    });
    expect(console.log).toHaveBeenCalledWith('[openai] chat: 200 in + 20 out, 1 tool call');
  });

  it('a text answer with tools offered is a ChatTurn with no calls', async () => {
    fetchMock.mockResolvedValue(
      Response.json({ choices: [{ message: { content: 'Which date?' } }], usage: { prompt_tokens: 90, completion_tokens: 4 } }),
    );

    expect(await chat(MESSAGES, { tools: TOOLS })).toEqual({ content: 'Which date?', toolCalls: [] });
    expect(console.log).toHaveBeenCalledWith('[openai] chat: 90 in + 4 out, 0 tool calls');
  });
});

describe('the messages that carry a tool round trip', () => {
  it('builds the assistant request and the tool result in the wire shape', () => {
    const turn = { content: null, toolCalls: [{ id: 'call_q', name: 'check_availability', arguments: '{"date_from":"2026-10-12"}' }] };

    expect(assistantToolCallMessage(turn)).toEqual({
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'call_q', type: 'function', function: { name: 'check_availability', arguments: '{"date_from":"2026-10-12"}' } }],
    });
    expect(toolResultMessage('call_q', '[{"status":"open"}]')).toEqual({
      role: 'tool',
      tool_call_id: 'call_q',
      content: '[{"status":"open"}]',
    });
  });
});

// plan/voice.md Phase 1: the two voice requests, by their wire shape.
describe('voice: transcribe() and speak()', () => {
  const timeout = () => Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
  const aborted = () => Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });

  it('transcribe sends one multipart file with the model, and returns the text trimmed', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ text: ' May bakante ba kayo bukas? ' }), { status: 200 }));
    const text = await transcribe(new Uint8Array([1, 2, 3]), 'audio/webm');
    expect(text).toBe('May bakante ba kayo bukas?');
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.openai.com/v1/audio/transcriptions');
    const form = init.body as FormData;
    expect(form.get('model')).toBe(process.env.OPENAI_TRANSCRIBE_MODEL ?? 'gpt-4o-mini-transcribe');
    expect((form.get('file') as File).name).toBe('question.webm');
    // fetch writes the multipart boundary; a Content-Type of ours would break it.
    expect(init.headers['Content-Type']).toBeUndefined();
  });

  it('transcribe names a Safari recording .mp4, and a refusal is an OpenAIError in words', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: { message: 'Invalid file format.' } }), { status: 400 }));
    const failure = await transcribe(new Uint8Array([1]), 'audio/mp4').catch((e: unknown) => e);
    expect(((fetchMock.mock.calls[0]![1].body as FormData).get('file') as File).name).toBe('question.mp4');
    expect(failure).toBeInstanceOf(OpenAIError);
    expect((failure as OpenAIError).status).toBe(400);
    expect((failure as OpenAIError).message).toContain('Invalid file format.');
  });

  it('transcribe sends the hint it is given as `prompt`, and no `language`', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ text: 'Ano po ang mga kwarto ninyo?' }), { status: 200 }));
    await transcribe(new Uint8Array([1]), 'audio/webm', { prompt: 'Filipino and English.' });
    const form = fetchMock.mock.calls[0]![1].body as FormData;
    expect(form.get('prompt')).toBe('Filipino and English.');
    expect(form.get('language')).toBeNull();
  });

  it('transcribe past its timeout is a 504 that says so', async () => {
    fetchMock.mockRejectedValue(timeout());
    const failure = await transcribe(new Uint8Array([1]), 'audio/webm', { timeoutMs: 5 }).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(OpenAIError);
    expect((failure as OpenAIError).status).toBe(504);
  });

  it('speak asks for mp3 from tts-1 by default and hands back the body unread', async () => {
    const audio = new Response(new Uint8Array([9, 9, 9]), { status: 200, headers: { 'content-type': 'audio/mpeg' } });
    fetchMock.mockResolvedValue(audio);
    const spoken = await speak('Open on the 18th.', { voice: 'alloy' });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.openai.com/v1/audio/speech');
    expect(JSON.parse(init.body as string)).toEqual({ model: process.env.OPENAI_TTS_MODEL ?? 'tts-1', voice: 'alloy', input: 'Open on the 18th.', response_format: 'mp3' });
    expect(spoken.contentType).toBe('audio/mpeg');
    expect(new Uint8Array(await new Response(spoken.body).arrayBuffer())).toEqual(new Uint8Array([9, 9, 9]));
  });

  it('speak past its timeout is a 504; with nothing to say it does not call out', async () => {
    fetchMock.mockRejectedValue(aborted());
    const failure = await speak('Hello.', { voice: 'alloy', timeoutMs: 5 }).catch((e: unknown) => e);
    expect((failure as OpenAIError).status).toBe(504);
    fetchMock.mockClear();
    await expect(speak('  ', { voice: 'alloy' })).rejects.toThrow('nothing to say');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
