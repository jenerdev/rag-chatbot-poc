// room-cards-check.mjs — the room cards and the photo viewer
// (plan/room-cards.md): a walk and axe, on alteza's real reply to its
// suggested question "What rooms are available?" (one OpenAI call per
// scheme; the conversation is saved like any visitor's).
//
//   (cd packages/db && node --conditions=react-server --env-file=../../.env ../../plan/room-cards-check.mjs)
//
// Walk (light, 1280, then 375): chips and named photo buttons; the viewer
// opens on Close, keeps Tab inside, steps by arrow key and by thumbnail,
// and gives focus back to the photo on Escape; on a phone the cards are
// one row that scrolls sideways. axe: the cards and the open viewer, 1280
// and 375, light and dark (8 states). Needs pnpm dev.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openBrowser } from './ui-refresh-cdp.mjs';

const BASE = 'http://localhost:3000';
const AXE = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'ui-refresh', 'axe', 'axe.min.js'), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (ok, label, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
};
let audited = 0;
const found = [];

let browser;
try {
  for (const scheme of ['light', 'dark']) {
    browser = await openBrowser({ scheme });
    const { page } = browser;
    await page.viewport(1280);
    await page.goto(`${BASE}/t/alteza`);
    await page.until("[...document.querySelectorAll('.suggestions button')].some(b => /rooms/i.test(b.textContent))", 30000);
    await page.eval("[...document.querySelectorAll('.suggestions button')].find(b => /rooms/i.test(b.textContent)).click(); true");
    if (!(await page.until("document.querySelectorAll('.room-card').length > 0", 90000))) throw new Error('no room cards in the reply');
    await sleep(2500);
    const audit = async (label) => {
      await page.eval(AXE);
      const violations = JSON.parse(
        await page.eval(`axe.run(document, { runOnly: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'] }).then(r => JSON.stringify(r.violations.map(v => ({ id: v.id, impact: v.impact, nodes: v.nodes.length, sample: v.nodes[0]?.target?.join(' ') }))))`),
      );
      audited++;
      for (const v of violations) found.push(`${label} [${scheme}] ${v.id} (${v.impact}, ${v.nodes}): ${v.sample}`);
      console.log(`${violations.length === 0 ? 'clean' : `${violations.length} violation(s)`}  ${label} [${scheme}]`);
    };
    const openFirstMany = "(() => { const b = [...document.querySelectorAll('.room-card-photo')].find(x => /[2-9] photos/.test(x.textContent)) ?? document.querySelector('.room-card-photo'); b.setAttribute('data-walk', 'opener'); b.focus(); b.click(); return b.textContent; })()";

    for (const width of [1280, 375]) {
      await page.viewport(width);
      await sleep(600);
      await page.eval("document.querySelector('.room-cards').scrollIntoView({ block: 'start' }); true");
      await sleep(400);
      if (scheme === 'light' && width === 1280) {
        const cards = await page.eval("({ cards: document.querySelectorAll('.room-card').length, chips: document.querySelectorAll('.room-card-facts li').length, named: [...document.querySelectorAll('.room-card-photo')].every(b => b.getAttribute('aria-label').includes(b.textContent.trim())) })");
        check(cards.cards > 0 && cards.chips > 0 && cards.named, '1. cards with fact chips; every photo button named, its name containing its badge', JSON.stringify(cards));
      }
      if (scheme === 'light' && width === 375) {
        const row = await page.eval("(() => { const r = document.querySelector('.room-cards'); return { display: getComputedStyle(r).display, scrolls: r.scrollWidth > r.clientWidth + 10, cardWidth: Math.round(document.querySelector('.room-card').getBoundingClientRect().width), rowWidth: r.clientWidth }; })()");
        check(row.display === 'flex' && row.scrolls && row.cardWidth < row.rowWidth, '7. phone: one row that scrolls sideways, the next card at the edge', JSON.stringify(row));
      }
      await audit(`cards @${width}`);

      const opened = await page.eval(openFirstMany);
      await sleep(600);
      await audit(`viewer @${width}`);
      if (scheme === 'light' && width === 1280) {
        const state = await page.eval("({ label: document.querySelector('.lightbox').getAttribute('aria-label'), focus: document.activeElement?.getAttribute('aria-label'), title: document.querySelector('.lightbox-title')?.textContent, count: document.querySelector('.lightbox-count')?.textContent, thumbs: document.querySelectorAll('.lightbox-thumb').length })");
        check(/photo 1 of \d/.test(state.label) && state.focus === 'Close photos' && !!state.title, '2. the viewer: named by room and photo, focus on Close, the room in the bar', JSON.stringify(state));
        let inside = true;
        for (let i = 0; i < 8; i++) {
          await page.tab();
          if (!(await page.eval("!!document.activeElement?.closest('.lightbox')"))) inside = false;
        }
        check(inside, '3. 8 Tabs never leave the viewer');
        if (state.thumbs > 1) {
          await page.key('ArrowRight', 'ArrowRight', 39);
          await sleep(300);
          const stepped = await page.eval("({ count: document.querySelector('.lightbox-count').textContent, current: [...document.querySelectorAll('.lightbox-thumb')].findIndex(t => t.getAttribute('aria-current') === 'true') })");
          await page.eval("document.querySelector('.lightbox-thumb').click(); true");
          await sleep(300);
          const back = await page.eval("document.querySelector('.lightbox-count').textContent");
          check(stepped.count.startsWith('2 of') && stepped.current === 1 && back.startsWith('1 of'), '4. the arrow key steps, the thumbnail follows, a thumbnail jumps back', `${JSON.stringify(stepped)} → ${back}`);
        } else {
          check(false, '4. a room with more than one photo to step through', `thumbs ${state.thumbs}, opened ${opened}`);
        }
        const photoBox = await page.eval("(() => { const i = document.querySelector('.lightbox-stage img').getBoundingClientRect(); const c = document.querySelector('.lightbox-close').getBoundingClientRect(); return { overlaps: !(c.bottom <= i.top || c.top >= i.bottom || c.right <= i.left || c.left >= i.right) }; })()");
        check(!photoBox.overlaps, '5. Close does not sit on the photo', JSON.stringify(photoBox));
      }
      await page.key('Escape', 'Escape', 27);
      await sleep(300);
      if (scheme === 'light' && width === 1280) {
        check(await page.eval("!document.querySelector('.lightbox') && document.activeElement?.getAttribute('data-walk') === 'opener'"), '6. Escape closes it, focus back on the photo that opened it');
      }
    }
    browser.close();
    browser = null;
  }
} finally {
  browser?.close();
}
console.log(`\n${audited} page states audited, ${found.length} violation(s)`);
for (const f of found) console.log(`  ${f}`);
console.log(failures ? `${failures} FAILED` : 'walk: all passed');
process.exit(failures === 0 && found.length === 0 && audited === 8 ? 0 : 1);
