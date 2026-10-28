// free-guests-platform-edges-walk.mjs — QA (Quinn, docs/qa/free-guest-field.md):
// the edges of the platform form's "Children stay free up to age" field that
// free-guests-platform-walk.mjs left untested (Finn's M-006 item 3), against
// pnpm dev. Same throwaway shape: a super user and a tenant with its DPA
// signed and bookings on, both removed at the end by the ids this run made.
//
//   (cd packages/db && node --conditions=react-server --env-file=../../.env ../../plan/free-guests-platform-edges-walk.mjs)
//
//   E1. 0 saves and reads back 0 (the lower bound; "Infants under 1").
//   E2. 17 saves and reads back 17 (the upper bound).
//   E3. 3.5: the native control refuses it (step 1) and sends nothing; with
//       step removed, the server refuses it in words; the record still 17.
//   E4. -1: the native control refuses it (min 0) and sends nothing; with
//       min removed, the server refuses it in words; the record still 17.
//   E5. cleared and saved: the key LEAVES the config (absent = nobody free,
//       D-147), the other keys stay, a fresh page shows the empty field.
//   E6. dark mode at 1280: the field drawn, photographed, and axe (WCAG 2.x
//       A/AA + best practice) over the Applications tab in light and dark.
// Nothing reaches OpenAI. Shots go to plan/free-guests/qa-*.png.

import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { supabase } from '../packages/db/dist/service.js';
import { openBrowser } from './ui-refresh-cdp.mjs';

