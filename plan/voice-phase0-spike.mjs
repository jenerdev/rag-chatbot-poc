// voice-phase0-spike.mjs — plan/voice.md Phase 0: what OpenAI's speech
// endpoints cost us in seconds, and how they handle English, Tagalog and
// Taglish, before any of it is built. No UI, no route, no package code: two
// raw fetches, the way @rag/openai will make them (D-001).
//
//   1. speak three replies (an English price, a Taglish answer, a refusal):
//      the wait to the first byte, the whole call, the audio's length;
//   2. speak three QUESTIONS and transcribe them back: the transcript beside
//      what was said. Synthetic speech is cleaner than a guest's, so this
//      measures the plumbing and the languages, not the accuracy on a phone.
//
// The audio is saved in plan/voice/phase0/ for the user to listen to.
//
//   node --env-file=.env plan/voice-phase0-spike.mjs [tts-model] [transcribe-model] [voice]

import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const TTS_MODEL = process.argv[2] ?? 'gpt-4o-mini-tts';
const STT_MODEL = process.argv[3] ?? 'gpt-4o-mini-transcribe';
const VOICE = process.argv[4] ?? 'alloy';
const OUT = join(dirname(fileURLToPath(import.meta.url)), 'voice', 'phase0');
mkdirSync(OUT, { recursive: true });
const auth = { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` };

/** A WAV's length in seconds, from its own header (any sample rate). */
function wavSeconds(buf) {
  const rate = buf.readUInt32LE(24);
  const block = buf.readUInt16LE(32);
  return (buf.length - 44) / (rate * block);
}

// The first run (2026-10-20) waited 76 to 135 s for the first byte of every
// reply; a probe minutes later took 1 s, and a pcm request hung 60 s. The
// service stalls now and then, so every call here gives up after 30 s, as
// the route will (and the screen keeps the text).
const TIMEOUT_MS = 30_000;

async function speak(name, text) {
  try {
    return await speakOnce(name, text);
  } catch (error) {
    if (error.name !== 'TimeoutError') throw error;
    console.log(`   ${name}: TIMED OUT after ${TIMEOUT_MS / 1000} s`);
    return null;
  }
}

async function speakOnce(name, text) {
  const start = performance.now();
  const res = await fetch('https://api.openai.com/v1/audio/speech', {
    signal: AbortSignal.timeout(TIMEOUT_MS),
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: TTS_MODEL, voice: VOICE, input: text, response_format: 'wav' }),
  });
  if (!res.ok) throw new Error(`speak ${name}: ${res.status} ${await res.text()}`);
  const reader = res.body.getReader();
  const parts = [];
  let first = null;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (first === null) first = performance.now() - start;
    parts.push(value);
  }
  const total = performance.now() - start;
  const buf = Buffer.concat(parts);
  writeFileSync(join(OUT, `${name}.wav`), buf);
  return { buf, first: Math.round(first), total: Math.round(total), seconds: +wavSeconds(buf).toFixed(1), chars: text.length };
}

async function transcribe(name, buf) {
  const form = new FormData();
  form.append('model', STT_MODEL);
  form.append('file', new Blob([buf], { type: 'audio/wav' }), `${name}.wav`);
  const start = performance.now();
  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', { method: 'POST', headers: auth, body: form });
  const body = await res.json();
  if (!res.ok) throw new Error(`transcribe ${name}: ${res.status} ${JSON.stringify(body)}`);
  return { text: body.text, ms: Math.round(performance.now() - start), usage: body.usage ?? null };
}

console.log(`tts ${TTS_MODEL} (${VOICE}) · transcribe ${STT_MODEL}\n`);

console.log('1. replies spoken');
const replies = [
  ['reply-en-price', 'On 18 October 2026, a weekend, the Overnight slot is open. It costs ₱20,000.00 for up to 20 guests.'],
  ['reply-taglish', 'Opo, may bakante pa po kami bukas para sa Overnight. Ang presyo ay ₱20,000.00, at kasama na ang pool at ang videoke.'],
  ['reply-refusal', "Sorry, I don't have that information. Please message us on Facebook and the team will help you."],
];
for (const [name, text] of replies) {
  const r = await speak(name, text);
  if (r) console.log(`   ${name}: first byte ${r.first} ms · whole ${r.total} ms · ${r.seconds} s of audio · ${r.chars} chars`);
}

console.log('\n2. questions spoken, then transcribed back');
const questions = [
  ['ask-en', 'Do you have parking for two cars?'],
  ['ask-tagalog', 'May paradahan po ba kayo para sa dalawang sasakyan?'],
  ['ask-taglish', 'May bakante ba kayo bukas for two guests?'],
];
for (const [name, text] of questions) {
  const s = await speak(name, text);
  if (!s) continue;
  const t = await transcribe(name, s.buf);
  console.log(`   ${name}: said   "${text}"`);
  console.log(`   ${' '.repeat(name.length)}  heard  "${t.text}"  (${t.ms} ms for ${s.seconds} s${t.usage ? ` · usage ${JSON.stringify(t.usage)}` : ''})`);
}
console.log(`\naudio in ${OUT}`);
