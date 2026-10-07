// ui-components-phase6-walk.mjs — tooltips a keyboard sees, in a real
// browser, against a running dev server (plan/ui-components.md Phase 6).
//
// Promos (as a harbor owner): Tab onto an icon button shows its tip, which
// is aria-hidden (the button's own label already says it); Escape hides it;
// the mouse shows it, and moving onto the tip keeps it (WCAG 1.4.13). No
// HTML element on the staff screens carries a `title` any more. Bookings:
// the legend says what open, taken and closed mean; a chip's tip shows on
// hover. The chat (its reply answered in the browser): the "found by"
// badge is focusable and its tip describes it; "Show all" opens a clipped
// chunk and says so (aria-expanded), and a short chunk gets no button.
//
// One throwaway harbor owner, deleted at the end. Nothing is changed: every
// non-GET is caught in the browser; the chat's reply never reaches a model.
//
//   (cd packages/db && node --conditions=react-server --env-file=../../.env ../../plan/ui-components-phase6-walk.mjs [base-url])

import { randomBytes } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { supabase } from '../packages/db/dist/service.js';
import { openBrowser } from './ui-refresh-cdp.mjs';

const BASE = process.argv[2] ?? 'http://localhost:3000';
const OUT = join(dirname(fileURLToPath(import.meta.url)), 'ui-refresh', 'components-6', 'walk');
let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Whether the tip next to `selector` is showing (after its 150 ms fade).
const tipShown = (selector) => `(() => { const t = document.querySelector(${JSON.stringify(selector)})?.closest('.tip')?.querySelector('.tip-text'); if (!t) return null; const s = getComputedStyle(t); return s.visibility === 'visible' && s.opacity === '1'; })()`;
const centre = (selector) => `(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`;

const sse = (events) => events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join('');
const LONG = Array.from({ length: 12 }, (_, i) => `Line ${i + 1} of the guest guide: check-in is from 2 PM and check-out is until 11 AM.`).join(' ');
const SOURCES = [
  { id: 1, documentId: 1, documentTitle: 'Harbor Inn Guest Guide', content: LONG, similarity: 0.612, foundBy: 'keyword' },
  { id: 2, documentId: 1, documentTitle: 'Harbor Inn Guest Guide', content: 'Pets are welcome.', similarity: 0.471, foundBy: 'both' },
];