const BASE = process.argv[2] ?? 'http://localhost:3000';
const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, 'free-guests');
mkdirSync(OUT, { recursive: true });
const AXE = readFileSync(join(HERE, 'ui-refresh', 'axe', 'axe.min.js'), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
const check = (ok, what, detail = '') => {
  failures += ok ? 0 : 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? `  — ${detail}` : ''}`);
};
async function call(method, path, { cookie, json } = {}) {
  const headers = {};
  if (cookie) headers.Cookie = cookie;
  let body;
  if (json !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(json);
  }
  const response = await fetch(`${BASE}${path}`, { method, headers, body });
  const text = await response.text();
  let data = text;
  try {
    data = JSON.parse(text);
  } catch {
    // not JSON
  }
  const setCookie = (response.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]);
  return { status: response.status, data, cookie: setCookie.find((c) => c.startsWith('rag_')) };
}
const err = (r) => (typeof r.data === 'object' && r.data ? r.data.error : String(r.data).slice(0, 80));
const storedConfig = async (tenantId) => {
  const { data } = await supabase.from('tenant_applications').select('config').eq('tenant_id', tenantId).eq('application_key', 'bookings').single();
  return data?.config ?? null;
};

const stamp = Date.now();
const slug = `free-platform-qa-${randomBytes(3).toString('hex')}`;
const NAME = `Free Edge Resort ${randomBytes(2).toString('hex')}`;
let userId = null;
let tenantId = null;
const browsers = [];
try {
  const email = `free-platform-qa-${stamp}@example.com`;
  const password = randomBytes(18).toString('base64url');
  const { data: user, error: userError } = await supabase.auth.admin.createUser({ email, password, email_confirm: true });
  if (userError) throw new Error(`create user: ${userError.message}`);
  userId = user.user.id;
  const { error: superError } = await supabase.from('platform_admins').insert({ user_id: userId });
  if (superError) throw new Error(`platform_admins: ${superError.message}`);
  const login = await call('POST', '/api/platform/session', { json: { email, password } });
  if (login.status !== 200 || !login.cookie) throw new Error(`login ${login.status}: ${err(login)}`);
  const cookie = login.cookie;
  const created = await call('POST', '/api/platform/tenants', { cookie, json: { slug, businessName: NAME, assistantName: 'Fay' } });
  tenantId = created.data?.id ?? null;
  if (!tenantId) throw new Error(`create tenant ${created.status}: ${err(created)}`);
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Manila' });
  const signed = await call('PATCH', `/api/platform/tenants/${tenantId}`, { cookie, json: { dpaSignedOn: today } });
  if (signed.status !== 200) throw new Error(`sign the DPA ${signed.status}: ${err(signed)}`);
  const on = await call('PUT', `/api/platform/tenants/${tenantId}/applications/bookings`, { cookie, json: { config: { timezone: 'Asia/Manila', max_stay_nights: 7 } } });
  if (on.status !== 200) throw new Error(`bookings on ${on.status}: ${err(on)}`);

  async function session(scheme) {
    const browser = await openBrowser({ scheme });
    browsers.push(browser);
    const { page } = browser;
    await page.send('Network.setCookie', { name: 'rag_platform', value: cookie.slice('rag_platform='.length), url: `${BASE}/api/platform/`, path: '/api/platform' });
    let sent = 0;
    page.on('Network.requestWillBeSent', (p) => { if (p.request.method === 'PUT' && p.request.url.includes('/applications/bookings')) sent++; });
    async function openField(width) {
      await page.viewport(width);
      await page.goto(`${BASE}/platform`);
      if (!(await page.until(`[...document.querySelectorAll('.tenant-open')].some(b => b.textContent.trim() === ${JSON.stringify(NAME)})`, 30000))) throw new Error('the tenant is not listed');
      await page.eval(`[...document.querySelectorAll('.tenant-open')].find(b => b.textContent.trim() === ${JSON.stringify(NAME)}).click(); true`);
      if (!(await page.until("[...document.querySelectorAll('[role=tab]')].some(t => t.textContent.trim() === 'Applications')", 30000))) throw new Error('no Applications tab');
      await page.eval("[...document.querySelectorAll('[role=tab]')].find(t => t.textContent.trim() === 'Applications').click(); true");
      if (!(await page.until("!!document.querySelector('#bk-free') && document.querySelector('#bk-free').offsetParent !== null", 15000))) throw new Error('no #bk-free on screen');
      await page.eval("document.querySelector('#sec-limits').scrollIntoView({ block: 'start' }); window.scrollBy(0, -80); true");
      await sleep(300);
    }
    const shot = async (name) => {
      const r = await page.send('Page.captureScreenshot', { format: 'png' });
      writeFileSync(join(OUT, name), Buffer.from(r.result.data, 'base64'));
    };
    const value = () => page.eval("document.querySelector('#bk-free').value");
    const validity = () => page.eval("(() => { const i = document.querySelector('#bk-free'); const v = i.validity; return { value: i.value, under: v.rangeUnderflow, over: v.rangeOverflow, step: v.stepMismatch, bad: v.badInput, invalid: i.matches(':invalid'), message: i.validationMessage }; })()");
    const toastCount = () => page.eval("document.querySelectorAll('.toast').length");
    const toastsAfter = (n) => page.eval(`[...document.querySelectorAll('.toast')].slice(${n}).map(t => (t.className.includes('error') ? 'error: ' : 'ok: ') + t.querySelector('.toast-message')?.textContent)`);
    async function setValue(v) {
      await page.eval("document.querySelector('#bk-free').select(); true");
      await page.type('#bk-free', v);
    }
    async function clear() {
      // React's value setter, then an input event: what a user's delete does.
      await page.eval("(() => { const i = document.querySelector('#bk-free'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, ''); i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()");
    }
    const submit = () => page.eval("document.querySelector('#bk-free').form.requestSubmit(); true");
    async function axe(label) {
      await page.eval(AXE);
      const v = JSON.parse(await page.eval("axe.run(document, { runOnly: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'] }).then(r => JSON.stringify(r.violations.map(v => ({ id: v.id, impact: v.impact, nodes: v.nodes.length, sample: v.nodes[0]?.target?.join(' ') }))))"));
      return { label, violations: v };
    }
    return { page, openField, shot, value, validity, toastCount, toastsAfter, setValue, clear, submit, axe, sent: () => sent };
  }

  const light = await session('light');
  await light.openField(1280);

  /** Type a value, save, wait for a toast; returns what it said and what is stored. */
  async function saveValue(s, v) {
    const before = await s.toastCount();
    if (v === '') await s.clear();
    else await s.setValue(v);
    await s.submit();
    await s.page.until(`document.querySelectorAll('.toast').length > ${before}`, 15000);
    await sleep(300);
    return { said: await s.toastsAfter(before), config: await storedConfig(tenantId) };
  }

  // E1, E2: the bounds
  for (const [id, v] of [['E1', '0'], ['E2', '17']]) {
    const r = await saveValue(light, v);
    await light.openField(1280);
    const shown = await light.value();
    check(r.said.includes('ok: Bookings config saved.') && r.config?.free_up_to_age === Number(v) && shown === v,
      `${id}. ${v} saves, the record holds ${v}, a fresh page shows ${v}`, `toasts ${JSON.stringify(r.said)} · stored ${JSON.stringify(r.config?.free_up_to_age)} · shown ${JSON.stringify(shown)}`);
  }

  // E3, E4: refused natively, then by the server
  for (const [id, v, attr, flag] of [['E3', '3.5', 'step', 'step'], ['E4', '-1', 'min', 'under']]) {
    await light.openField(1280);
    const sentBefore = light.sent();
    await light.setValue(v);
    const val = await light.validity();
    await light.submit();
    await sleep(1500);
    const sentNative = light.sent() - sentBefore;
    await light.shot(`qa-free-${id === 'E3' ? 'decimal' : 'negative'}-native-1280.png`);
    // A number input with no step attribute still steps by 1, so the decimal
    // bypass is step="any"; the negative one is min removed.
    await light.page.eval(attr === 'step' ? "document.querySelector('#bk-free').setAttribute('step', 'any'); true" : `document.querySelector('#bk-free').removeAttribute('${attr}'); true`);
    const before = await light.toastCount();
    await light.submit();
    await light.page.until(`document.querySelectorAll('.toast').length > ${before}`, 15000);
    await sleep(300);
    const said = await light.toastsAfter(before);
    const sentForced = light.sent() - sentBefore - sentNative;
    const config = await storedConfig(tenantId);
    check(val[flag] && val.invalid && sentNative === 0 && sentForced === 1 && said.some((t) => /^error: .*free_up_to_age is a whole number of years from 0 to 17/.test(t)) && config?.free_up_to_age === 17,
      `${id}. ${v}: the native control refuses it (${flag}) and sends nothing; forced, the server refuses it in words; the record still 17`,
      `validity ${JSON.stringify(val)} · PUTs ${sentNative} then ${sentForced} · toasts ${JSON.stringify(said)} · stored ${JSON.stringify(config?.free_up_to_age)}`);
  }

  // E5: cleared
  {
    await light.openField(1280);
    const r = await saveValue(light, '');
    await light.openField(1280);
    const shown = await light.value();
    await light.shot('qa-free-cleared-1280.png');
    const hasKey = r.config ? Object.prototype.hasOwnProperty.call(r.config, 'free_up_to_age') : null;
    check(r.said.includes('ok: Bookings config saved.') && hasKey === false && r.config?.timezone === 'Asia/Manila' && r.config?.max_stay_nights === 7 && shown === '',
      'E5. cleared and saved: the key leaves the config, timezone and max stay stay, a fresh page shows the field empty',
      `toasts ${JSON.stringify(r.said)} · config ${JSON.stringify(r.config)} · shown ${JSON.stringify(shown)}`);
  }

  // E6: dark mode and axe, with 3 in the field
  {
    await saveValue(light, '3');
    await light.openField(1280);
    const axeLight = await light.axe('light 1280');
    const dark = await session('dark');
    await dark.openField(1280);
    const look = await dark.page.eval("(() => { const i = document.querySelector('#bk-free'); const s = getComputedStyle(i); const b = getComputedStyle(document.body); return { value: i.value, color: s.color, background: s.backgroundColor, body: b.backgroundColor, scheme: document.documentElement.getAttribute('data-scheme') ?? matchMedia('(prefers-color-scheme: dark)').matches }; })()");
    await dark.shot('qa-free-dark-1280.png');
    const axeDark = await dark.axe('dark 1280');
    await dark.openField(375);
    const axeDark375 = await dark.axe('dark 375');
    await dark.shot('qa-free-dark-375.png');
    const all = [axeLight, axeDark, axeDark375];
    const total = all.reduce((n, a) => n + a.violations.length, 0);
    check(look.value === '3' && look.color !== look.background && total === 0,
      'E6. dark mode: the field drawn with 3 (qa-free-dark-1280.png, -375); axe over the Applications tab, light 1280, dark 1280, dark 375: 0 violations',
      `${JSON.stringify(look)} · ${all.map((a) => `${a.label}: ${a.violations.length}${a.violations.length ? ' ' + JSON.stringify(a.violations) : ''}`).join(' · ')}`);
  }
} catch (error) {
  check(false, 'setup', error.message);
} finally {
  for (const b of browsers) b.close();
  if (tenantId) await supabase.from('tenants').delete().eq('id', tenantId);
  if (userId) {
    await supabase.from('audit_log').delete().eq('actor_user', userId);
    await supabase.from('platform_admins').delete().eq('user_id', userId);
    await supabase.auth.admin.deleteUser(userId);
  }
  const { count: leftT } = await supabase.from('tenants').select('id', { count: 'exact', head: true }).like('slug', 'free-platform-qa-%');
  console.log(`after: ${leftT ?? '?'} tenants left by the free-platform-qa- prefix`);
}
console.log(failures ? `\n${failures} FAILED` : '\nfree-guests platform edges walk: all passed');
process.exit(failures ? 1 : 0);
