// Audit S-3 / B-6 (D-158): what a failed request tells the CLIENT, decided in
// one pure function, so the route map (lib/route.ts) and the chat stream's
// error event (chat/route.ts) say the same thing, and vitest can pin it.
//
// Before this, every 500 carried the thrown message as its body: Postgres's
// words (constraint, function and column names), PostgREST's, and OpenAI's
// (an invalid key's 401 echoes a fragment of the key). Anyone on the open
// routes (the chat, the booking page, Manage booking) could read the schema
// off them.
//
// Now:
//   - A status that describes the REQUEST (400, 401, 403, 404, 409, 429),
//     thrown by our own code with words written for a person, passes through
//     as before: those words ARE the answer ("taken on <date>…").
//   - Everything else is the server's failure: a fixed sentence and a short
//     request id. The real message goes to the server log beside the same
//     id, so a person reporting "it said ref 3f9a1c2e" leads to the line.
//   - Any OpenAI failure is the server's too (a bad key is our .env, out of
//     credits is our account, OpenAI's 400 is our request), so it is a 502
//     with its own sentence, never OpenAI's text or its 401/429: a 401 would
//     tell the browser IT is not logged in, a 429 that IT sent too much.
//   - `expose` (anything but production) appends the real message, because
//     this project was built to be understood (CLAUDE.md) and a developer on
//     `pnpm dev` should not have to open the terminal to see why.

/** Statuses whose words were written for the person who sent the request. */
export const CLIENT_STATUSES = new Set([400, 401, 403, 404, 409, 429]);

/** The server failed. Nothing about how. */
export const SERVER_FAILED = 'Something went wrong on our side. Please try again in a moment.';
/** OpenAI failed or refused us. Nothing about how. */
export const ASSISTANT_FAILED = 'The assistant could not answer just now. Please try again in a moment.';

export interface ErrorBody {
  status: number;
  body: { error: string; requestId?: string };
  /** The line for the server log: the real message, with the id. */
  log: string;
}

/**
 * Map a thrown error to what the client sees.
 * @param error    what was thrown
 * @param options  openai: the error came from @rag/openai; expose: append the
 *                 real message (not production); requestId: the id both the
 *                 body and the log carry
 */
export function errorBody(error: unknown, options: { openai: boolean; expose: boolean; requestId: string }): ErrorBody {
  const message = error instanceof Error ? error.message : String(error);
  const carried = (error as { status?: unknown } | null)?.status;

  if (!options.openai && typeof carried === 'number' && CLIENT_STATUSES.has(carried)) {
    return { status: carried, body: { error: message }, log: `[error] ${carried} ${message}` };
  }

  const status = options.openai ? 502 : 500;
  const sentence = options.openai ? ASSISTANT_FAILED : SERVER_FAILED;
  const id = options.requestId;
  return {
    status,
    body: { error: `${sentence} (ref ${id})${options.expose ? ` [dev: ${message}]` : ''}`, requestId: id },
    log: `[error] ${status} ref ${id}: ${message}`,
  };
}

/** A short id for one failure: enough to find its log line, too short to mean anything else. */
export function newRequestId(): string {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 8);
}
