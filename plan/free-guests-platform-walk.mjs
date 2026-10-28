// free-guests-platform-walk.mjs — D-147 (plan/free-guests.md § 3.3), the
// platform form's field ON SCREEN, against pnpm dev. The HTTP side is
// free-guests-walk.mjs check 1; this is the browser side it left owed.
//
//   (cd packages/db && node --conditions=react-server --env-file=../../.env ../../plan/free-guests-platform-walk.mjs)
//
// A THROWAWAY super user and a THROWAWAY tenant with its DPA signed (villa's
// is unsigned, and the gate fires on the upsert: R-62), bookings switched on
// over HTTP; both removed at the end by the ids this run made (trap 26).
//   1. 1280: the tenant form's Applications tab draws "Children stay free up
//      to age" in Limits, empty, beside the hint; photographed.
//   2. typing 3 and Save config: the toast says saved, the record holds 3,
//      and a fresh page shows 3 in the field.
//   3. typing 18: the native control refuses it (max 17, D-142) and nothing
//      is sent; with the attribute removed, the server's refusal is the
//      toast, in the trigger's words, and the record still holds 3.
//   4. 375: the same field, photographed.
// Nothing reaches OpenAI.

import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { supabase } from '../packages/db/dist/service.js';
import { openBrowser } from './ui-refresh-cdp.mjs';

const BASE = process.argv[2] ?? 'http://localhost:3000';
const OUT = join(dirname(fileURLToPath(import.meta.url)), 'free-guests');
mkdirSync(OUT, { recursive: true });
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
const storedAge = async (tenantId) => {
  const { data } = await supabase.from('tenant_applications').select('config').eq('tenant_id', tenantId).eq('application_key', 'bookings').single();
  return data?.config?.free_up_to_age;
};

const stamp = Date.now();
const slug = `free-platform-${randomBytes(3).toString('hex')}`;
const NAME = `Free Field Resort ${randomBytes(2).toString('hex')}`;
let userId = null;
let tenantId = null;
let browser = null;
try {
  const email = `free-platform-${stamp}@example.com`;
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
  const on = await call('PUT', `/api/platform/tenants/${tenantId}/applications/bookings`, { cookie, json: { config: { timezone: 'Asia/Manila' } } });
  if (on.status !== 200) throw new Error(`bookings on ${on.status}: ${err(on)}`);

  browser = await openBrowser({ scheme: 'light' });
  const { page } = browser;
  await page.send('Network.setCookie', { name: 'rag_platform', value: cookie.slice('rag_platform='.length), url: `${BASE}/api/platform/`, path: '/api/platform' });

  /** /platform → this tenant → the Applications tab; the field scrolled to the middle. */
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
  /** The viewport only: the Limits section with what is around it. */
  async function shot(name) {
    const r = await page.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(OUT, name), Buffer.from(r.result.data, 'base64'));
  }
  const field = () =>
    page.eval(
      "(() => { const i = document.querySelector('#bk-free'); const l = document.querySelector('label[for=bk-free]'); const h = i.closest('.field').querySelector('.hint'); const r = i.getBoundingClientRect(); return { label: l?.textContent, value: i.value, placeholder: i.placeholder, min: i.min, max: i.max, hint: h?.textContent.slice(0, 40), width: Math.round(r.width), right: Math.round(r.right), vw: innerWidth }; })()",
    );
  const toasts = () => page.eval("[...document.querySelectorAll('.toast')].map(t => (t.className.includes('error') ? 'error: ' : 'ok: ') + t.querySelector('.toast-message')?.textContent)");
  async function setValue(v) {
    await page.eval("document.querySelector('#bk-free').select(); true");
    await page.type('#bk-free', v);
  }
  const submit = () => page.eval("document.querySelector('#bk-free').form.requestSubmit(); true");

  // 1
  await openField(1280);
  {
    const f = await field();
    await shot('platform-free-1280.png');
    check(f.label === 'Children stay free up to age' && f.value === '' && f.placeholder === 'none' && f.min === '0' && f.max === '17' && /3/.test(f.hint ?? ''),
      '1. 1280: the field in Limits, empty ("none"), 0–17, the hint under it (plan/free-guests/platform-free-1280.png)', JSON.stringify(f));
  }

  // 2
  {
    await setValue('3');
    await submit();
    await page.until("[...document.querySelectorAll('.toast-message')].some(t => /saved/i.test(t.textContent))", 15000);
    const said = await toasts();
    const stored = await storedAge(tenantId);
    await openField(1280);
    const f = await field();
    await shot('platform-free-3-1280.png');
    check(said.some((t) => t === 'ok: Bookings config saved.') && stored === 3 && f.value === '3',
      '2. 3 and Save config: the toast says saved, the record holds 3, a fresh page shows 3 (platform-free-3-1280.png)', `toasts ${JSON.stringify(said)} · stored ${JSON.stringify(stored)} · shown ${JSON.stringify(f.value)}`);
  }

  // 3
  {
    let sent = 0;
    page.on('Network.requestWillBeSent', (p) => { if (p.request.method === 'PUT' && p.request.url.includes('/applications/bookings')) sent++; });
    await setValue('18');
    const validity = await page.eval("(() => { const i = document.querySelector('#bk-free'); return { value: i.value, overflow: i.validity.rangeOverflow, message: i.validationMessage, invalid: i.matches(':invalid') }; })()");
    await page.eval("document.querySelector('#bk-free').form.reportValidity(); true");
    await submit();
    await sleep(1500);
    const sentNative = sent;
    await shot('platform-free-18-native-1280.png');
    // The server is still the guard: without the attribute, the form posts 18.
    await page.eval("document.querySelector('#bk-free').removeAttribute('max'); true");
    await submit();
    await page.until("[...document.querySelectorAll('.toast.error')].length > 0", 15000);
    const said = await toasts();
    await sleep(300);
    await shot('platform-free-18-refused-1280.png');
    const stored = await storedAge(tenantId);
    check(validity.overflow && validity.invalid && sentNative === 0 && sent === 1 && said.some((t) => /^error: .*free_up_to_age is a whole number of years from 0 to 17/.test(t)) && stored === 3,
      '3. 18: the native control refuses it and sends nothing; forced past it, the toast is the trigger\'s words; the record still 3 (platform-free-18-*-1280.png)',
      `validity ${JSON.stringify(validity)} · PUTs ${sentNative} then ${sent} · toasts ${JSON.stringify(said)} · stored ${JSON.stringify(stored)}`);
  }

  // 4
  {
    await openField(375);
    const f = await field();
    await shot('platform-free-375.png');
    check(f.value === '3' && f.right <= f.vw && f.width > 0, '4. 375: the field shows 3 and fits the width (platform-free-375.png)', JSON.stringify(f));
  }
} catch (error) {
  check(false, 'setup', error.message);
} finally {
  browser?.close();
  if (tenantId) await supabase.from('tenants').delete().eq('id', tenantId);
  if (userId) {
    await supabase.from('audit_log').delete().eq('actor_user', userId);
    await supabase.from('platform_admins').delete().eq('user_id', userId);
    await supabase.auth.admin.deleteUser(userId);
  }
}
console.log(failures ? `\n${failures} FAILED` : '\nfree-guests platform walk: all passed');
process.exit(failures ? 1 : 0);
