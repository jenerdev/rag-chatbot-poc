import 'server-only';
import { NextResponse } from 'next/server';
import { assertEnv } from './env';

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

/** An error carrying an upstream HTTP status, as @rag/openai throws. */
function statusOf(error: unknown): number | undefined {
  const status = (error as { status?: unknown }).status;
  return typeof status === 'number' ? status : undefined;
}

/**
 * Map a thrown error to a response.
 *
 * Errors thrown by @rag/openai carry the upstream HTTP status. Everything else
 * is a 500. The real message always reaches the client: no swallowing, no
 * generic "something went wrong", no retries (architecture.md § 9). This is a
 * learning project — the message is the point.
 */
export function errorResponse(error: unknown): NextResponse {
  const upstream = statusOf(error);
  const status =
    upstream === 401 || upstream === 429
      ? upstream
      : upstream !== undefined && upstream >= 500
        ? 502
        : 500;

  const message = error instanceof Error ? error.message : String(error);
  console.error('[error]', message);
  return NextResponse.json({ error: message }, { status });
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
