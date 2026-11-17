// Audit E-3 (D-174): the booking page's room cards say the price and how
// many are left for the chosen dates, before a room is picked. Against pnpm
// dev, on a per-room tenant (alteza by default). NOTHING IS SENT.
//
//   (cd packages/db && node --conditions=react-server --env-file=../../.env ../../plan/room-cards-price-walk.mjs [slug])
//
// 1. With a slot and one night chosen, every card says its price ("₱X a
//    night"); a type of several rooms says "N of M left".
// 2. The card's price is the quote's own: pick that room, and the quote's
//    line for the night is the same amount.
// 3. Two nights: the cards say "From ₱X a night".
// Screenshots in plan/room-cards-price/.
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openBrowser } from './ui-refresh-cdp.mjs';

const BASE = process.env.WALK_BASE ?? 'http://localhost:3000';
const SLUG = process.argv[2] ?? 'alteza';
const SHOTS = join(dirname(fileURLToPath(import.meta.url)), 'room-cards-price');
mkdirSync(SHOTS, { recursive: true });
let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const setValue = (selector, value) => `(() => { const i = document.querySelector('${selector}'); const proto = i.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(i, ${JSON.stringify(String(value))}); i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`;
const CARDS = `[...document.querySelectorAll('.room-pick')].map((c) => ({ name: c.querySelector('.room-pick-name')?.textContent.trim(), price: c.querySelector('.room-pick-price')?.textContent.replace(/\\s+/g, ' ').trim() ?? null, left: [...c.querySelectorAll('.room-pick-meta')].map((m) => m.textContent.trim()).find((t) => /left|Taken/.test(t)) ?? null }))`;

let browser;
const sent = [];
try {
  browser = await openBrowser({ scheme: 'light' });
  const { page } = browser;
  page.on('Network.requestWillBeSent', ({ request }) => { if (request.url.includes('/book/request')) sent.push(request.url); });
  await page.viewport(390);
  await page.goto(`${BASE}/t/${SLUG}/book`);
  await page.until("!!document.querySelector('input[type=date]')", 30000);
  await sleep(1200);

  // The nightly slot, a date a week ahead, one night; then the Rooms step.
  const nightly = await page.eval("[...document.querySelectorAll('select option')].find((o) => /overnight/i.test(o.textContent))?.value ?? null");
  if (nightly) await page.eval(setValue('select', nightly));
  const day = await page.eval("(() => { const i = document.querySelector('input[type=date]'); const d = new Date(i.min + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + 7); return d.toISOString().slice(0, 10); })()");
  await page.eval(setValue('input[type=date]', day));
  await page.eval("[...document.querySelectorAll('button')].find(b => b.textContent.trim().startsWith('Continue') && b.offsetParent !== null).click(); true");
  await page.until("document.querySelectorAll('.room-pick-price').length > 0", 20000);
  await sleep(500);

  // 1.
  const cards = await page.eval(CARDS);
  const several = cards.find((c) => c.left && / of /.test(c.left));
  check(cards.length > 0 && cards.every((c) => /^₱[\d,]+\.\d{2} a night$/.test(c.price ?? '')) && !!several,
    '1. one night: every card says "₱X a night"; a type of several rooms says "N of M left"',
    cards.map((c) => `${c.name}: ${c.price} ${c.left ?? ''}`).join(' | '));
  await page.shot(join(SHOTS, '1-rooms-one-night-390.png'));

  // 2. Pick the first card with 2 guests; its quote line must carry the card's amount.
  const first = cards[0];
  await page.eval("document.querySelector('.room-pick input[type=checkbox]').click(); true");
  await sleep(400);
  await page.eval(`(() => { const i = document.querySelector('.room-pick.picked input[type=number][id^=guests]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, '2'); i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  await page.until("!!document.querySelector('.book-summary .quote') && !document.querySelector('.quote-skeleton')", 20000);
  await sleep(500);
  const quoteText = await page.eval("document.querySelector('.book-summary .quote').textContent.replace(/\\s+/g, ' ')");
  const cardAmount = first.price.match(/₱[\d,]+\.\d{2}/)[0];
  check(quoteText.includes(cardAmount), "2. the card's price is the quote's own: the picked room's line carries the same amount",
    `card ${first.name} ${cardAmount} · quote "${quoteText.slice(0, 140)}"`);

  // 3. Two nights: back to step 1.
  await page.eval("[...document.querySelectorAll('.stepper button')][0].click(); true");
  await sleep(500);
  await page.eval(setValue('input[type=number]', 2));
  await sleep(400);
  await page.eval("[...document.querySelectorAll('button')].find(b => b.textContent.trim().startsWith('Continue') && b.offsetParent !== null).click(); true");
  await page.until("[...document.querySelectorAll('.room-pick-price')].some((p) => p.textContent.startsWith('From'))", 20000);
  const two = await page.eval(CARDS);
  check(two.every((c) => /^From ₱[\d,]+\.\d{2} a night$/.test(c.price ?? '')), '3. two nights: every card says "From ₱X a night"',
    two.map((c) => `${c.name}: ${c.price}`).join(' | '));
  await page.shot(join(SHOTS, '2-rooms-two-nights-390.png'));
  check(sent.length === 0, 'nothing was sent', `${sent.length} request(s)`);
} catch (error) {
  check(false, 'walk', error.message);
} finally {
  browser?.close();
}
console.log(failures === 0 ? '\nALL ROOM CARDS PRICE WALK CHECKS PASS' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
