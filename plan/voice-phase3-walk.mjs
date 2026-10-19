// voice-phase3-walk.mjs — the chat's voice in a browser (plan/voice.md
// Phase 3, D-134), against pnpm dev, on villa with its voice switch on for the
// walk (put back after). Chrome's fake microphone plays a Phase 0 recording,
// so the whole loop is real: recorded, transcribed, answered, spoken. The
// reply's audio and the browser's own voice are SPIED, not heard: `play()`
// and `speechSynthesis.speak()` record what they were given.
//
//   1. the mic is drawn, named, and off without the switch;
//   2. press, speak, press: the words are the question, the answer is read
//      aloud by the server's voice, Stop silences it;
//   3. Escape while recording throws the recording away;
//   4. the speak route made to fail (503): the device's LOCAL voice reads
//      speakable() of the reply; with only online voices, silence;
//   5. the transcribe route made to fail: the sentence, the field focused;
//   6. New chat stops a reply being read;
//   7. axe over idle, listening and speaking, light and dark, 1280 and 375.
//
//   (cd packages/db && node --conditions=react-server --env-file=../../.env ../../plan/voice-phase3-walk.mjs)

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { supabase } from '../packages/db/dist/service.js';
import { openBrowser } from './ui-refresh-cdp.mjs';

const BASE = process.argv[2] ?? 'http://localhost:3000';
const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, 'voice', 'walk');
const WAV = join(HERE, 'voice', 'phase0', 'ask-en.wav');
const AXE = readFileSync(join(HERE, 'ui-refresh', 'axe', 'axe.min.js'), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failures++;
};

// Spies, installed before the page's own scripts. `voices` decides what the
// device "has": a local English voice, or only an online one.
const SPIES = (voices) => `
  window.__played = [];
  const play = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function () { window.__played.push(this.src); return Promise.resolve(); };
  window.__spoken = [];
  window.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; } };
  const fake = ${JSON.stringify(voices)};
  // configurable: every open() adds this script again, and the last one added wins.
  Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: {
    getVoices: () => fake,
    speak: (u) => { window.__spoken.push({ text: u.text, voice: u.voice && u.voice.name, local: u.voice && u.voice.localService }); },
    cancel: () => { window.__cancelled = (window.__cancelled || 0) + 1; },
  } });
`;
const LOCAL = [{ name: 'Local English', lang: 'en-US', localService: true }, { name: 'Google US English', lang: 'en-US', localService: false }];
const ONLINE_ONLY = [{ name: 'Google US English', lang: 'en-US', localService: false }];

const axe = async (page) => {
  await page.eval(AXE);
  return JSON.parse(await page.eval(`axe.run(document, { runOnly: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'] }).then(r => JSON.stringify(r.violations.map(v => v.id + ' (' + v.nodes.length + ') ' + (v.nodes[0]?.target?.join(' ') ?? ''))))`));
};

const { data: villa } = await supabase.from('tenants').select('id').eq('slug', 'villa').single();
const { data: before } = await supabase.from('tenant_features').select('enabled').eq('tenant_id', villa.id).eq('feature', 'voice').maybeSingle();
const startedAt = new Date().toISOString();
let browser;
const mic = `document.querySelector('.composer-mic')`;
const status = `(document.querySelector('.voice-status')?.textContent ?? '')`;

// One spy script at a time: added scripts pile up, and the FIRST one's
// speechSynthesis won (a "local voice" spy answered the online-only step).
let spyScript = null;
async function open(page, voices, width = 1280) {
  await page.viewport(width);
  if (spyScript) await page.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: spyScript });
  spyScript = (await page.send('Page.addScriptToEvaluateOnNewDocument', { source: SPIES(voices) })).result?.identifier ?? null;
  await page.goto(`${BASE}/t/villa`);
  await page.until(`!!${mic}`, 30000).catch(() => null);
}

