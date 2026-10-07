// ui-components-phase5-walk.mjs — the platform tenant form's tabs in a real
// browser, against a running dev server (plan/ui-components.md Phase 5):
// four tabs, Profile first; a colour typed in Profile survives a visit to
// Members (every panel stays mounted, trap 6); ←/→/Home/End move the
// selection and the focus; Tab goes from the tab to its panel; Save still
// posts the profile's seven keys with the typed colour; a phone does not
// scroll sideways.
//
// One throwaway super user, deleted at the end. Nothing is changed: every
// non-GET is caught in the browser and answered there.
//
//   (cd packages/db && node --conditions=react-server --env-file=../../.env ../../plan/ui-components-phase5-walk.mjs [base-url])

import { randomBytes } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { supabase } from '../packages/db/dist/service.js';
import { openBrowser } from './ui-refresh-cdp.mjs';

const BASE = process.argv[2] ?? 'http://localhost:3000';
const OUT = join(dirname(fileURLToPath(import.meta.url)), 'ui-refresh', 'components-5', 'walk');
let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const type = (selector, value) =>
  `(() => { const el = document.querySelector(${JSON.stringify(selector)}); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event('input', { bubbles: true })); })()`;
const state = `(() => {
  const tabs = [...document.querySelectorAll('[role=tab]')];
  const sel = tabs.find(t => t.getAttribute('aria-selected') === 'true');
  const panel = sel && document.getElementById(sel.getAttribute('aria-controls'));
  return {
    labels: tabs.map(t => t.textContent),
    selected: sel?.textContent ?? null,
    focused: document.activeElement?.getAttribute('role') === 'tab' ? document.activeElement.textContent : document.activeElement?.getAttribute('role'),
    inTabOrder: tabs.filter(t => t.tabIndex === 0).map(t => t.textContent),
    visiblePanels: [...document.querySelectorAll('[role=tabpanel]')].filter(p => !p.hidden).length,
    labelled: panel?.getAttribute('aria-labelledby') === sel?.id,
  };
})()`;
const clickTab = (label) => `[...document.querySelectorAll('[role=tab]')].find(t => t.textContent === ${JSON.stringify(label)}).click()`;

