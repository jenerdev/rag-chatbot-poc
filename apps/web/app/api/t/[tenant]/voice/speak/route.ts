import { NextResponse } from 'next/server';
import { speak } from '@rag/openai';
import { latestReply } from '@rag/pipeline';
import { requireFeature } from '@/lib/feature-flags';
import { allow, clientIp } from '@/lib/rate-limit';
import { badRequest } from '@/lib/route';
import { firstError, voiceSpeakSchema } from '@/lib/schemas';
import { speakable } from '@/lib/speakable';
import { withTenantRoute } from '@/lib/tenant';
import { REPLY_VOICE, SPEAK_TIMEOUT_MS, VOICE_REQUESTS_PER_WINDOW } from '@/lib/voice';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The conversation's latest reply, spoken (plan/voice.md, D-134).
 *
 * Takes `{ conversationId }`, NEVER text (Rule 2): an open route that spoke
 * any text would be free text-to-speech on the tenant's key. The reply is
 * read on the chat token by latestReply() (both walls), turned into the
 * tenant's words if it was a refusal, and made sayable by speakable(), the
 * same function the browser's fallback voice uses (Rules 3 and 6).
 *
 *   200  audio/mpeg, streamed as OpenAI sends it
 *   204  nothing to say (a reply of only emoji)
 *   400  no conversation id
 *   404  the tenant has voice off; no such conversation here, or no reply yet (one answer)
 *   429  the per-IP window
 *   502  OpenAI failed or took longer than SPEAK_TIMEOUT_MS: the browser speaks it itself
 */
export const POST = withTenantRoute(async (request, { tenant }) => {
  await requireFeature(tenant, 'voice');
  if (!allow(`voice-out|${tenant.id}|${clientIp(request)}`, Date.now(), VOICE_REQUESTS_PER_WINDOW)) {
    return NextResponse.json({ error: 'Too many spoken replies from here. The reply is on your screen.' }, { status: 429 });
  }

  const parsed = voiceSpeakSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return badRequest(firstError(parsed.error));

  const reply = await latestReply(tenant, parsed.data.conversationId);
  if (!reply) return NextResponse.json({ error: 'No such conversation' }, { status: 404 });
  const text = speakable(reply.text);
  if (text === '') return new NextResponse(null, { status: 204 });

  const audio = await speak(text, { voice: REPLY_VOICE, timeoutMs: SPEAK_TIMEOUT_MS });
  return new NextResponse(audio.body, { status: 200, headers: { 'Content-Type': audio.contentType, 'Cache-Control': 'no-store' } });
});
