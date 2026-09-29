import 'server-only';
import { NextResponse } from 'next/server';
import { OpenAIError } from '@rag/openai';
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

/** An error carrying an HTTP status: OpenAIError, AdminAuthError, PermissionError, PlatformAuthError, StaffAuthError, and @rag/bookings' three. */
function statusOf(error: unknown): number | undefined {
  const status = (error as { status?: unknown }).status;
  return typeof status === 'number' ? status : undefined;
}

/**
 * Statuses a thrown error may pass straight through, because they describe the
 * REQUEST: bad input (400), not logged in (401), not there (404), and a
 * conflict with existing data (409). The last two came with @rag/bookings
 * (plan/bookings.md Phase 3). Before that, a BookingConflictError would have
 * reached the browser as a 500, as if the server had broken.
 */
// 429: Supabase Auth's sign-in rate limit, passed on as itself (auth-rls Phase 5).
// 403: a member whose role lacks the permission (tenant management Phase 3):
//      logged in, known, and still refused, with the permission named.
const CLIENT_STATUSES = new Set([400, 401, 403, 404, 409, 429]);

/**
 * Map a thrown error to a response.
 *
 * Two kinds of error carry a status, and they mean different things:
 *
 *   - An OpenAIError's status is OPENAI'S reply to US. A 400 or 404 from OpenAI
 *     is this server sending a bad request or naming a model that does not
 *     exist, which is our fault, not the browser's. So only 401 (a bad key)
 *     and 429 (out of credits) pass through, as they always have. 5xx becomes
 *     502, and anything else is a 500.
 *   - Every other status-carrying error (AdminAuthError, the @rag/bookings
 *     errors) states the status of THIS request, so a client status passes
 *     through as-is.
 *
 * Everything else is a 500. The real message always reaches the client: no
 * swallowing, no generic "something went wrong", no retries (architecture.md
 * § 9). This is a learning project — the message is the point.
 */
export function errorResponse(error: unknown): NextResponse {
  const carried = statusOf(error);
  let status = 500;
  if (error instanceof OpenAIError) {
    if (carried === 401 || carried === 429) status = carried;
    else if (carried !== undefined && carried >= 500) status = 502;
  } else if (carried !== undefined && CLIENT_STATUSES.has(carried)) {
    status = carried;
  }

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
