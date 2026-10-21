// date-field-walk.mjs — the date picker (plan/date-field.md Phase 3, D-143)
// on the booking page, in headless Chrome: the keyboard path, the pointer
// path, the phone sheet, screenshots light and dark at 1280 and 375, and
// axe over the open dialog when axe-core is unpacked (see
// ui-refresh-a11y.mjs for how). Nothing is written: the walk never submits.
//
//   node plan/date-field-walk.mjs [base-url] [slug]
//
// Needs pnpm dev. Shots land in plan/date-field/.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openBrowser } from './ui-refresh-cdp.mjs';

const BASE = process.argv[2] ?? 'http://localhost:3000';
const SLUG = process.argv[3] ?? 'villa';
const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, 'date-field');
const AXE_PATH = join(HERE, 'ui-refresh', 'axe', 'axe.min.js');

let failures = 0;
const check = (ok, what, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? `  — ${detail}` : ''}`);
};
const shift = (date, days) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
const label = (date) => {
  const at = new Date(`${date}T00:00:00Z`);
  const part = (o) => at.toLocaleDateString('en-GB', { ...o, timeZone: 'UTC' });
  return `${part({ weekday: 'short' })}, ${at.getUTCDate()} ${part({ month: 'short' })} ${at.getUTCFullYear()}`;
};
const longDate = (date) => {
  const at = new Date(`${date}T00:00:00Z`);
  const part = (o) => at.toLocaleDateString('en-GB', { ...o, timeZone: 'UTC' });
  return `${part({ weekday: 'long' })} ${at.getUTCDate()} ${part({ month: 'long' })} ${at.getUTCFullYear()}`;
};
const monthTitle = (date) => {
  const at = new Date(`${date}T00:00:00Z`);
  return `${at.toLocaleDateString('en-GB', { month: 'long', timeZone: 'UTC' })} ${at.getUTCFullYear()}`;
};
const active = "(() => { const a = document.activeElement; return { id: a?.id ?? '', label: a?.getAttribute('aria-label') ?? '', tab: a?.tabIndex }; })()";
const dialogOpen = "!!document.querySelector('.date-field [role=dialog]')";
const KEY = { ArrowRight: 39, ArrowDown: 40, Enter: 13, Escape: 27, PageDown: 34 };
const press = (page, key, modifiers = 0) => page.key(key, key, KEY[key], modifiers);

async function axe(page, what) {
  if (!existsSync(AXE_PATH)) {
    console.log(`skip  axe over ${what}: axe-core is not unpacked at plan/ui-refresh/axe (see ui-refresh-a11y.mjs)`);
    return;
  }
  await page.eval(readFileSync(AXE_PATH, 'utf8'));
  const violations = JSON.parse(
    await page.eval(
      `axe.run(document, { runOnly: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'] }).then(r => JSON.stringify(r.violations.map(v => ({ id: v.id, impact: v.impact, nodes: v.nodes.map(n => n.target.join(' ')) }))))`,
    ),
  );
  check(violations.length === 0, `axe over ${what}: 0 violations`, violations.length ? JSON.stringify(violations).slice(0, 400) : '');
}

