import { NextResponse } from 'next/server';
import { transcribe } from '@rag/openai';
import { requireFeature } from '@/lib/feature-flags';
import { allow, clientIp } from '@/lib/rate-limit';
import { badRequest } from '@/lib/route';
import { withTenantRoute } from '@/lib/tenant';
import { MAX_AUDIO_BYTES, sniffAudio, VOICE_REQUESTS_PER_WINDOW } from '@/lib/voice';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * A spoken question, as text (plan/voice.md, D-134). Multipart, one file
 * named `audio`.
 *
 * Open, like chat/: no requireAdmin(). It never answers; the browser sends
 * the text to chat/ as if it had been typed, so voice is no way around the
 * chat's own limits (Rule 2). Nothing is kept: the bytes go to OpenAI in
 * memory and are dropped (Rule 4).
 *
 *   200  { text }
 *   400  no file, not audio (checked by its bytes), over MAX_AUDIO_BYTES
 *   404  the tenant has voice off
 *   422  nothing was heard
 *   429  the per-IP window (the weak limit, R-39, R-53)
 *   502  OpenAI failed or took too long: the composer says so and the guest types
 */
export const POST = withTenantRoute(async (request, { tenant }) => {
  await requireFeature(tenant, 'voice');
  if (!allow(`voice-in|${tenant.id}|${clientIp(request)}`, Date.now(), VOICE_REQUESTS_PER_WINDOW)) {
    return NextResponse.json({ error: 'Too many voice questions from here. Please type, or try again in a few minutes.' }, { status: 429 });
  }

  const form = await request.formData().catch(() => null);
  const file = form?.get('audio');
  if (!(file instanceof File)) return badRequest('Send the recording as a file named audio.');
  // The size first, from the part's own header, before the bytes are read.
  if (file.size > MAX_AUDIO_BYTES) return badRequest(`That recording is too long. Keep a question under ${MAX_AUDIO_BYTES / 1024 / 1024} MB.`);
  const bytes = new Uint8Array(await file.arrayBuffer());
  const mime = sniffAudio(bytes);
  if (!mime) return badRequest('That is not a recording.');

  const text = await transcribe(bytes, mime);
  if (text === '') return NextResponse.json({ error: "I couldn't hear that. Please try again or type your question." }, { status: 422 });
  return NextResponse.json({ text });
});
