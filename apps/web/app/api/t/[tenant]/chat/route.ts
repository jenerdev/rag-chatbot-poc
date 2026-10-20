import { NextResponse } from 'next/server';
import { answerQuestion, answerQuestionStream } from '@rag/pipeline';
import type { StreamMeta, ToolCallRecord } from '@rag/pipeline';
import { sessionCan } from '@/lib/admin-auth';
import { allowSpend, CHAT_REQUESTS_PER_WINDOW, clientIp } from '@/lib/rate-limit';
import { badRequest } from '@/lib/route';
import { chatSchema, firstError } from '@/lib/schemas';
import { withTenantRoute } from '@/lib/tenant';

// nodejs, NOT edge: the pipeline uses supabase-js and holds a long-lived
// connection open while the model writes. `force-dynamic` because a cached
// answer to a question about documents that may have been deleted is worse
// than no answer at all.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Hosted platforms cut a function off at their default duration, which is
// shorter than a long grounded answer takes. Ignored when running locally.
export const maxDuration = 60;

const encoder = new TextEncoder();

/**
 * A reply for someone who may not see what it was built from (D-140): the
 * same answer without the chunks and the search query. The keys are
 * REMOVED, not emptied, so the screen can tell "nothing matched" (an empty
 * list, drawn as such for staff) from "not yours to see" (no list at all).
 * The tool calls stay: the availability evidence is the guest's too (rule 7).
 */
function withoutSources<T extends { sources: unknown; searchQuery: unknown }>(value: T): Omit<T, 'sources' | 'searchQuery'> {
  const copy: Partial<T> = { ...value };
  delete copy.sources;
  delete copy.searchQuery;
  return copy as Omit<T, 'sources' | 'searchQuery'>;
}

/**
 * Ask a question. Returns the answer plus the exact chunks it was built from.
 *
 * TWO DELIVERIES, ONE ROUTE (D-019). Content negotiation rather than a second
 * endpoint: the browser asks for `text/event-stream` and gets the answer as it
 * is written; curl, a script, and every example in the docs get the original
 * single JSON body. Nothing that already worked stops working.
 */
export const POST = withTenantRoute(async (request, { tenant }) => {
  const parsed = chatSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return badRequest(firstError(parsed.error));

  // The limit, BEFORE anything is spent and before the Accept header is read
  // (plan/rate-limit.md Rule 5): a refused turn is one JSON 429 in both
  // deliveries, and no embedding, retrieval or model call happens. A
  // greeting answered in code counts too, so a stranger cannot learn which
  // messages are cheap. The screen shows these words in the turn.
  if (!(await allowSpend(tenant, 'chat', clientIp(request), CHAT_REQUESTS_PER_WINDOW))) {
    return NextResponse.json({ error: 'Too many questions from here. Please wait a few minutes and ask again.' }, { status: 429 });
  }

  const args = {
    tenant,
    conversationId: parsed.data.conversationId,
    message: parsed.data.message.trim(),
  };

  // D-140: the chunks a reply was built from reach a signed-in member with
  // sources:read (owners and admins by default, grantable to staff) and
  // nobody else. The route is the guard; the screen draws only what arrives.
  // Decided before the answer, from the membership row, and never from
  // anything the request claims. The pipeline itself is untouched.
  const showSources = await sessionCan(request, tenant, 'sources:read');

  // An EXPLICIT header check, not `request.accepts()`-style negotiation.
  //
  // This is the bug the POC hit and documented: curl and most HTTP clients send
  // `Accept: */*`, and a polite negotiation helper happily matches that against
  // text/event-stream. Every curl would then be handed a stream it did not ask
  // for and cannot parse. Only a client that names the type gets one.
  const wantsStream = (request.headers.get('accept') ?? '').includes('text/event-stream');
  if (!wantsStream) {
    const answer = await answerQuestion(args);
    return NextResponse.json(showSources ? answer : withoutSources(answer));
  }

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      // The SSE wire format: an event name, a single-line JSON payload, and a
      // blank line to terminate. JSON.stringify guarantees the payload contains
      // no raw newline, which would otherwise split one event into two.
      //
      // `closed` guards against writing to a controller that is already gone —
      // a client that navigated away, or the very failure being reported.
      let closed = false;
      const send = (event: string, data: unknown): void => {
        if (closed) return;
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };

      // The browser closing the tab should stop the pipeline. Without this we
      // keep paying OpenAI for tokens nobody will ever read.
      const onAbort = (): void => {
        closed = true;
      };
      request.signal.addEventListener('abort', onAbort);

      try {
        await answerQuestionStream({
          ...args,
          onMeta: (meta: StreamMeta) => send('meta', showSources ? meta : withoutSources(meta)),
          onDelta: (text: string) => send('delta', { text }),
          // One event per tool call, as it completes and before the answer
          // built from it (plan/bookings.md Phase 6). A client that does not
          // know this event ignores it: the answer still arrives as deltas.
          onTool: (record: ToolCallRecord) => send('tool', record),
        });
        send('done', {});
      } catch (error) {
        // The headers went out with the 200, so the status code is already
        // fixed and the error map in withRoute() cannot help. The failure has
        // to travel down the stream as data. This is the cost of streaming,
        // and it is why the client must treat an `error` event as seriously as
        // a bad status.
        const message = error instanceof Error ? error.message : String(error);
        console.error('[error]', message);
        send('error', { error: message });
      } finally {
        request.signal.removeEventListener('abort', onAbort);
        closed = true;
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      // Without this, a proxy in front of the app may buffer the whole response
      // and deliver it in one go — which looks exactly like streaming being
      // broken, while every line of this file is correct.
      'X-Accel-Buffering': 'no',
      Connection: 'keep-alive',
    },
  });
});
