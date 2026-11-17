// Audit E-7 (D-178): the chat says each finished answer to a screen reader
// ONCE, not token by token. Against pnpm dev, on villa. No OpenAI call: a
// greeting is answered in code (D-049) and still arrives as a stream.
//
//   (cd packages/db && node --conditions=react-server --env-file=../../.env ../../plan/chat-announce-walk.mjs [slug])
//
// 1. The conversation is a role="log" region that is itself silent
//    (aria-live="off"), and there is one polite, atomic status region.
// 2. After "Hello" (one piece, answered in code), the region holds "<assistant>: <the reply>",
//    and it changed at most twice (cleared, then the whole answer), never
//    once per streamed piece.
// 3. A real question (ONE small OpenAI call, ~0.1 US cent): streamed in many
//    pieces, still said once, whole.
import { openBrowser } from './ui-refresh-cdp.mjs';

const BASE = process.env.WALK_BASE ?? 'http://localhost:3000';
const SLUG = process.argv[2] ?? 'villa';
let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let browser;
try {
  browser = await openBrowser({ scheme: 'light' });
  const { page } = browser;
  await page.viewport(390);
  await page.send('Network.setExtraHTTPHeaders', { headers: { 'X-Forwarded-For': `198.26.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` } });
  await page.goto(`${BASE}/t/${SLUG}`);
  await page.until("!!document.querySelector('textarea')", 30000);
  await sleep(800);

  // 1.
  const regions = await page.eval(`({
    log: (() => { const l = document.querySelector('[role=log]'); return l ? { live: l.getAttribute('aria-live'), label: l.getAttribute('aria-label') } : null; })(),
    status: [...document.querySelectorAll('[role=status][aria-live=polite][aria-atomic=true]')].length,
  })`);
  check(regions.log?.live === 'off' && regions.log.label === 'Conversation' && regions.status >= 1,
    '1. the conversation is a silent role="log", beside one polite atomic status region', JSON.stringify(regions));

  // 2. Watch the status region while the answer streams.
  await page.eval(`(() => {
    const region = [...document.querySelectorAll('[role=status][aria-live=polite][aria-atomic=true]')].find((r) => r.classList.contains('visually-hidden'));
    window.__changes = [];
    new MutationObserver(() => window.__changes.push(region.textContent)).observe(region, { childList: true, characterData: true, subtree: true });
    return true;
  })()`);
  await page.type('textarea', 'Hello');
  await page.eval("document.querySelector('textarea').closest('form').requestSubmit(); true");
  await page.until("document.querySelectorAll('.bubble').length >= 2 && !document.querySelector('.bubble.thinking')", 30000);
  await sleep(800);
  const result = await page.eval(`(() => {
    const region = [...document.querySelectorAll('[role=status][aria-live=polite][aria-atomic=true]')].find((r) => r.classList.contains('visually-hidden'));
    return { text: region.textContent.trim(), changes: window.__changes.filter((c) => c.trim() !== '').length, all: window.__changes.length };
  })()`);
  check(/^[^:]+: \S/.test(result.text) && result.changes === 1 && result.all <= 2,
    '2. after "Hello" the region says the whole answer once ("<assistant>: …"), not piece by piece', JSON.stringify(result));

  // 3. A real answer, streamed in many pieces (one small OpenAI call): still
  //    said once, whole, after the stream ends.
  await page.eval('window.__changes = []; window.__deltas = 0; true');
  await page.send('Network.enable');
  await page.type('textarea', 'Can we hire a cook, how does the deposit work, and can we extend our stay?');
  await page.eval("document.querySelector('textarea').closest('form').requestSubmit(); true");
  // Finished = no longer busy. The textarea is never disabled; the Send
  // button is while busy (and also when the field is empty, so type a key).
  await page.until("document.querySelectorAll('.bubble').length >= 4 && !document.querySelector('.bubble.thinking')", 60000);
  await page.type('textarea', 'x');
  await page.until("!document.querySelector('.composer-send').disabled", 60000);
  await sleep(1500);
  const streamed = await page.eval(`(() => {
    const region = [...document.querySelectorAll('[role=status][aria-live=polite][aria-atomic=true]')].find((r) => r.classList.contains('visually-hidden'));
    const last = [...document.querySelectorAll('.bubble')].pop()?.textContent.replace(/\s+/g, ' ').trim() ?? '';
    return { said: region.textContent.trim().slice(0, 120), length: region.textContent.trim().length, changes: window.__changes.filter((c) => c.trim() !== '').length, replyLength: last.length };
  })()`);
  check(streamed.changes === 1 && streamed.length > 100 && streamed.said.startsWith('Lia: '),
    '3. a real streamed answer is said once, whole, after it ends', JSON.stringify(streamed));
} catch (error) {
  check(false, 'walk', error.message);
} finally {
  browser?.close();
}
console.log(failures === 0 ? '\nALL CHAT ANNOUNCE WALK CHECKS PASS' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