let browser = null;
try {
  browser = await openBrowser({ scheme: 'light' });
  const { page } = browser;
  await page.viewport(1280);
  await page.goto(`${BASE}/t/${SLUG}/book`);
  await page.until("!!document.querySelector('button#check-in[aria-haspopup=dialog]')", 20000);

  const nativeOpacity = await page.eval("getComputedStyle(document.querySelector('.date-field input[type=date]')).opacity");
  const today = await page.eval("document.querySelector('.date-field input[type=date]').min");
  check(nativeOpacity === '0' && /^\d{4}-\d{2}-\d{2}$/.test(today), '1. the field is a button; the native date input is there at opacity 0, carrying min = today', `opacity ${nativeOpacity}, min ${today}`);

  // Pointer: open, then the keyboard inside.
  await page.click('#check-in');
  await page.until(dialogOpen);
  const title = await page.eval("document.querySelector('.date-title').textContent");
  const focused = await page.eval(active);
  check(title === monthTitle(today) && focused.tab === 0 && /, today/.test(focused.label), '2. opens on today\'s month with today focused (tabindex 0, "today" in its name)', `${title} · ${focused.label}`);

  await press(page, 'ArrowRight');
  await press(page, 'ArrowRight');
  const moved = await page.eval(active);
  await press(page, 'Enter');
  await page.until(`!${dialogOpen}`);
  const chosen = await page.eval("document.querySelector('.date-field input[type=date]').value");
  const shown = await page.eval("document.querySelector('#check-in .date-value').textContent");
  const after = await page.eval(active);
  check(
    chosen === shift(today, 2) && shown === label(shift(today, 2)) && after.id === 'check-in',
    '3. two ArrowRights and Enter choose today + 2: the native value, the shown label, focus back on the button',
    `moved to "${moved.label.slice(0, 30)}", value ${chosen}, shown "${shown}", focus #${after.id}`,
  );

  // Keyboard: ArrowDown opens, Escape closes without changing anything.
  await press(page, 'ArrowDown');
  await page.until(dialogOpen);
  const reopened = await page.eval(active);
  await press(page, 'Escape');
  await page.until(`!${dialogOpen}`);
  const kept = await page.eval("document.querySelector('.date-field input[type=date]').value");
  const back = await page.eval(active);
  check(reopened.label.startsWith(longDate(shift(today, 2))) && reopened.tab === 0, '4a. ArrowDown on the button reopens with the chosen day focused', reopened.label.slice(0, 40));
  check(kept === shift(today, 2) && back.id === 'check-in', '4b. Escape closes, keeps the value, returns focus to the button', `value ${kept}, focus #${back.id}`);

  // Shift+PageDown a year: the focus is clamped to the horizon, the days past it are off, Next is disabled.
  await press(page, 'ArrowDown');
  await page.until(dialogOpen);
  await press(page, 'PageDown', 8);
  const max = await page.eval("document.querySelector('.date-field input[type=date]').max");
  const atMax = await page.eval(active);
  const offAfter = await page.eval("document.querySelectorAll('.date-day.off.after').length");
  const nextDisabled = await page.eval("document.querySelector('.date-head button[aria-label=\"Next month\"]').disabled");
  check(atMax.label.startsWith(longDate(max)) && atMax.tab === 0, '5a. Shift+PageDown lands on the last allowed day, clamped to the horizon', `${atMax.label.slice(0, 40)} (max ${max})`);
  check(offAfter > 0 && nextDisabled === true, '5b. the days after the horizon are aria-disabled and Next month is disabled', `${offAfter} off, next disabled ${nextDisabled}`);
  const offReason = await page.eval("document.querySelector('.date-day.off.after')?.getAttribute('aria-label') ?? ''");
  check(/after the latest date/.test(offReason), '5c. an off day says why in its name', offReason.slice(0, 60));
  await press(page, 'Escape');

  // Shots: today's month open, 1280 light.
  await page.click('#check-in');
  await page.until(dialogOpen);
  await page.shot(join(OUT, 'book-open-light-1280.png'));
  await axe(page, 'the open dialog at 1280 (light)');

  // Pointer outside closes it.
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 8, y: 8, button: 'left', clickCount: 1 });
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 8, y: 8, button: 'left', clickCount: 1 });
  const closedByPointer = await page.until(`!${dialogOpen}`, 3000);
  check(closedByPointer, '6. a pointer down outside the field closes the dialog');

  // The phone: a sheet pinned to the bottom.
  await page.viewport(375);
  await page.goto(`${BASE}/t/${SLUG}/book`);
  await page.until("!!document.querySelector('button#check-in[aria-haspopup=dialog]')", 20000);
  await page.click('#check-in');
  await page.until(dialogOpen);
  const pos = await page.eval("getComputedStyle(document.querySelector('.date-pop')).position");
  const fits = await page.eval("(() => { const r = document.querySelector('.date-pop').getBoundingClientRect(); return r.left >= 0 && r.right <= window.innerWidth && r.bottom <= window.innerHeight; })()");
  check(pos === 'fixed' && fits, '7. at 375 the dialog is a fixed sheet inside the viewport', `position ${pos}, fits ${fits}`);
  await page.shot(join(OUT, 'book-open-light-375.png'));
  await axe(page, 'the open sheet at 375 (light)');
  browser.close();

  browser = await openBrowser({ scheme: 'dark' });
  for (const width of [1280, 375]) {
    await browser.page.viewport(width);
    await browser.page.goto(`${BASE}/t/${SLUG}/book`);
    await browser.page.until("!!document.querySelector('button#check-in[aria-haspopup=dialog]')", 20000);
    await browser.page.click('#check-in');
    await browser.page.until(dialogOpen);
    await browser.page.shot(join(OUT, `book-open-dark-${width}.png`));
  }
} catch (error) {
  check(false, 'the walk ran to the end', error.message);
} finally {
  browser?.close();
}
console.log(failures ? `\n${failures} FAILED` : '\ndate-field walk: all passed');
process.exit(failures ? 1 : 0);
