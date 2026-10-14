// ui-refresh-phase5-walk.mjs — the customer booking page in a real browser,
// against a running dev server (plan/ui-refresh.md Phase 5). Screenshots into
// plan/ui-refresh/phase5/walk/, light and dark, 375 and 1280 px.
//
// The QUOTE is the real route (it only reads). The REQUEST is answered
// inside the browser (Fetch.fulfillRequest) with a receipt built from the
// real quote's lines, so no booking is written: request_booking() would
// store a real pending stay.
//
//   node plan/ui-refresh-phase5-walk.mjs [base-url]

import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openBrowser } from './ui-refresh-cdp.mjs';

const BASE = process.argv[2] ?? 'http://localhost:3000';
const OUT = join(dirname(fileURLToPath(import.meta.url)), 'ui-refresh', 'phase5', 'walk');
let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failures++;
};

// React listens for `input`; setting .value alone is invisible to it.
const setValue = (selector, value) =>
  `(() => { const el = document.querySelector(${JSON.stringify(selector)}); const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true })); })()`;
const addDays = (n) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const priced = "(() => { const s = document.querySelector('.book-summary'); return !s.querySelector('.quote-skeleton') && !!s.querySelector('.quote-total, .quote.error'); })()";

for (const scheme of ['light', 'dark']) {
  const browser = await openBrowser({ scheme });
  const { page } = browser;
  const loud = scheme === 'light';
  const dir = scheme === 'dark' ? `${OUT}-dark` : OUT;
  await page.send('Browser.grantPermissions', { permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'], origin: BASE }).catch(() => undefined);

  // The last real quote body, for the fake receipt.
  let lastQuote = null;
  await page.send('Fetch.enable', { patterns: [{ urlPattern: '*/book/request' }, { urlPattern: '*/book/quote', requestStage: 'Response' }] });
  page.on('Fetch.requestPaused', async (p) => {
    if (p.request.url.endsWith('/book/quote')) {
      const body = await page.send('Fetch.getResponseBody', { requestId: p.requestId });
      try {
        lastQuote = JSON.parse(body.result.base64Encoded ? Buffer.from(body.result.body, 'base64').toString() : body.result.body);
      } catch {
        lastQuote = null;
      }
      await page.send('Fetch.continueRequest', { requestId: p.requestId });
      return;
    }
    const q = lastQuote ?? { lines: [], currency: 'PHP', total: 0, discount: 0 };
    const receipt = {
      reference: 'HAR-WALK5Z',
      slot: 'Night',
      nights: 1,
      startsAt: `${q.lines[0]?.date ?? addDays(30)}T06:00:00Z`,
      endsAt: `${addDays(31)}T03:00:00Z`,
      lines: q.lines,
      currency: q.currency,
      total: q.total,
      discount: q.discount ?? 0,
      instructions: null,
    };
    await page.send('Fetch.fulfillRequest', {
      requestId: p.requestId,
      responseCode: 200,
      responseHeaders: [{ name: 'Content-Type', value: 'application/json' }],
      body: Buffer.from(JSON.stringify(receipt)).toString('base64'),
    });
  });

  try {
    for (const width of [1280, 375]) {
      await page.viewport(width);
      const shot = (name) => page.shot(join(dir, `${name}-${width}.png`));
      const first = loud && width === 1280;

      // 1. harbor (per_room): the three sections and the summary.
      await page.goto(`${BASE}/t/harbor/book`);
      await page.until("!!document.querySelector('.book-summary')", 30000);
      await shot('harbor-empty');
      if (first) {
        check(await page.eval("[...document.querySelectorAll('.book-step h2')].map(h => h.textContent).join(' | ') === '1 Your stay | 2 Rooms and guests | 3 Your details'"), '1. three numbered sections', await page.eval("[...document.querySelectorAll('.book-step h2')].map(h => h.textContent).join(' | ')"));
        check(await page.eval("(() => { const a = document.querySelector('.book-summary').getBoundingClientRect(); const f = document.querySelector('.book-steps').getBoundingClientRect(); return a.left > f.right; })()"), '1b. desktop: the summary beside the form');
        check(await page.eval("!!document.querySelector('.summary-empty') && document.querySelector('.book-send').disabled"), '1c. nothing chosen: a sentence, Send off');
        check(await page.eval("!document.querySelector('#promo-code') && !!document.querySelector('.promo-open')"), '1d. the promo field is closed until asked for');
      }
      if (loud && width === 375) {
        check(await page.eval("document.querySelector('.book-summary').getBoundingClientRect().top > document.querySelector('.book-steps').getBoundingClientRect().bottom - 1"), '1p. phone: the summary after the sections');
      }

      // 2. A date, a room, its guests: a placeholder, then the server's price.
      await page.click('.room-pick input[type=checkbox]');
      await page.until("!!document.querySelector('.room-pick.picked input[type=number]')");
      await page.eval(setValue('.room-pick.picked input[type=number]', '2'));
      let date = null;
      for (let d = 30; d < 60 && !date; d++) {
        await page.eval(setValue('#check-in', addDays(d)));
        if (first && d === 30) {
          check(await page.until("!!document.querySelector('.quote-skeleton')", 1000), '2. while the price is asked: a placeholder, no stale figure');
        }
        await page.until(priced, 15000);
        if (await page.eval("!document.querySelector('.book-summary .quote.error')")) date = addDays(d);
      }
      await shot('harbor-priced');
      if (first) {
        check(!!date, '2b. an open date found and priced by the server', date ?? 'none in 30 days');
        check(await page.eval("/₱[\\d,]+\\.\\d{2}/.test(document.querySelector('.book-summary .quote-total')?.textContent ?? '')"), '2c. the total is in the summary', await page.eval("document.querySelector('.book-summary .quote-total')?.textContent"));
      }

      // 3. A promo code that does not apply: the server's words beside the field.
      await page.click('.promo-open');
      await page.until("document.activeElement?.id === 'promo-code'", 2000);
      await page.type('#promo-code', 'NOPE-WALK');
      await page.until(priced, 15000);
      await page.until("!!document.querySelector('.promo-field .field-error')", 5000);
      await shot('harbor-promo');
      if (first) check(await page.eval("!!document.querySelector('.promo-field .field-error')"), '3. a code that does not apply: why, beside the field', await page.eval("document.querySelector('.promo-field .field-error')?.textContent"));
      await page.eval(setValue('#promo-code', ''));
      await page.until(priced, 15000);

      // 4. The details, Send, the receipt.
      await page.type('#name', 'Walk Five');
      await page.type('#phone', '0917 000 0005');
      await page.type('#email', 'walk5@example.com');
      // D-129: Send stays off until the consent box is ticked.
      if (first) check(await page.eval("document.querySelector('.book-send').disabled"), '4a. details in, consent not ticked: Send still off');
      await page.click('#book-consent');
      if (first) check(await page.until("!document.querySelector('.book-send').disabled", 3000), '4. details in and consent ticked: Send on');
      await page.click('.book-send');
      await page.until("!!document.querySelector('.receipt')", 10000);
      await shot('receipt');
      if (first) {
        check(await page.eval("document.querySelector('.receipt .reference')?.textContent === 'HAR-WALK5Z' && document.querySelectorAll('.next-steps li').length === 3"), '4b. the receipt: the reference, three next steps');
        await page.click('.receipt-reference button');
        check(await page.until("/Copied/.test(document.querySelector('.receipt-reference button').textContent)", 3000), '4c. Copy says Copied');
        const clip = await page.eval("navigator.clipboard.readText().catch(() => '')");
        check(clip === 'HAR-WALK5Z', '4d. the reference is on the clipboard', clip || '(empty)');
      }

      // 5. villa (whole_resort): the Guests section is one number.
      await page.goto(`${BASE}/t/villa/book`);
      await page.until("!!document.querySelector('.book-summary')", 30000);
      await page.eval(setValue('#guests', '10'));
      for (let d = 30; d < 60; d++) {
        await page.eval(setValue('#check-in', addDays(d)));
        await page.until(priced, 15000);
        if (await page.eval("!document.querySelector('.book-summary .quote.error')")) break;
      }
      await shot('villa-priced');
      if (first) check(await page.eval("document.querySelector('#step-guests').textContent === '2 Guests' && !!document.querySelector('.book-summary .quote-total')"), '5. villa: "2 Guests", priced');
    }
  } finally {
    browser.close();
  }
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