const { data: harbor } = await supabase.from('tenants').select('id').eq('slug', 'harbor').single();
let userId;
let browser;
try {
  const email = `ui-comp6-${Date.now()}@example.com`;
  const password = randomBytes(18).toString('base64url');
  const { data, error } = await supabase.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(error.message);
  userId = data.user.id;
  const m = await supabase.from('memberships').insert({ user_id: userId, tenant_id: harbor.id, role: 'owner' });
  if (m.error) throw new Error(m.error.message);
  const r = await fetch(`${BASE}/api/t/harbor/admin/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
  const cookie = (r.headers.getSetCookie?.() ?? []).find((x) => x.startsWith('rag_admin='))?.split(';')[0]?.slice('rag_admin='.length);
  if (!cookie) throw new Error('login failed');

  browser = await openBrowser({ scheme: 'light' });
  const { page } = browser;
  const writes = [];
  await page.send('Fetch.enable', { patterns: [{ urlPattern: '*/api/*' }] });
  page.on('Fetch.requestPaused', (p) => {
    const path = new URL(p.request.url).pathname;
    if (path === '/api/t/harbor/chat')
      return void page.send('Fetch.fulfillRequest', { requestId: p.requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'text/event-stream' }], body: Buffer.from(sse([['meta', { conversationId: '00000000-0000-4000-8000-000000000006', sources: SOURCES, searchQuery: 'check-in' }], ['delta', { text: 'Check-in is from 2 PM. 🙂' }], ['done', {}]])).toString('base64') });
    if (p.request.method !== 'GET') {
      writes.push(`${p.request.method} ${path}`);
      return void page.send('Fetch.fulfillRequest', { requestId: p.requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'application/json' }], body: Buffer.from('{}').toString('base64') });
    }
    void page.send('Fetch.continueRequest', { requestId: p.requestId });
  });
  await page.send('Network.setCookie', { name: 'rag_admin', value: cookie, url: `${BASE}/api/t/harbor/`, path: '/api/t/harbor' });
  await page.viewport(1280);

  // 1. Promos: the keyboard sees the tip; Escape hides it; aria-hidden.
  await page.goto(`${BASE}/t/harbor/admin/promos`);
  await page.until("!!document.querySelector('.list-row-actions .tip button')", 30000);
  const target = '.list-row-actions .tip button';
  let reached = false;
  for (let i = 0; i < 60 && !reached; i++) {
    await page.tab();
    reached = await page.eval(`document.activeElement === document.querySelector(${JSON.stringify(target)})`);
  }
  await sleep(300);
  const tipText = await page.eval(`document.querySelector(${JSON.stringify(target)}).closest('.tip').querySelector('.tip-text')`);
  check(reached && (await page.eval(tipShown(target))) === true, '1. Tab onto the first icon button shows its tip', await page.eval(`document.querySelector(${JSON.stringify(target)}).closest('.tip').textContent.trim()`));
  check((await page.eval(`document.querySelector(${JSON.stringify(target)}).closest('.tip').querySelector('.tip-text').getAttribute('aria-hidden')`)) === 'true', '1b. it is aria-hidden: the button\'s own label already says it');
  await page.key('Escape', 'Escape', 27);
  await sleep(300);
  check((await page.eval(tipShown(target))) === false, '1c. Escape hides it, focus staying put', String(await page.eval(`document.activeElement === document.querySelector(${JSON.stringify(target)})`)));
  await page.shot(join(OUT, 'promos-tip-dismissed-1280.png'));

  // 2. The mouse: hover shows it; moving onto the tip keeps it.
  await page.eval('document.activeElement.blur()');
  const at = await page.eval(centre(target));
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at.x, y: at.y });
  await sleep(300);
  check((await page.eval(tipShown(target))) === true, '2. hover shows the tip');
  await page.shot(join(OUT, 'promos-tip-hover-1280.png'));
  const tipAt = await page.eval(`(() => { const r = document.querySelector(${JSON.stringify(target)}).closest('.tip').querySelector('.tip-text').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + 6 }; })()`);
  for (let step = 1; step <= 5; step++) await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at.x + ((tipAt.x - at.x) * step) / 5, y: at.y + ((tipAt.y - at.y) * step) / 5 });
  await sleep(300);
  check((await page.eval(tipShown(target))) === true, '2b. moving the pointer onto the tip keeps it (hoverable)');
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 890 });

  // 3. No `title` on an HTML element on any staff screen.
  const titled = [];
  for (const path of ['/admin', '/admin/promos', '/admin/slots', '/admin/holidays', '/admin/accommodations', '/admin/members', '/admin/bookings']) {
    await page.goto(`${BASE}/t/harbor${path}`);
    await page.until("!!document.querySelector('.staff-content h1')", 30000);
    await sleep(1500);
    const found = await page.eval("[...document.querySelectorAll('.staff-content [title]')].filter(e => !(e instanceof SVGElement)).map(e => e.tagName + ':' + e.getAttribute('title'))");
    titled.push(...found.map((x) => `${path} ${x}`));
  }
  check(titled.length === 0, '3. no HTML element carries a native title on the seven staff screens', titled.join(', ') || 'none');

  // 4. Bookings (still open): the legend, and a chip's tip on hover.
  await page.until("!!document.querySelector('.day .tip .slot-chip')", 30000);
  const legend = await page.eval("document.querySelector('.slot-legend')?.textContent ?? ''");
  check(/open.*free to book.*taken.*overlaps a booking.*closed.*Holidays screen/s.test(legend), '4. the legend says what open, taken and closed mean', legend.replace(/\s+/g, ' ').trim());
  const chip = await page.eval(centre('.day .tip .slot-chip'));
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: chip.x, y: chip.y });
  await sleep(300);
  check((await page.eval(tipShown('.day .tip .slot-chip'))) === true, "4b. a chip's reason shows on hover", await page.eval("document.querySelector('.day .tip .tip-text').textContent"));
  await page.shot(join(OUT, 'bookings-legend-1280.png'));

  // 5. The chat: the badge's tip, "Show all".
  await page.send('Network.clearBrowserCookies');
  await page.goto(`${BASE}/t/harbor`);
  await page.until("!!document.querySelector('.composer')", 30000);
  await page.type('#input', 'What time is check-in?');
  await page.key('Enter', 'Enter', 13);
  await page.until("!document.querySelector('.bubble.thinking') && !!document.querySelector('.sources summary')", 15000);
  await page.click('.sources summary');
  await sleep(300);
  const badge = await page.eval("(() => { const b = document.querySelector('.source-found'); const tip = document.getElementById(b.getAttribute('aria-describedby')); return { tab: b.tabIndex, describedBy: tip?.textContent ?? null }; })()");
  check(badge.tab === 0 && badge.describedBy === 'Found by exact keyword match — vector search missed this', '5. the "found by" badge is focusable and its tip describes it', JSON.stringify(badge));
  const buttons = await page.eval("[...document.querySelectorAll('.source')].map(s => s.querySelector('.source-more')?.textContent ?? null)");
  check(buttons[0] === 'Show all' && buttons[1] === null, '5b. the clipped chunk has "Show all"; the short one has none', JSON.stringify(buttons));
  await page.click('.source-more');
  await sleep(200);
  const opened = await page.eval("(() => { const b = document.querySelector('.source-more'); const p = b.previousElementSibling; return { label: b.textContent, expanded: b.getAttribute('aria-expanded'), clamped: p.classList.contains('truncated') }; })()");
  check(opened.label === 'Show less' && opened.expanded === 'true' && !opened.clamped, '5c. "Show all" opens the chunk and says so', JSON.stringify(opened));
  await page.shot(join(OUT, 'sources-1280.png'));
  check(writes.length === 0, '6. nothing written', writes.join(', ') || 'none');
} finally {
  browser?.close();
  if (userId) await supabase.auth.admin.deleteUser(userId);
}

console.log(`\n${failures === 0 ? 'all passed' : `${failures} FAILED`}`);
process.exit(failures ? 1 : 0);
