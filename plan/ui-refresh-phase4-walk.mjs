// ui-refresh-phase4-walk.mjs — what a reply contains, in a real browser,
// against a running dev server (plan/ui-refresh.md Phase 4): the table (and
// its phone cards), the availability evidence, the sources, the room cards
// and the lightbox. Screenshots into plan/ui-refresh/phase4/walk/, light and
// dark, at 375 and 1280 px.
//
// As in Phase 3's walk, the chat route is answered INSIDE the browser in the
// server's own event format, so every reply is the same each run and no
// model is called. The photos are data: URIs drawn here, so no bucket is
// read either.
//
//   node plan/ui-refresh-phase4-walk.mjs [base-url]

import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openBrowser } from './ui-refresh-cdp.mjs';

const BASE = process.argv[2] ?? 'http://localhost:3000';
const OUT = join(dirname(fileURLToPath(import.meta.url)), 'ui-refresh', 'phase4', 'walk');
let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failures++;
};

const sse = (events) => events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join('');
const photo = (hue, label) =>
  `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="800" height="500"><rect width="800" height="500" fill="hsl(${hue} 45% 62%)"/><text x="400" y="270" font-family="sans-serif" font-size="56" fill="white" text-anchor="middle">${label}</text></svg>`)}`;
const CARDS = [
  { name: 'Garden Room', photos: [photo(140, 'Garden 1'), photo(150, 'Garden 2'), photo(160, 'Garden 3')] },
  { name: 'Sea View Suite', photos: [photo(200, 'Sea View')] },
  { name: 'Loft', photos: [] },
];
const SOURCES = [
  { id: 1, documentId: 1, documentTitle: 'Harbor Inn Guest Guide', content: 'Check-in is from 2 PM and check-out is until 11 AM. Early check-in can be arranged on request, subject to availability. The front desk is open from 7 AM to 10 PM.', similarity: 0.612, foundBy: 'both' },
  { id: 2, documentId: 1, documentTitle: 'Harbor Inn Guest Guide', content: 'Rooms: Garden Room (2 guests), Family Room (up to 6), Loft (up to 3) and the Sea View Suite (2 guests).', similarity: 0.471, foundBy: 'keyword' },
];
const TOOL = {
  name: 'check_availability',
  args: { date_from: '2026-10-10' },
  result: { slots: [
    { date: '2026-10-10', unit: 'Garden Room', slot: 'Night', status: 'open' },
    { date: '2026-10-10', unit: 'Loft', slot: 'Night', status: 'taken' },
    { date: '2026-10-10', unit: 'Sea View Suite', slot: 'Night', status: 'open' },
  ] },
};
const TABLE = 'These rooms are open on Sat 10 Oct, at the weekend rate:\n\n| Room | Guests | Price |\n|---|---|---|\n| Garden Room | up to 2 | ₱4,500.00 |\n| Sea View Suite | up to 2 | ₱9,500.00 |\n\nThe Loft is taken that night. 🙂';
const ROOMS = 'Here are our rooms:\n\n| Room | Guests | Weekday | Weekend |\n|---|---|---|---|\n| Garden Room | up to 2 | ₱3,500.00 | ₱4,500.00 |\n| Sea View Suite | up to 2 | ₱8,000.00 | ₱9,500.00 |\n| Loft | up to 3 | ₱4,800.00 | ₱5,800.00 |';
const meta = (extra = {}) => ['meta', { conversationId: '00000000-0000-4000-8000-000000000002', sources: SOURCES, searchQuery: 'rooms open saturday', ...extra }];

for (const scheme of ['light', 'dark']) {
  const browser = await openBrowser({ scheme });
  const { page } = browser;
  const loud = scheme === 'light';
  const dir = scheme === 'dark' ? `${OUT}-dark` : OUT;
  let next = '';
  await page.send('Fetch.enable', { patterns: [{ urlPattern: '*/api/t/*/chat' }] });
  page.on('Fetch.requestPaused', (p) =>
    void page.send('Fetch.fulfillRequest', {
      requestId: p.requestId,
      responseCode: 200,
      responseHeaders: [{ name: 'Content-Type', value: 'text/event-stream' }],
      body: Buffer.from(next).toString('base64'),
    }),
  );
  const ask = async (text, reply) => {
    next = reply;
    await page.type('#input', text);
    await page.key('Enter', 'Enter', 13);
    await page.until("!document.querySelector('.bubble.thinking') && document.querySelectorAll('.turn.assistant').length > 0");
  };

  try {
    for (const width of [375, 1280]) {
      await page.viewport(width);
      const shot = (name) => page.shot(join(dir, `${name}-${width}.png`));
      const first = loud && width === 1280;
      const phone = loud && width === 375;
      await page.goto(`${BASE}/t/harbor`);
      await page.until("!!document.querySelector('.composer')", 30000);

      // 1. A priced table with the evidence and the sources.
      await ask('Which rooms are open on Saturday?', sse([meta(), ['tool', TOOL], ['delta', { text: TABLE }], ['done', {}]]));
      await page.until("!!document.querySelector('.reply-table')");
      await page.eval("document.querySelector('#messages').scrollTop = 0");
      await shot('table');
      if (first) {
        check(await page.eval("getComputedStyle(document.querySelector('.reply-table td:nth-child(2)')).borderLeftWidth === '0px'"), '1. the table has no vertical rules');
        check(await page.eval("getComputedStyle(document.querySelector('.reply-table td.amount')).textAlign === 'right'"), '1b. amounts are right-aligned');
        check(await page.eval("(() => { const t = document.querySelector('.tool-call'); return !!t && t.getBoundingClientRect().height > 0 && !t.closest('details'); })()"), '1c. the availability evidence is shown open (rule 7)');
        check(await page.eval("document.querySelectorAll('.tool-call .slot-chip').length === 3 && !!document.querySelector('.tool-call .slot-chip.taken')"), '1d. its three rows, taken marked');
        check(await page.eval("!document.querySelector('.sources').open && /2 sources/.test(document.querySelector('.sources summary').textContent)"), '1e. the sources: one closed line, "2 sources"');
        await page.click('.sources summary');
        await new Promise((r) => setTimeout(r, 150));
        check(await page.eval("document.querySelectorAll('.sources .source').length === 2 && document.querySelectorAll('.source-score meter').length === 2"), '1f. opened: two cards, each score with its bar');
        check(await page.eval("!/mono|Consolas/i.test(getComputedStyle(document.querySelector('.source-text')).fontFamily)"), '1g. the chunk text is not monospace');
        check(await page.eval("document.querySelector('.rewrite-note')?.textContent === 'searched for: rooms open saturday'"), '1h. the rewritten search is still said (D-016)');
        await shot('sources-open');
      }
      if (phone) {
        // The phone layout (D-091): each row a card, every price on screen.
        const fits = await page.eval("[...document.querySelectorAll('.reply-table td.amount')].every(td => { const r = td.getBoundingClientRect(); return r.width > 0 && r.right <= innerWidth; })");
        check(fits, '1p. phone: each row a card, every price inside the screen');
        check(await page.eval("getComputedStyle(document.querySelector('.reply-table')).borderTopWidth === '0px'"), '1q. phone: no second frame round the row cards');
      }

      // 2. A room list as cards, with photos.
      await ask('What rooms do you have?', sse([meta({ roomCards: CARDS, roomCardsView: 'cards' }), ['delta', { text: ROOMS }], ['done', {}]]));
      await page.until("!!document.querySelector('.room-cards')");
      await page.eval("document.querySelector('.room-cards').scrollIntoView()");
      await shot('room-cards');
      if (first) {
        check(await page.eval("document.querySelectorAll('.room-card').length === 3 && document.querySelectorAll('.room-card-photo').length === 2"), '2. three cards; the Loft has no photo, so none is drawn');
        check(await page.eval("getComputedStyle(document.querySelector('.room-card-title')).backgroundColor === 'rgba(0, 0, 0, 0)'"), '2b. the title has no tinted bar');
      }

      // 3. The lightbox: focus in, step, swipe, Escape, focus back.
      await page.eval("document.querySelector('.room-card-photo').focus()");
      await page.click('.room-card-photo');
      await page.until("!!document.querySelector('.lightbox')");
      await new Promise((r) => setTimeout(r, 300)); // the fade
      await shot('lightbox');
      if (first) {
        check(await page.eval("document.querySelector('.lightbox').getAttribute('aria-modal') === 'true' && document.activeElement?.classList.contains('lightbox-close')"), '3. a modal dialog; focus on Close');
        await page.key('ArrowRight', 'ArrowRight', 39);
        check(await page.until("document.querySelector('.lightbox-count')?.textContent === '2 / 3'", 2000), '3b. the arrow key steps: 2 / 3');
        // A swipe left: press, move, release, 200 px to the left.
        const y = 300;
        await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 700, y, button: 'left', clickCount: 1 });
        await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 600, y, button: 'left' });
        await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 500, y, button: 'left', clickCount: 1 });
        check(await page.until("document.querySelector('.lightbox-count')?.textContent === '3 / 3'", 2000), '3c. a swipe left steps: 3 / 3', await page.eval("document.querySelector('.lightbox-count')?.textContent"));
        await page.key('Escape', 'Escape', 27);
        check(await page.until("!document.querySelector('.lightbox') && document.activeElement?.classList.contains('room-card-photo')", 2000), '3d. Escape closes; focus back on the photo');
      } else {
        await page.key('Escape', 'Escape', 27);
      }

      // 4. A refusal: no sources is a plain line, not an empty <details>.
      await ask('Do you allow pets?', sse([['meta', { conversationId: '00000000-0000-4000-8000-000000000002', sources: [], searchQuery: 'pets' }], ['delta', { text: "Sorry, I don't have that information yet." }], ['done', {}]]));
      await page.eval("document.querySelector('#messages').scrollTop = 1e6");
      await shot('refusal');
      if (first) check(await page.eval("(() => { const turns = document.querySelectorAll('.turn.assistant'); const last = turns[turns.length - 1]; return !!last.querySelector('p.sources-none') && !last.querySelector('details'); })()"), '4. no sources: a plain line, nothing to open');
    }
  } finally {
    browser.close();
  }
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
