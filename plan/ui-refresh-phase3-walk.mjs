// ui-refresh-phase3-walk.mjs — the chat screen in a real browser, against a
// running dev server (plan/ui-refresh.md Phase 3). Checks the behaviour the
// phase promised and screenshots each state at 375 and 1280 px, light and
// dark, into plan/ui-refresh/phase3/walk/.
//
// The chat route is answered INSIDE the browser (Fetch.fulfillRequest) with a
// hand-written event stream in the server's own format (meta, delta, done,
// error), so the walk tests the screen, not the model: no API call, no cost,
// the same reply every run. A reply can be HELD until the walk releases it,
// which is how "scrolled up while an answer arrives" is reproduced. One real
// question at the end (--real) checks the real stream still draws.
//
//   node plan/ui-refresh-phase3-walk.mjs [base-url] [--real]

import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openBrowser } from './ui-refresh-cdp.mjs';

const BASE = process.argv.find((a) => a.startsWith('http')) ?? 'http://localhost:3000';
const REAL = process.argv.includes('--real');
const OUT = join(dirname(fileURLToPath(import.meta.url)), 'ui-refresh', 'phase3', 'walk');
let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failures++;
};

const sse = (events) => events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join('');
const LONG = Array.from({ length: 14 }, (_, i) => `Line ${i + 1}: check-in is from 2 PM, and the front desk is open until 10 PM every day.`).join('\n');
const answer = (text) => sse([
  ['meta', { conversationId: '00000000-0000-4000-8000-000000000001', sources: [], searchQuery: 'walk', toolCalls: [] }],
  ['delta', { text }],
  ['done', {}],
]);

