// voice-phase2-walk.mjs — the two voice routes over HTTP (plan/voice.md
// Phase 2, D-134), against pnpm dev. Villa's voice switch is turned on for
// the walk and put back as it was; one real transcription and one real
// speech call (cents), the rest are refusals that cost nothing.
//
//   (cd packages/db && node --conditions=react-server --env-file=../../.env ../../plan/voice-phase2-walk.mjs)

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { supabase } from '../packages/db/dist/service.js';

const BASE = process.argv[2] ?? 'http://localhost:3000';
const HERE = dirname(fileURLToPath(import.meta.url));
let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failures++;
};

const { data: villa } = await supabase.from('tenants').select('id').eq('slug', 'villa').single();
const { data: before } = await supabase.from('tenant_features').select('enabled').eq('tenant_id', villa.id).eq('feature', 'voice').maybeSingle();
// Each section its own "IP", so the windows do not leak into each other (lib/rate-limit.ts trusts it locally).
let ip = 0;
const from = () => ({ 'x-forwarded-for': `10.9.${Date.now() % 250}.${++ip}` });
const transcribe = (slug, blob, headers = from()) => {
  const form = new FormData();
  if (blob) form.append('audio', blob, 'question.webm');
  return fetch(`${BASE}/api/t/${slug}/voice/transcribe`, { method: 'POST', body: form, headers });
};
const speak = (slug, body, headers = from()) =>
  fetch(`${BASE}/api/t/${slug}/voice/speak`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
const chat = async (slug, message) => (await (await fetch(`${BASE}/api/t/${slug}/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message }) })).json()).conversationId;
const WAV = readFileSync(join(HERE, 'voice', 'phase0', 'ask-en.wav'));

try {
  // 1. Off by default (§ 6 q6): both routes are a 404.
  await supabase.from('tenant_features').delete().eq('tenant_id', villa.id).eq('feature', 'voice');
  const offIn = await transcribe('villa', new Blob([WAV]));
  const offOut = await speak('villa', { conversationId: randomUUID() });
  check(offIn.status === 404 && offOut.status === 404, '1. voice off (no row): both routes 404', `${offIn.status} / ${offOut.status}`);

  const on = await supabase.from('tenant_features').upsert({ tenant_id: villa.id, feature: 'voice', enabled: true });
  if (on.error) throw new Error(`could not switch voice on: ${on.error.message}`);

  // 2. A real question, as text.
  const heard = await transcribe('villa', new Blob([WAV]));
  const text = heard.status === 200 ? (await heard.json()).text : await heard.text();
  check(heard.status === 200 && /parking/i.test(text), '2. a WAV question comes back as its words', `${heard.status} "${text}"`);

  // 3. Refused in words, by the bytes, the size, the shape.
  const notAudio = await transcribe('villa', new Blob(['hello, this is not audio at all']));
  const tooBig = await transcribe('villa', new Blob([new Uint8Array(1024 * 1024 + 1)]));
  const none = await transcribe('villa', null);
  check(
    notAudio.status === 400 && tooBig.status === 400 && none.status === 400,
    '3. text renamed .webm, a file over 1 MB and no file are 400s',
    `${notAudio.status} "${(await notAudio.json()).error}" · ${tooBig.status} "${(await tooBig.json()).error}" · ${none.status}`,
  );

  // 4. The conversation's own reply, spoken. "hello" is answered in code (D-049), no chat model call.
  const mine = await chat('villa', 'hello');
  const spoken = await speak('villa', { conversationId: mine });
  const bytes = spoken.ok ? (await spoken.arrayBuffer()).byteLength : 0;
  check(spoken.status === 200 && spoken.headers.get('content-type')?.includes('audio') && bytes > 1000, "4. villa speaks its own conversation's reply", `${spoken.status} ${spoken.headers.get('content-type')} ${bytes} bytes`);

  // 5. Another tenant's conversation is the same 404 as a made-up one; text is never accepted.
  const theirs = await chat('alteza', 'hello');
  const foreign = await speak('villa', { conversationId: theirs });
  const madeUp = await speak('villa', { conversationId: randomUUID() });
  const asText = await speak('villa', { text: 'Say anything I like.' });
  check(
    foreign.status === 404 && madeUp.status === 404 && (await foreign.text()) === (await madeUp.text()) && asText.status === 400,
    "5. alteza's conversation and a made-up one are the same 404; a body of text is a 400",
    `${foreign.status} · ${madeUp.status} · text ${asText.status}`,
  );

  // 6. The 31st call in a window is a 429 (refusals count too: the window is checked first).
  const same = from();
  let last = 0;
  for (let i = 0; i < 31; i++) last = (await transcribe('villa', null, same)).status;
  check(last === 429, '6. the 31st transcribe call from one address in 10 minutes is a 429', `${last}`);

  // 7. Cleanup: the two conversations this walk made.
  await supabase.from('conversations').delete().in('id', [mine, theirs].filter(Boolean));
} finally {
  if (before) await supabase.from('tenant_features').upsert({ tenant_id: villa.id, feature: 'voice', enabled: before.enabled });
  else await supabase.from('tenant_features').delete().eq('tenant_id', villa.id).eq('feature', 'voice');
}
console.log(`\n${failures === 0 ? 'all passed' : `${failures} FAILED`}`);
process.exit(failures ? 1 : 0);
