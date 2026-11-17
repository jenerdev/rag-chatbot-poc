// Audit E-8 to E-14 (D-179, D-180): the guest pages' smaller UX items, in
// Chrome, against pnpm dev. No OpenAI call (the chat's message is a
// greeting, answered in code); nothing is booked.
//
//   (cd packages/db && node --conditions=react-server --env-file=../../.env ../../plan/guest-ux-walk.mjs)
//
//  8. With touch emulated (pointer: coarse): the booking page's buttons and
//     fields are >= 44 px, the consent checkbox 22 px in a >= 44 px row, the
//     footer links >= 44 px; the chat's Send and fine-print links >= 44 px.
//  9. On touch the chat's composer is not focused on arrival; with a mouse it is.
// 10. A chat survives a reload (sessionStorage), and New chat clears it.
// 12. A room checkbox (alteza) is named by the room's name alone, and
//     described by its facts, price and description.
// 13. One <h1> on the booking page, Manage booking, a privacy page and the chat.
// 14. The slot field says "Type of stay"; /favicon.ico redirects to the icon;
//     "Staff login" is quieter than the guest links; the chat links' "·" has
//     empty alt text.
import { openBrowser } from './ui-refresh-cdp.mjs';

const BASE = process.env.WALK_BASE ?? 'http://localhost:3000';
let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const headers = { 'X-Forwarded-For': `198.27.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` };

