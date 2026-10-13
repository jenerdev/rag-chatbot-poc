// landing-check.mjs — the root landing page (plan/landing.md, D-121):
// screenshots of each section and axe, at 1280 and 375, light and dark.
//
//   (cd packages/db && node --conditions=react-server --env-file=../../.env ../../plan/landing-check.mjs)
//
// Writes plan/landing/<section>-<scheme>-<width>.png. Needs pnpm dev. The
// page has no data and no tenant: nothing is created.

import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openBrowser } from './ui-refresh-cdp.mjs';

const BASE = 'http://localhost:3000';
const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, 'landing');
mkdirSync(OUT, { recursive: true });
const AXE = readFileSync(join(HERE, 'ui-refresh', 'axe', 'axe.min.js'), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let audited = 0;
const found = [];
let browser;
try {
  for (const scheme of ['light', 'dark']) {
    browser = await openBrowser({ scheme });
    const { page } = browser;
    for (const width of [1280, 375]) {
      await page.viewport(width);
      await page.goto(`${BASE}/`);
      await page.until("!!document.querySelector('.landing-hero')", 30000);
      await sleep(800);
      for (const section of ['top', 'features', 'how', 'why']) {
        await page.eval(`(${section === 'top' ? 'window.scrollTo(0, 0)' : `document.getElementById('${section}').scrollIntoView({ block: 'start' })`}, true)`);
        await sleep(400);
        await page.shot(join(OUT, `${section}-${scheme}-${width}.png`));
      }
      await page.eval(AXE);
      const violations = JSON.parse(
        await page.eval(`axe.run(document, { runOnly: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'] }).then(r => JSON.stringify(r.violations.map(v => ({ id: v.id, impact: v.impact, nodes: v.nodes.length, sample: v.nodes[0]?.target?.join(' ') }))))`),
      );
      audited++;
      for (const v of violations) found.push(`landing @${width} [${scheme}] ${v.id} (${v.impact}, ${v.nodes}): ${v.sample}`);
      console.log(`${violations.length === 0 ? 'clean' : `${violations.length} violation(s)`}  landing @${width} [${scheme}]`);
    }
    browser.close();
    browser = null;
  }
} finally {
  browser?.close();
}
console.log(`\n${audited} page states audited, ${found.length} violation(s)`);
for (const f of found) console.log(`  ${f}`);
process.exit(found.length === 0 && audited === 4 ? 0 : 1);