const { data: harbor } = await supabase.from('tenants').select('id').eq('slug', 'harbor').single();
let userId;
let browser;
try {
  const email = `ui-comp5-${Date.now()}@example.com`;
  const password = randomBytes(18).toString('base64url');
  const { data, error } = await supabase.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(error.message);
  userId = data.user.id;
  const pa = await supabase.from('platform_admins').insert({ user_id: userId });
  if (pa.error) throw new Error(pa.error.message);
  const r = await fetch(`${BASE}/api/platform/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
  const cookie = (r.headers.getSetCookie?.() ?? []).find((x) => x.startsWith('rag_platform='))?.split(';')[0]?.slice('rag_platform='.length);
  if (!cookie) throw new Error('login failed');
  const detail = await (await fetch(`${BASE}/api/platform/tenants/${harbor.id}`, { headers: { cookie: `rag_platform=${cookie}` } })).text();

  browser = await openBrowser({ scheme: 'light' });
  const { page } = browser;
  const writes = [];
  await page.send('Fetch.enable', { patterns: [{ urlPattern: '*/api/*' }] });
  page.on('Fetch.requestPaused', (p) => {
    if (p.request.method === 'GET') return void page.send('Fetch.continueRequest', { requestId: p.requestId });
    writes.push({ method: p.request.method, path: new URL(p.request.url).pathname, body: p.request.postData ? JSON.parse(p.request.postData) : null });
    void page.send('Fetch.fulfillRequest', { requestId: p.requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'application/json' }], body: Buffer.from(detail).toString('base64') });
  });
  await page.send('Network.setCookie', { name: 'rag_platform', value: cookie, url: `${BASE}/api/platform/`, path: '/api/platform' });

  for (const width of [1280, 375]) {
    await page.viewport(width);
    await page.goto(`${BASE}/platform`);
    await page.until("!!document.querySelector('.member-row')", 30000);
    await page.eval("[...document.querySelectorAll('.member-row')].find(r => r.textContent.includes('/t/harbor')).querySelector('button').click()");
    await page.until("!!document.querySelector('#theme-accent') && !!document.querySelector('[role=tab]')", 15000);
    if (width === 375) {
      const wide = await page.eval('document.documentElement.scrollWidth');
      check(wide <= 375, '7. a phone: the tabs do not widen the page', `${wide}px`);
      await page.shot(join(OUT, 'tabs-375.png'));
      break;
    }

    // 1. Four tabs, Profile selected, one panel shown, labelled by its tab.
    const s0 = await page.eval(state);
    check(s0.labels.join('|') === 'Profile|Applications|Members|Archive' && s0.selected === 'Profile' && s0.visiblePanels === 1 && s0.labelled && s0.inTabOrder.join() === 'Profile', '1. four tabs, Profile selected, one panel, labelled; only the selected tab in the Tab order', JSON.stringify(s0));
    await page.shot(join(OUT, 'profile-1280.png'));

    // 2. A typed colour survives a visit to Members.
    await page.eval(type('#theme-accent', '#123456'));
    await page.eval(clickTab('Members'));
    await sleep(150);
    const onMembers = await page.eval("({ members: !!document.querySelector('[role=tabpanel]:not([hidden]) .member-row, [role=tabpanel]:not([hidden]) input[type=email]'), accentHidden: !!document.querySelector('#theme-accent')?.closest('[hidden]') })");
    check(onMembers.members && onMembers.accentHidden, '2. Members shows the members panel; Profile is hidden, not gone', JSON.stringify(onMembers));
    await page.shot(join(OUT, 'members-1280.png'));
    await page.eval(clickTab('Profile'));
    await sleep(150);
    check((await page.eval("document.querySelector('#theme-accent').value")) === '#123456', '2b. back on Profile, the typed colour is still there');

    // 3. The keyboard: arrows, Home, End, wrap-around; Tab into the panel.
    await page.eval("document.querySelector('[role=tab][aria-selected=true]').focus()");
    await page.key('ArrowRight', 'ArrowRight', 39);
    const s1 = await page.eval(state);
    await page.key('End', 'End', 35);
    const s2 = await page.eval(state);
    await page.key('ArrowRight', 'ArrowRight', 39);
    const s3 = await page.eval(state);
    await page.key('ArrowLeft', 'ArrowLeft', 37);
    await page.key('Home', 'Home', 36);
    const s4 = await page.eval(state);
    check(
      s1.selected === 'Applications' && s1.focused === 'Applications' && s2.selected === 'Archive' && s3.selected === 'Profile' && s4.selected === 'Profile' && s4.focused === 'Profile',
      '3. → Applications, End → Archive, → wraps to Profile, Home → Profile; focus follows',
      [s1, s2, s3, s4].map((s) => `${s.selected}/${s.focused}`).join(' '),
    );
    await page.tab();
    check((await page.eval("document.activeElement?.getAttribute('role')")) === 'tabpanel', '3b. Tab from the tab goes to its panel, not to the next tab');

    // 4. Save posts the profile's seven keys, with the typed colour.
    await page.eval("[...document.querySelectorAll('[role=tabpanel]:not([hidden]) form button[type=submit]')][0].click()");
    await page.until("!!document.querySelector('.toast.ok')", 5000);
    const save = writes.find((w) => w.method === 'PATCH' && w.path === `/api/platform/tenants/${harbor.id}`);
    const keys = save ? Object.keys(save.body).sort().join(',') : 'none';
    check(keys === 'assistantName,bannerUrl,businessName,fallbackMessages,logoUrl,suggestedQuestions,theme' && save.body.theme.accent === '#123456', '4. Save posts the same seven keys, the typed colour in the theme', keys);

    // 5. Applications and Archive still work from their tabs (caught).
    await page.eval(clickTab('Archive'));
    await sleep(150);
    const archiveButton = await page.eval("[...document.querySelectorAll('[role=tabpanel]:not([hidden]) button')].map(b => b.textContent).join('|')");
    check(/Archive|Unarchive/.test(archiveButton), '5. the Archive tab holds the archive button', archiveButton);
    check(writes.length === 1, '6. one write in all, the caught PATCH', writes.map((w) => `${w.method} ${w.path}`).join(', '));
  }
} finally {
  browser?.close();
  if (userId) {
    await supabase.from('platform_admins').delete().eq('user_id', userId);
    await supabase.auth.admin.deleteUser(userId);
  }
}

console.log(`\n${failures === 0 ? 'all passed' : `${failures} FAILED`}`);
process.exit(failures ? 1 : 0);
