import 'server-only';
import { NextResponse } from 'next/server';
import { OpenAIError } from '@rag/openai';
import { assertEnv } from './env';
import { errorBody, newRequestId } from './error-body';

// Errors -> status codes, in exactly one place.
//
// The POC had `app.use((error, req, res, next) => ...)` at the bottom of
// server.js: Express called it for any route that threw, so the mapping was
// written once and could not be forgotten.
//
// Route Handlers have no equivalent. Nothing catches a throw except the
// framework's own generic 500, which would replace the real message with a
// stack trace in development and nothing at all in production. So the wrapper
// below has to be applied to EVERY handler by hand — one missed wrapper and
// that route silently stops reporting why it failed.

/**
 * Map a thrown error to a response (the rules are lib/error-body.ts's, D-158).
 *
 * A status that describes the REQUEST (400, 401, 403, 404, 409, 429; thrown
 * by AdminAuthError, PermissionError, the @rag/bookings errors and the rest)
 * passes through with its words, which were written for a person. Anything
 * else is the server's failure: a fixed sentence and a request id for the
 * client, the real message in the server log beside that id. An OpenAIError
 * is always a 502: its status is OpenAI's reply to US, never the browser's
 * fault. Outside production the real message is appended to the body.
 */
export function errorResponse(error: unknown): NextResponse {
  const mapped = errorBody(error, {
    openai: error instanceof OpenAIError,
    expose: process.env.NODE_ENV !== 'production',
    requestId: newRequestId(),
  });
  console.error(mapped.log);
  const response = NextResponse.json(mapped.body, { status: mapped.status });
  if (mapped.body.requestId) response.headers.set('X-Request-Id', mapped.body.requestId);
  return response;
}

/**
 * Wrap a Route Handler so a throw becomes the mapped response.
 *
 * `HandlerContext` is generic over the route's params because Next 15 hands
 * them in as a promise, and each route's shape differs.
 */
export function withRoute<Context>(
  handler: (request: Request, context: Context) => Promise<Response>,
): (request: Request, context: Context) => Promise<Response> {
  return async (request, context) => {
    try {
      // Config first: a missing key should be one clear sentence, not a 401
      // twenty minutes later while debugging something else (architecture.md § 8).
      assertEnv();
      return await handler(request, context);
    } catch (error) {
      return errorResponse(error);
    }
  };
}

/** A 400 with the exact message the POC used, which both screens render verbatim. */
export function badRequest(message: string): NextResponse {
  return NextResponse.json({ error: message }, { status: 400 });
}

/**
 * Parse a route parameter that must be a positive integer id.
 *
 * Returns null rather than throwing, because "invalid document id" is a 400 and
 * everything this wrapper throws becomes a 500.
 */
export function parseId(raw: string): number | null {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}