try {
  // 1. Off: no mic.
  await supabase.from('tenant_features').delete().eq('tenant_id', villa.id).eq('feature', 'voice');
  browser = await openBrowser({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${WAV}`] });
  let page = browser.page;
  await page.goto(`${BASE}/t/villa`);
  await sleep(2500);
  check(!(await page.eval(`!!${mic}`)), '1. voice off: no microphone in the composer');
  await supabase.from('tenant_features').upsert({ tenant_id: villa.id, feature: 'voice', enabled: true });

  await open(page, LOCAL);
  check(await page.eval(`${mic}?.getAttribute('aria-label') === 'Speak your question'`), '1b. voice on: the microphone is a button named "Speak your question"');
  await page.shot(join(OUT, 'idle-1280.png'));

  // 2. Press, speak, press.
  await page.click('.composer-mic');
  await page.until(`${mic}.classList.contains('listening')`, 5000).catch(() => null);
  await sleep(3500);
  await page.shot(join(OUT, 'listening-1280.png'));
  const listeningAxe = await axe(page);
  await page.click('.composer-mic');
  const asked = await page.until(`/parking/i.test(document.querySelector('.turn.user .bubble')?.textContent ?? '')`, 20000).then(() => true, () => false);
  check(asked, '2. the recording becomes the question, shown as the guest\'s bubble', await page.eval(`document.querySelector('.turn.user .bubble')?.textContent`));
  const read = await page.until(`window.__played.length > 0`, 60000).then(() => true, () => false);
  check(read && (await page.eval(status)).includes('Reading the reply aloud'), '2b. the answer is read aloud by the server\'s voice', `${await page.eval('window.__played.length')} played · "${await page.eval(status)}"`);
  await page.shot(join(OUT, 'speaking-1280.png'));
  const speakingAxe = await axe(page);
  await page.eval(`[...document.querySelectorAll('.voice-status button')].find(b => /Stop/.test(b.textContent))?.click()`);
  await sleep(300);
  check(!(await page.eval(status)).includes('Reading'), '2c. Stop ends the reading');

  // 3. Escape throws a recording away.
  const turnsBefore = await page.eval(`document.querySelectorAll('.turn.user').length`);
  await page.click('.composer-mic');
  await sleep(1500);
  await page.key('Escape', 'Escape', 27);
  await sleep(2500);
  check(
    (await page.eval(`document.querySelectorAll('.turn.user').length`)) === turnsBefore && !(await page.eval(`${mic}.classList.contains('listening')`)),
    '3. Escape while recording: nothing is sent, the mic is idle again',
  );

  // 4. The fallback: the speak route answers 503.
  await page.send('Fetch.enable', { patterns: [{ urlPattern: '*/voice/speak' }] });
  // One handler for the walk: whatever route Fetch.enable names next (speak here, transcribe in 5) answers 503.
  page.on('Fetch.requestPaused', (p) => void page.send('Fetch.fulfillRequest', { requestId: p.requestId, responseCode: 503, body: Buffer.from('{"error":"down"}').toString('base64') }));
  await open(page, LOCAL);
  await page.eval(`document.querySelector('.read-aloud').click()`);
  await page.type('#input', 'hello');
  await page.eval(`document.querySelector('.composer-inner').requestSubmit()`);
  const fellBack = await page.until(`window.__spoken.length > 0`, 30000).then(() => true, () => false);
  const said = await page.eval(`window.__spoken[0]`);
  check(fellBack && said?.local === true && said.voice === 'Local English' && !/[👋😊]/u.test(said.text), '4. speak fails: the device\'s LOCAL voice reads the reply, made speakable', JSON.stringify(said));
  await open(page, ONLINE_ONLY);
  await page.type('#input', 'hello');
  await page.eval(`document.querySelector('.composer-inner').requestSubmit()`);
  await sleep(6000);
  check((await page.eval(`window.__spoken.length`)) === 0, '4b. with only online voices, the fallback stays silent', await page.eval(`JSON.stringify({ spoken: window.__spoken, voices: speechSynthesis.getVoices() })`));
  await page.send('Fetch.disable');

  // 5. Transcription fails: the sentence, and the field ready to type.
  await page.send('Fetch.enable', { patterns: [{ urlPattern: '*/voice/transcribe' }] });
  await open(page, LOCAL);
  await page.click('.composer-mic');
  await sleep(1500);
  await page.click('.composer-mic');
  await page.until(`${status}.includes("couldn't hear")`, 15000).catch(() => null);
  check((await page.eval(status)).includes("couldn't hear") && (await page.eval(`document.activeElement?.id`)) === 'input', '5. transcription fails: "I couldn\'t hear that…", the field focused', await page.eval(status));
  await page.send('Fetch.disable');

  // 6. New chat stops a reply being read (the read-aloud toggle is remembered: on).
  await open(page, LOCAL);
  await page.type('#input', 'hello');
  await page.eval(`document.querySelector('.composer-inner').requestSubmit()`);
  await page.until(`window.__played.length > 0`, 30000).catch(() => null);
  const cancelled = await page.eval('window.__cancelled || 0');
  await page.click('.chat-new');
  await sleep(300);
  check((await page.eval('window.__cancelled || 0')) > cancelled && !(await page.eval(status)).includes('Reading'), '6. New chat silences the reply');

  // 7. axe: listening and speaking (above) and idle, light and dark, 1280 and 375.
  const states = [['listening 1280 light', listeningAxe], ['speaking 1280 light', speakingAxe]];
  browser.close();
  for (const scheme of ['light', 'dark']) {
    browser = await openBrowser({ scheme, args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
    page = browser.page;
    spyScript = null;
    for (const width of [1280, 375]) {
      await open(page, LOCAL, width);
      states.push([`idle ${width} ${scheme}`, await axe(page)]);
      if (width === 375 && scheme === 'light') await page.shot(join(OUT, 'idle-375.png'));
    }
    browser.close();
  }
  browser = null;
  const dirty = states.filter(([, v]) => v.length > 0);
  check(dirty.length === 0, `7. axe: ${states.length} voice states, no violation`, dirty.map(([s, v]) => `${s}: ${v.join('; ')}`).join(' | '));
} finally {
  browser?.close();
  if (before) await supabase.from('tenant_features').upsert({ tenant_id: villa.id, feature: 'voice', enabled: before.enabled });
  else await supabase.from('tenant_features').delete().eq('tenant_id', villa.id).eq('feature', 'voice');
  // The walk's own chats: villa's, since it started, whose first question is the walk's.
  // (Not an embed: conversations and messages are joined twice, and PostgREST refuses to guess.)
  const { data: asked } = await supabase.from('messages').select('conversation_id, content').eq('tenant_id', villa.id).eq('role', 'user').gte('created_at', startedAt);
  const ours = [...new Set((asked ?? []).filter((m) => /^(hello|do you have parking)/i.test(m.content)).map((m) => m.conversation_id))];
  if (ours.length) await supabase.from('conversations').delete().in('id', ours);
  console.log(`cleanup: ${ours.length} walk conversation(s) removed`);
}
console.log(`\n${failures === 0 ? 'all passed' : `${failures} FAILED`}`);
process.exit(failures ? 1 : 0);
