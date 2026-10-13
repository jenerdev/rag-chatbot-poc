// book-photos-check.mjs — room photos on the booking page's room step
// (plan/landing-and-media.md item 2): a walk and axe on alteza (per_room,
// rooms with photos), 1280 and 375, light and dark.
//
//   (cd packages/db && node --conditions=react-server --env-file=../../.env ../../plan/book-photos-check.mjs)
//
// Picks a date a week into the tenant's bookable range, continues to the room step, and checks: every
// room with photos has a thumbnail named with its count; a click opens the
// viewer on that room and does NOT tick the room; Escape closes it. Nothing
// is sent: the walk stops before the request. Screenshots in
// plan/book-photos/. Needs pnpm dev.

import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openBrowser } from './ui-refresh-cdp.mjs';

const BASE = 'http://localhost:3000';
const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, 'book-photos');
mkdirSync(OUT, { recursive: true });
const AXE = readFileSync(join(HERE, 'ui-refresh', 'axe', 'axe.min.js'), 'utf8');
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
    const audit = async (label) => {
      await page.eval(AXE);
      const violations = JSON.parse(
        await page.eval(`axe.run(document, { runOnly: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'] }).then(r => JSON.stringify(r.violations.map(v => ({ id: v.id, impact: v.impact, nodes: v.nodes.length, sample: v.nodes[0]?.target?.join(' ') }))))`),
      );
      audited++;
      for (const v of violations) found.push(`${label} [${scheme}] ${v.id} (${v.impact}, ${v.nodes}): ${v.sample}`);
      console.log(`${violations.length === 0 ? 'clean' : `${violations.length} violation(s)`}  ${label} [${scheme}]`);
    };
    for (const width of [1280, 375]) {
      await page.viewport(width);
      await page.goto(`${BASE}/t/alteza/book`);
      await page.until("!!document.querySelector('input[type=date]')", 30000);
      // The input is in the server's HTML before React takes it over; a value set sooner is reset.
      await sleep(2000);
      // A date inside the tenant's own horizon (alteza's is about 20 days): a week after its first bookable day.
      await page.eval(`(() => { const i = document.querySelector('input[type=date]'); const d = new Date(i.min + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + 7); const day = d.toISOString().slice(0, 10) > i.max ? i.max : d.toISOString().slice(0, 10); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, day); i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
      // Continue enables once the date is taken; a click on a hidden step would prove nothing.
      await page.until("[...document.querySelectorAll('button')].some(b => b.textContent.trim().startsWith('Continue') && !b.disabled && b.offsetParent !== null)", 15000);
      await page.eval("[...document.querySelectorAll('button')].find(b => b.textContent.trim().startsWith('Continue') && !b.disabled && b.offsetParent !== null).click(); true");
      const reached = await page.until("!!document.querySelector('.room-pick-photo') && document.querySelector('.room-pick-photo').offsetParent !== null", 15000);
      await sleep(1500);
      await page.eval("document.querySelector('.room-picks').scrollIntoView({ block: 'center' }); true");
      await sleep(300);
      await page.shot(join(OUT, `rooms-${scheme}-${width}.png`));
      if (scheme === 'light' && width === 1280) {
        const thumbs = await page.eval("[...document.querySelectorAll('.room-pick-photo')].map(b => b.getAttribute('aria-label'))");
        check(reached && thumbs.length > 0 && thumbs.every((l) => /^See \d+ photos? of .+/.test(l)), '1. the room step (visible) shows a named thumbnail for each room with photos', `${thumbs.length}: ${thumbs.slice(0, 2).join(' | ')}`);
      }
      await audit(`room step @${width}`);
      await page.eval("(() => { const b = document.querySelector('.room-pick-photo'); b.setAttribute('data-walk', 'opener'); b.click(); return true; })()");
      await page.until("!!document.querySelector('.lightbox')", 5000);
      await sleep(800);
      await page.shot(join(OUT, `viewer-${scheme}-${width}.png`));
      if (scheme === 'light' && width === 1280) {
        const state = await page.eval("({ title: document.querySelector('.lightbox-title')?.textContent, room: document.querySelector('[data-walk=opener]').closest('.room-pick').querySelector('.room-pick-name').textContent, ticked: document.querySelector('[data-walk=opener]').closest('.room-pick').querySelector('input[type=checkbox]').checked })");
        check(state.title === state.room && state.ticked === false, '2. a thumbnail opens the viewer on its room, and does not tick the room', JSON.stringify(state));
      }
      await audit(`room viewer @${width}`);
      await page.key('Escape', 'Escape', 27);
      await sleep(300);
      if (scheme === 'light' && width === 1280) {
        check(await page.eval("!document.querySelector('.lightbox') && document.activeElement?.getAttribute('data-walk') === 'opener'"), '3. Escape closes it, focus back on the thumbnail');
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