for (const scheme of ['light', 'dark']) {
  const browser = await openBrowser({ scheme });
  const { page } = browser;
  const loud = scheme === 'light';
  const dir = scheme === 'dark' ? `${OUT}-dark` : OUT;
  // What the next chat request gets; `hold` keeps it until released.
  let next = { status: 200, body: answer('Check-in is from 2 PM. 🙂') };
  let held = null;
  await page.send('Fetch.enable', { patterns: [{ urlPattern: '*/api/t/*/chat' }] });
  page.on('Fetch.requestPaused', (p) => {
    const reply = next;
    const fulfil = () =>
      page.send('Fetch.fulfillRequest', {
        requestId: p.requestId,
        responseCode: reply.status,
        responseHeaders: [{ name: 'Content-Type', value: reply.status === 200 ? 'text/event-stream' : 'application/json' }],
        body: Buffer.from(reply.body).toString('base64'),
      });
    if (reply.hold) held = fulfil;
    else void fulfil();
  });
  const ask = async (text) => {
    await page.type('#input', text);
    await page.key('Enter', 'Enter', 13);
  };

  try {
    for (const width of [375, 1280]) {
      await page.viewport(width);
      const shot = (name) => page.shot(join(dir, `${name}-${width}.png`));
      const first = loud && width === 1280;
      // Each width starts from the plain answer: a reply set by the last
      // width's final step must not answer this width's first question.
      next = { status: 200, body: answer('Check-in is from 2 PM. 🙂') };

      // 1. The welcome: the mark, the sentence, the suggestions as cards.
      await page.goto(`${BASE}/t/harbor`);
      await page.until("!!document.querySelector('.composer')", 30000);
      await shot('welcome');
      if (first) {
        check(await page.eval("!!document.querySelector('.empty-state .assistant-mark') && /Ask .+ a question about Harbor Inn/.test(document.querySelector('.empty-state h2')?.textContent)"), '1. the welcome: mark and sentence');
        check(await page.eval("getComputedStyle(document.querySelector('.suggestions')).gridTemplateColumns.split(' ').length === 2"), '1b. suggestions in two columns on a desktop');
        check(await page.eval("document.querySelector('.composer-send').disabled === true"), '1c. the send arrow is off while the field is empty');
      }

      // 2. A suggestion sends; the answer is text beside the mark, not a box.
      await page.click('.suggestions button');
      await page.until("!!document.querySelector('.turn.assistant .bubble:not(.thinking)')");
      await shot('answered');
      if (first) {
        check(await page.eval("document.querySelector('.turn.user .bubble')?.textContent?.length > 0"), "2. the suggestion became the visitor's turn");
        check(await page.eval("(() => { const b = getComputedStyle(document.querySelector('.turn.assistant .bubble')); return b.borderTopWidth === '0px' && b.backgroundColor === 'rgba(0, 0, 0, 0)'; })()"), '2b. the reply has no box');
        check(await page.eval("!!document.querySelector('.turn.assistant > .assistant-mark')"), '2c. the reply carries the mark');
      }

      // 3. Type while an answer is held: the field stays usable, sending waits.
      next = { status: 200, body: answer(LONG), hold: true };
      await ask('Tell me everything about check-in');
      await page.until("!!document.querySelector('.bubble.thinking')");
      await page.type('#input', 'and parking?');
      if (first) {
        check(await page.eval("document.querySelector('#input').disabled === false && document.querySelector('#input').value === 'and parking?'"), '3. the field takes the next question while an answer is pending');
        check(await page.eval("document.querySelector('.composer-send').disabled === true"), '3b. but the arrow is off until the answer is in');
      }
      held?.();
      held = null;
      await page.until("document.querySelectorAll('.turn.assistant .bubble:not(.thinking)').length === 2");
      await page.eval("(() => { const i = document.querySelector('#input'); const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; set.call(i, ''); i.dispatchEvent(new Event('input', { bubbles: true })); })()");

      // 4. Scrolled up while an answer arrives: the "New messages" button.
      next = { status: 200, body: answer(LONG), hold: true };
      await ask('And the rules?');
      await page.until("!!document.querySelector('.bubble.thinking')");
      await page.eval("(() => { const m = document.querySelector('#messages'); m.scrollTop = 0; m.dispatchEvent(new Event('scroll')); })()");
      held?.();
      held = null;
      const appeared = await page.until("!!document.querySelector('.jump-down')", 5000);
      await shot('new-messages');
      if (first) check(appeared && (await page.eval("document.querySelector('#messages').scrollTop === 0")), '4. scrolled up: the view stays, "New messages" appears');
      await page.click('.jump-down');
      const down = await page.until("(() => { const m = document.querySelector('#messages'); return m.scrollHeight - m.scrollTop - m.clientHeight < 2 && !document.querySelector('.jump-down'); })()", 3000);
      if (first) check(down, '4b. the button takes the view down, and goes');

      // 5. A failed request: an inline error with Retry; Retry asks once more.
      next = { status: 500, body: JSON.stringify({ error: 'The assistant is unavailable right now.' }) };
      await ask('Is breakfast included?');
      await page.until("!!document.querySelector('.turn-error')");
      await page.eval("document.querySelector('#messages').scrollTop = 1e6");
      await shot('failed');
      if (first) {
        check(await page.eval("document.querySelector('.turn-error')?.getAttribute('role') === 'alert' && document.querySelector('.turn-error').textContent.includes('unavailable')"), '5. the failure is inline, announced', await page.eval("document.querySelector('.turn-error')?.textContent"));
        const before = await page.eval("document.querySelectorAll('.turn.user').length");
        next = { status: 200, body: answer('Yes, breakfast is included.') };
        await page.click('.turn-error button');
        await page.until("[...document.querySelectorAll('.turn.assistant .bubble')].some(b => b.textContent.includes('breakfast is included'))");
        check((await page.eval("document.querySelectorAll('.turn.user').length")) === before && !(await page.eval("!!document.querySelector('.turn-error')")), '5b. Retry: the question once, the answer in place of the error');
      }

      // 6. A stream that breaks mid-answer keeps the words and says so.
      next = { status: 200, body: sse([['meta', { conversationId: '00000000-0000-4000-8000-000000000001', sources: [], searchQuery: 'x' }], ['delta', { text: 'The pool opens at' }], ['error', { error: 'The answer was cut off.' }]]) };
      await ask('When does the pool open?');
      await page.until("[...document.querySelectorAll('.turn-error')].some(e => e.textContent.includes('cut off'))");
      if (first) check(await page.eval("[...document.querySelectorAll('.turn.assistant .bubble')].some(b => b.textContent === 'The pool opens at')"), '6. a broken stream keeps its words, the error under them');

      // 7. New chat: back to the welcome, the field focused.
      await page.click('header nav button.ghost');
      if (first) check(await page.until("!!document.querySelector('.empty-state') && document.activeElement?.id === 'input'"), '7. New chat: the welcome again, the field focused');

      // 8. Six lines, then the field scrolls; the phone has no hint line.
      await page.type('#input', 'a\nb\nc\nd\ne\nf\ng\nh\ni\nj');
      const grown = await page.eval("(() => { const i = document.querySelector('#input'); return { h: i.clientHeight, sh: i.scrollHeight }; })()");
      if (first) check(grown.sh > grown.h && grown.h > 100 && grown.h < 200, '8. the field grows to six lines, then scrolls', `${grown.h}px shown of ${grown.sh}px`);
      if (loud && width === 375) check(await page.eval("getComputedStyle(document.querySelector('.composer-hint')).display === 'none'"), '8b. phone: no hint line');
      await shot('multiline');
      await page.eval("(() => { const i = document.querySelector('#input'); const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; set.call(i, ''); i.dispatchEvent(new Event('input', { bubbles: true })); })()");
    }

    // 9. One real question, on the real stream (no interception).
    if (REAL && loud) {
      await page.send('Fetch.disable');
      await page.viewport(1280);
      await page.goto(`${BASE}/t/northwind`);
      await page.until("!!document.querySelector('.composer')", 30000);
      await ask('What is the returns policy?');
      const real = await page.until("(() => { const b = document.querySelector('.turn.assistant .bubble:not(.thinking)'); return b && b.textContent.length > 20 && !document.querySelector('.bubble.thinking') && document.querySelector('.composer-send') && document.querySelector('#input').value === ''; })()", 60000);
      await new Promise((r) => setTimeout(r, 1500));
      await page.shot(join(dir, 'real-northwind-1280.png'));
      check(real, '9. a real question on the real stream draws an answer', (await page.eval("document.querySelector('.turn.assistant .bubble')?.textContent ?? ''")).slice(0, 80));
    }
  } finally {
    browser.close();
  }
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