let browser;
try {
  browser = await openBrowser({ scheme: 'light' });
  const { page } = browser;
  await page.send('Network.setExtraHTTPHeaders', { headers });
  const touch = async (on) => {
    await page.send('Emulation.setTouchEmulationEnabled', { enabled: on, maxTouchPoints: on ? 5 : 0 });
    await page.send('Emulation.setEmitTouchEventsForMouse', { enabled: on });
    await page.send('Emulation.setDeviceMetricsOverride', { width: on ? 390 : 1280, height: on ? 812 : 900, deviceScaleFactor: 1, mobile: on });
  };

  // 8. Touch, the booking page through to its Review step's controls.
  await touch(true);
  await page.goto(`${BASE}/t/villa/book`);
  await page.until("!!document.querySelector('.date-trigger')", 30000);
  await sleep(800);
  const coarse = await page.eval("matchMedia('(pointer: coarse)').matches");
  const bookSizes = await page.eval(`(() => {
    const h = (el) => el ? Math.round(el.getBoundingClientRect().height) : null;
    const visible = (el) => el.offsetParent !== null;
    const buttons = [...document.querySelectorAll('main button:not(.link)')].filter(visible).map(h);
    const fields = [...document.querySelectorAll('main input:not([type=checkbox]):not([type=radio]):not(.date-native), main select, main .date-trigger')].filter(visible).map(h);
    const footer = [...document.querySelectorAll('.public-footer nav a')].map(h);
    return { buttons: Math.min(...buttons), fields: Math.min(...fields), footer: Math.min(...footer) };
  })()`);
  check(coarse && bookSizes.buttons >= 44 && bookSizes.fields >= 44 && bookSizes.footer >= 44,
    '8a. touch: the booking page\'s buttons, fields and footer links are >= 44 px', `coarse ${coarse} · ${JSON.stringify(bookSizes)}`);

  // 14a. The slot field's label, on the same page.
  const slotLabel = await page.eval("document.querySelector('label[for=slot]')?.textContent.trim() ?? null");
  check(slotLabel === 'Type of stay', '14a. the slot field says "Type of stay"', JSON.stringify(slotLabel));

  // 13a. One h1 on the booking page.
  const bookH1 = await page.eval("[...document.querySelectorAll('h1')].map((h) => h.textContent.trim())");
  check(bookH1.length === 1, '13a. one <h1> on the booking page', JSON.stringify(bookH1));

  // 14c. Staff login quieter than the guest links.
  const footer = await page.eval(`(() => { const staff = document.querySelector('.public-footer a.footer-staff'); const guest = [...document.querySelectorAll('.public-footer nav a')].find((a) => !a.classList.contains('footer-staff'));
    return { staff: staff ? parseFloat(getComputedStyle(staff).fontSize) : null, guest: guest ? parseFloat(getComputedStyle(guest).fontSize) : null }; })()`);
  check(footer.staff !== null && footer.staff < footer.guest, '14c. "Staff login" is smaller than the guest links', JSON.stringify(footer));

  // 8b. The consent row on the Review step (touch).
  const setValue = (selector, value) => `(() => { const i = document.querySelector('${selector}'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, ${JSON.stringify(String(value))}); i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`;
  const day = await page.eval("(() => { const i = document.querySelector('input[type=date]'); const d = new Date(i.min + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + 11); return d.toISOString().slice(0, 10); })()");
  await page.eval(setValue('input[type=date]', day));
  const next = async () => {
    await page.until("[...document.querySelectorAll('button')].some(b => b.textContent.trim().startsWith('Continue') && b.offsetParent !== null)", 15000);
    await page.eval("[...document.querySelectorAll('button')].find(b => b.textContent.trim().startsWith('Continue') && b.offsetParent !== null).click(); true");
    await sleep(700);
  };
  await next();
  await page.eval(`(() => { const i = [...document.querySelectorAll('input[type=number]')].find(x => x.offsetParent !== null); if (i && !i.value) { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, '2'); i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new Event('change', { bubbles: true })); } return true; })()`);
  await next();
  await page.until("!!document.querySelector('#name') && document.querySelector('#name').offsetParent !== null", 15000);
  await page.type('#name', 'UX Walker');
  await page.type('#phone', '0917 555 0181');
  await page.type('#email', 'ux-walker@example.com');
  await next();
  await page.until("!!document.querySelector('#book-consent') && document.querySelector('#book-consent').offsetParent !== null", 20000);
  const consent = await page.eval("({ box: Math.round(document.querySelector('#book-consent').getBoundingClientRect().width), row: Math.round(document.querySelector('.consent-check').getBoundingClientRect().height) })");
  check(consent.box === 22 && consent.row >= 44, '8b. touch: the consent checkbox is 22 px in a row >= 44 px tall', JSON.stringify(consent));

  // 13b. Manage booking and a privacy page.
  for (const path of ['/t/villa/manage', '/t/villa/privacy']) {
    await page.goto(`${BASE}${path}`);
    await sleep(800);
    const h1 = await page.eval("[...document.querySelectorAll('h1')].map((h) => h.textContent.trim())");
    check(h1.length === 1, `13b. one <h1> on ${path}`, JSON.stringify(h1));
  }

  // 9a, 8c, 13c, 14d. The chat on touch.
  await page.goto(`${BASE}/t/villa`);
  await page.until("!!document.querySelector('textarea')", 30000);
  await sleep(1000);
  const chatTouch = await page.eval(`(() => {
    const h = (el) => el ? Math.round(el.getBoundingClientRect().height) : null;
    const links = [...document.querySelectorAll('.composer-links a')];
    const dot = links[1] ? getComputedStyle(links[1], '::before').content : null;
    return { focused: document.activeElement?.tagName ?? null, send: h(document.querySelector('.composer-send')), links: links.length ? Math.min(...links.map(h)) : null, h1: document.querySelectorAll('h1').length, dot };
  })()`);
  check(chatTouch.focused !== 'TEXTAREA', '9a. touch: the chat\'s composer is not focused on arrival (no keyboard over the welcome)', JSON.stringify(chatTouch.focused));
  check(chatTouch.send >= 44 && (chatTouch.links === null || chatTouch.links >= 44), '8c. touch: the chat\'s Send and its links are >= 44 px', JSON.stringify({ send: chatTouch.send, links: chatTouch.links }));
  check(chatTouch.h1 === 1, '13c. one <h1> on the chat', String(chatTouch.h1));
  check(chatTouch.dot === null || chatTouch.dot.includes('/ ""'), '14d. the chat links\' "·" has empty alt text (not read aloud)', JSON.stringify(chatTouch.dot));

  // 10. A greeting, a reload, the chat is still there; New chat clears it.
  await page.type('textarea', 'Hello');
  await page.eval("document.querySelector('textarea').closest('form').requestSubmit(); true");
  await page.until("document.querySelectorAll('.bubble').length >= 2 && !document.querySelector('.bubble.thinking')", 30000);
  await sleep(1200);
  const before = await page.eval("document.querySelectorAll('.bubble').length");
  await page.goto(`${BASE}/t/villa`);
  await page.until("!!document.querySelector('textarea')", 30000);
  await sleep(1200);
  const after = await page.eval("({ bubbles: document.querySelectorAll('.bubble').length, kept: !!sessionStorage.getItem('rag-chat:villa') })");
  await page.eval("document.querySelector('.chat-new')?.click(); true");
  await sleep(600);
  const cleared = await page.eval("({ bubbles: document.querySelectorAll('.bubble').length, kept: !!sessionStorage.getItem('rag-chat:villa') })");
  check(before >= 2 && after.bubbles === before && after.kept && cleared.bubbles === 0 && !cleared.kept,
    '10. the chat survives a reload; New chat clears it', `before ${before} · after ${JSON.stringify(after)} · new chat ${JSON.stringify(cleared)}`);

  // 9b. With a mouse, the composer is focused on arrival. In a FRESH
  // browser: switching touch emulation off in the same session does not give
  // "pointer: fine" back.
  {
    const mouseBrowser = await openBrowser({ scheme: 'light' });
    try {
      const mp = mouseBrowser.page;
      await mp.viewport(1280);
      await mp.goto(`${BASE}/t/villa`);
      await mp.until("!!document.querySelector('textarea')", 30000);
      await sleep(1000);
      const mouse = await mp.eval("({ fine: matchMedia('(pointer: fine)').matches, focused: document.activeElement?.tagName ?? null })");
      check(mouse.fine && mouse.focused === 'TEXTAREA', '9b. with a mouse, the composer is focused on arrival', JSON.stringify(mouse));
    } finally {
      mouseBrowser.close();
    }
  }

  // 12. alteza's room checkboxes.
  await page.goto(`${BASE}/t/alteza/book`);
  await page.until("!!document.querySelector('input[type=date]')", 30000);
  await sleep(1000);
  const nightly = await page.eval("[...document.querySelectorAll('select option')].find((o) => /overnight/i.test(o.textContent))?.value ?? null");
  if (nightly) await page.eval(`(() => { const s = document.querySelector('select'); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(s, ${JSON.stringify(nightly)}); s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  const altDay = await page.eval("(() => { const i = document.querySelector('input[type=date]'); const d = new Date(i.min + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + 7); return d.toISOString().slice(0, 10); })()");
  await page.eval(setValue('input[type=date]', altDay));
  await next();
  await page.until("document.querySelectorAll('.room-pick input[type=checkbox]').length > 0 && document.querySelectorAll('.room-pick-price').length > 0", 20000);
  const names = await page.eval(`[...document.querySelectorAll('.room-pick input[type=checkbox]')].map((box) => {
    const ids = (attr) => (box.getAttribute(attr) ?? '').split(' ').filter(Boolean);
    const text = (attr) => ids(attr).map((id) => document.getElementById(id)?.textContent.trim() ?? '<missing ' + id + '>').join(' | ');
    return { name: text('aria-labelledby'), described: text('aria-describedby'), roomName: box.closest('.room-pick').querySelector('.room-pick-name').textContent.trim() };
  })`);
  check(names.length > 0 && names.every((n) => n.name === n.roomName && n.described.length > 0 && !n.described.includes('<missing')),
    '12. each room checkbox is named by the room alone and described by the rest', names.map((n) => `${n.name} ⟵ ${n.described.slice(0, 50)}`).join(' || '));
} catch (error) {
  check(false, 'walk', error.message);
} finally {
  browser?.close();
}

// 14b. The favicon, over HTTP.
const fav = await fetch(`${BASE}/favicon.ico`, { redirect: 'manual' });
check(fav.status === 308 && new URL(fav.headers.get('location') ?? '', BASE).pathname === '/icon.svg', '14b. /favicon.ico redirects to /icon.svg', `${fav.status} ${fav.headers.get('location')}`);

console.log(failures === 0 ? '\nALL GUEST UX WALK CHECKS PASS' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
