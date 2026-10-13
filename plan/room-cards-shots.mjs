// room-cards-shots.mjs — the chat's room cards and the photo viewer
// (plan/room-cards.md), photographed on alteza, which has rooms with photos.
//
//   (cd packages/db && node --conditions=react-server --env-file=../../.env ../../plan/room-cards-shots.mjs <label>)
//
// Clicks alteza's suggested question "What rooms are available?" (a REAL
// chat turn: one OpenAI call per scheme), waits for the cards, and writes
// plan/room-cards/<label>-<cards|viewer|viewer-2>-<scheme>-<width>.png.
// The conversation is saved like any visitor's. Needs pnpm dev.

import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openBrowser } from './ui-refresh-cdp.mjs';

const BASE = 'http://localhost:3000';
const LABEL = process.argv[2] ?? 'shot';
const OUT = join(dirname(fileURLToPath(import.meta.url)), 'room-cards');
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let browser;
try {
  for (const scheme of ['light', 'dark']) {
    browser = await openBrowser({ scheme });
    const { page } = browser;
    await page.viewport(1280);
    await page.goto(`${BASE}/t/alteza`);
    await page.until("[...document.querySelectorAll('.suggestions button')].some(b => /rooms/i.test(b.textContent))", 30000);
    await page.eval("[...document.querySelectorAll('.suggestions button')].find(b => /rooms/i.test(b.textContent)).click(); true");
    const got = await page.until("document.querySelectorAll('.room-card').length > 0", 90000);
    if (!got) throw new Error('no room cards in the reply');
    await sleep(2500); // the photos
    for (const width of [1280, 375]) {
      await page.viewport(width);
      await sleep(600);
      await page.eval("document.querySelector('.room-cards').scrollIntoView({ block: 'start' }); true");
      await sleep(600);
      await page.shot(join(OUT, `${LABEL}-cards-${scheme}-${width}.png`));
      const photo = await page.eval("(() => { const b = [...document.querySelectorAll('.room-card-photo, .room-card button')].find(x => x.querySelector('img')); if (!b) return false; b.click(); return true; })()");
      if (!photo) continue;
      await sleep(1200);
      await page.shot(join(OUT, `${LABEL}-viewer-${scheme}-${width}.png`));
      await page.key('ArrowRight', 'ArrowRight', 39);
      await sleep(800);
      await page.shot(join(OUT, `${LABEL}-viewer-2-${scheme}-${width}.png`));
      await page.key('Escape', 'Escape', 27);
      await sleep(400);
    }
    browser.close();
    browser = null;
  }
  console.log(`written to ${OUT}`);
} finally {
  browser?.close();
}
