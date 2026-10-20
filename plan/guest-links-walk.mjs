// The three guest pages link to each other (D-136), against pnpm dev: the
// chat (welcome buttons and the links under the field), the booking page
// and Manage booking (the header and the footer). Reads the links on each
// villa page as a visitor, no login, at 1280 and 390. No rows are made.
//
//   (cd packages/db && node --conditions=react-server --env-file=../../.env ../../plan/guest-links-walk.mjs)

import { mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openBrowser } from './ui-refresh-cdp.mjs';

const BASE = process.argv[2] ?? 'http://localhost:3000';
const SLUG = 'villa';
const OUT = join(dirname(fileURLToPath(import.meta.url)), 'guest-links', 'walk');
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failures++;
};
// Every link on the page that goes to one of the three guest pages, by where it sits.
const links = (sel) => `[...document.querySelectorAll(${JSON.stringify(sel)})].map(a => a.getAttribute('href')).filter(h => h === '/t/${SLUG}' || h === '/t/${SLUG}/book' || h === '/t/${SLUG}/manage')`;
const CHAT = `/t/${SLUG}`, BOOK = `/t/${SLUG}/book`, MANAGE = `/t/${SLUG}/manage`;

let browser;
try {
  browser = await openBrowser({ scheme: 'light' });
  const page = browser.page;
  await page.viewport(1280);

  // 1. The chat: the welcome offers both pages; the links under the field too.
  await page.goto(`${BASE}${CHAT}`);
  await page.until("!!document.querySelector('.welcome-book')", 30000);
  const welcome = await page.eval(links('.welcome-book a'));
  const foot = await page.eval(links('.composer-links a'));
  check(welcome.join() === `${BOOK},${MANAGE}` && foot.join() === `${BOOK},${MANAGE}`, '1. the chat links to the booking page and Manage booking, on the welcome and under the field', `${welcome.join(' ')} · ${foot.join(' ')}`);
  await page.shot(join(OUT, 'chat-1280.png'));

  // 2. The booking page: the header has Chat and Manage booking, not itself; the footer Manage booking.
  await page.goto(`${BASE}${BOOK}`);
  await page.until("!!document.querySelector('.public-header nav a')", 30000);
  const bookHead = await page.eval(links('.public-header nav a'));
  const bookFoot = await page.eval(links('.public-footer a'));
  check(bookHead.join() === `${CHAT},${MANAGE}` && bookFoot.includes(MANAGE), '2. the booking page links to the chat and Manage booking in its header, not to itself', `${bookHead.join(' ')} · ${bookFoot.join(' ')}`);
  await page.shot(join(OUT, 'book-1280.png'));

  // 3. Manage booking: the header has Chat and Book a stay; the footer Book a stay.
  await page.goto(`${BASE}${MANAGE}`);
  await page.until("!!document.querySelector('.public-header nav a')", 30000);
  const manageHead = await page.eval(links('.public-header nav a'));
  const manageFoot = await page.eval(links('.public-footer a'));
  const manageWords = await page.eval("[...document.querySelectorAll('.public-header nav a')].map(a => a.textContent.trim())");
  check(manageHead.join() === `${CHAT},${BOOK}` && manageFoot.includes(BOOK) && manageWords.join() === 'Chat,Book a stay', '3. Manage booking links to the chat and the booking page in its header, not to itself', `${manageWords.join(' · ')} · ${manageFoot.join(' ')}`);
  await page.shot(join(OUT, 'manage-1280.png'));

  // 4. On a phone every header link is still there and nothing scrolls sideways.
  await page.viewport(390);
  for (const [name, url] of [['chat', CHAT], ['book', BOOK], ['manage', MANAGE]]) {
    await page.goto(`${BASE}${url}`);
    await page.until(name === 'chat' ? "!!document.querySelector('.welcome-book')" : "!!document.querySelector('.public-header nav a')", 30000);
    await sleep(300);
    const width = await page.eval('document.documentElement.scrollWidth');
    const count = await page.eval(links(name === 'chat' ? '.welcome-book a' : '.public-header nav a')).then((l) => l.length);
    check(width <= 390 && count === 2, `4. ${name} at 390: both links, no sideways scroll`, `scrollWidth ${width}, ${count} links`);
    await page.shot(join(OUT, `${name}-390.png`));
  }
} finally {
  browser?.close();
}
console.log(failures === 0 ? 'guest links walk: all pass' : `guest links walk: ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
