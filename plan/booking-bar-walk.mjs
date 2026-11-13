// Audit E-1/E-2 (D-173): the booking page's bar on a phone. Against pnpm dev.
//
//   (cd packages/db && node --conditions=react-server --env-file=../../.env ../../plan/booking-bar-walk.mjs [slug])
//
// At 390 px on villa (or the slug given). NOTHING IS SENT: the walk stops at
// the consent box, so no booking is made. Screenshots in plan/booking-bar/.
// 1. Step 1 before a date: no bar (it would say nothing and cover Continue).
// 2. Once there is a price (the Guests step): the bar is pinned to the
//    bottom with the total and "See price".
// 3. "See price" brings the summary card into view, and the bar steps aside.
// 4. Back at the top, the bar is back.
// 5. The Review step: the bar shows the total and "Send request".
// 6. The bar's Send with the consent box unticked sends nothing: the box is
//    focused, the gap is said, and the bar is out of the way.
// 7. At 1280 px there is no bar (the summary sits beside the form).
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openBrowser } from './ui-refresh-cdp.mjs';

const BASE = process.env.WALK_BASE ?? 'http://localhost:3000';
const SLUG = process.argv[2] ?? 'villa';
const SHOTS = join(dirname(fileURLToPath(import.meta.url)), 'booking-bar');
mkdirSync(SHOTS, { recursive: true });
let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BAR = `(() => { const b = document.querySelector('.book-bar'); if (!b) return null; const r = b.getBoundingClientRect(); const s = getComputedStyle(b);
  return { display: s.display, position: s.position, bottomGap: Math.round(innerHeight - r.bottom), text: b.textContent.replace(/\\s+/g, ' ').trim(), button: b.querySelector('button')?.textContent.trim() }; })()`;

let browser;
const requests = [];
try {
  browser = await openBrowser({ scheme: 'light' });
  const { page } = browser;
  page.on('Network.requestWillBeSent', ({ request }) => { if (request.url.includes('/book/request')) requests.push(request.url); });
  await page.viewport(390);
  await page.goto(`${BASE}/t/${SLUG}/book`);
  await page.until("!!document.querySelector('input[type=date]')", 30000);
  await sleep(1500);

  const next = async () => {
    await page.until("[...document.querySelectorAll('button')].some(b => b.textContent.trim().startsWith('Continue') && b.offsetParent !== null)", 15000);
    await page.eval("[...document.querySelectorAll('button')].find(b => b.textContent.trim().startsWith('Continue') && b.offsetParent !== null).click(); true");
    await sleep(700);
  };

  // 1.
  const none = await page.eval(BAR);
  check(none === null, '1. step 1 before a date: no bar', JSON.stringify(none));
  await page.shot(join(SHOTS, '1-step1-390.png'));

  // 2. A date, then the Guests step, where the price appears.
  await page.eval(`(() => { const i = document.querySelector('input[type=date]'); const d = new Date(i.min + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + 10); const day = i.max && d.toISOString().slice(0, 10) > i.max ? i.max : d.toISOString().slice(0, 10); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, day); i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  await next();
  await page.eval(`(() => { const i = [...document.querySelectorAll('input[type=number]')].find(x => x.offsetParent !== null); if (i && !i.value) { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, '2'); i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new Event('change', { bubbles: true })); } return true; })()`);
  // A small phone (390 x 560): the summary card starts below the fold, which
  // is when the bar is needed (at 812 tall villa's short Guests step already
  // shows the card, and the bar rightly stays out of the way).
  await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 560, deviceScaleFactor: 1, mobile: true });
  await page.eval('window.scrollTo(0, 0); true');
  await page.until("!!document.querySelector('.book-bar') && /₱/.test(document.querySelector('.book-bar').textContent)", 20000);
  await sleep(700);
  const priced = await page.eval(BAR);
  check(priced?.display === 'flex' && priced.position === 'fixed' && priced.bottomGap === 0 && /^Total ₱[\d,]+\.\d{2}/.test(priced.text) && priced.button === 'See price',
    '2. with a price: the bar is pinned to the bottom with the total and "See price"', JSON.stringify(priced));
  await page.shot(join(SHOTS, '2-guests-390.png'));

  // 3.
  await page.click('.book-bar button');
  await sleep(1200);
  const afterSee = await page.eval(BAR);
  // In the window, not at its top: on a short step the page cannot scroll the card higher.
  const cardTop = await page.eval("Math.round(document.querySelector('.book-summary').getBoundingClientRect().top)");
  const windowHeight = await page.eval('innerHeight');
  check(afterSee === null && cardTop >= 0 && cardTop < windowHeight, '3. "See price" brings the summary into view, and the bar steps aside', `bar ${JSON.stringify(afterSee)} · card top ${cardTop} of ${windowHeight}`);

  // 4.
  await page.eval('window.scrollTo(0, 0); true');
  await sleep(800);
  const back = await page.eval(BAR);
  check(back?.display === 'flex', '4. back at the top, the bar is back', JSON.stringify(back));

  // 5. On to the Review step, back at 390 x 812.
  await page.viewport(390);
  await next();
  await page.until("!!document.querySelector('#name') && document.querySelector('#name').offsetParent !== null", 15000);
  await page.type('#name', 'Bar Walker');
  await page.type('#phone', '0917 555 0173');
  await page.type('#email', 'bar-walker@example.com');
  await next();
  await page.until("!!document.querySelector('#step-review') && !!document.querySelector('.quote') && !document.querySelector('.quote-skeleton')", 20000);
  await page.eval('window.scrollTo(0, 0); true');
  await sleep(900);
  const review = await page.eval(BAR);
  check(review?.display === 'flex' && /^Total ₱[\d,]+\.\d{2}/.test(review.text) && review.button === 'Send request',
    '5. the Review step: the bar shows the total and "Send request"', JSON.stringify(review));
  await page.shot(join(SHOTS, '3-review-390.png'));

  // 6.
  await page.click('.book-bar button');
  await sleep(1200);
  const gap = await page.eval("({ focused: document.activeElement?.id ?? null, ticked: document.querySelector('#book-consent').checked, said: [...document.querySelectorAll('[role=alert]')].map(a => a.textContent.trim()).filter(Boolean).join(' | '), bar: !!document.querySelector('.book-bar') })");
  check(gap.focused === 'book-consent' && !gap.ticked && /Tick the box/.test(gap.said) && gap.bar === false && requests.length === 0,
    '6. the bar\'s Send with the box unticked sends nothing: the box is focused and the gap said', `${JSON.stringify(gap)} · requests ${requests.length}`);
  await page.shot(join(SHOTS, '4-consent-gap-390.png'));

  // 7.
  await page.viewport(1280);
  await sleep(800);
  const wide = await page.eval(BAR);
  check(wide === null || wide.display === 'none', '7. at 1280 px there is no bar', JSON.stringify(wide));
  await page.shot(join(SHOTS, '5-review-1280.png'));
} catch (error) {
  check(false, 'walk', error.message);
} finally {
  browser?.close();
}
console.log(failures === 0 ? '\nALL BOOKING BAR WALK CHECKS PASS' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
