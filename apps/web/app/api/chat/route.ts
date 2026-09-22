import { NextResponse } from 'next/server';
import { answerQuestion, answerQuestionStream } from '@rag/pipeline';
import type { StreamMeta } from '@rag/pipeline';
import { badRequest, withRoute } from '@/lib/route';
import { chatSchema, firstError } from '@/lib/schemas';
import { bridgeTenant } from '@/lib/tenant';

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
 * Ask a question. Returns the answer plus the exact chunks it was built from.
 *
 * TWO DELIVERIES, ONE ROUTE (D-019). Content negotiation rather than a second
 * endpoint: the browser asks for `text/event-stream` and gets the answer as it
 * is written; curl, a script, and every example in the docs get the original
 * single JSON body. Nothing that already worked stops working.
 */
export const POST = withRoute(async (request: Request) => {
  const parsed = chatSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return badRequest(firstError(parsed.error));

  const args = {
    // ⚠ D-031 bridge: pinned to northwind until Phase 5 moves this route to
    // /api/t/[tenant]/chat.
    tenant: await bridgeTenant(),
    conversationId: parsed.data.conversationId,
    message: parsed.data.message.trim(),
  };

  // An EXPLICIT header check, not `request.accepts()`-style negotiation.
  //
  // This is the bug the POC hit and documented: curl and most HTTP clients send
  // `Accept: */*`, and a polite negotiation helper happily matches that against
  // text/event-stream. Every curl would then be handed a stream it did not ask
  // for and cannot parse. Only a client that names the type gets one.
  const wantsStream = (request.headers.get('accept') ?? '').includes('text/event-stream');
  if (!wantsStream) {
    return NextResponse.json(await answerQuestion(args));
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
          onMeta: (meta: StreamMeta) => send('meta', meta),
          onDelta: (text: string) => send('delta', { text }),
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
