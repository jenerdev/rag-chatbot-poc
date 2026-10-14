// legal-walk.mjs — the legal groundwork (D-129 – D-131) in a browser,
// against pnpm dev (plan/legal.md § 7).
//
// On a THROWAWAY tenant (`legal-walk-…`, deleted at the end with everything
// it owns): bookings on, one priced unit and slot. A throwaway SUPER USER
// fills the platform form's Legal tab.
//   1. the Legal tab saves the DPA date and the privacy contact ("Legal
//      details saved."), and the privacy page then names that contact;
//   2. the chat's notice says AI, saved, staff, OpenAI, and links Privacy
//      and Terms, both 200;
//   3. the booking page's last step: the consent box is unticked and Send
//      is off; ticked, Send is on; sent, the receipt shows and the stay in
//      the database records the policy version and when;
//   4. the booking page's footer links Privacy and Terms;
//   5. the platform's /privacy and /terms answer, linked from the landing page;
//   6. axe, 0 violations, at 1280 and 375, light and dark, over the
//      privacy page, the terms page, the booking page's consent step, the
//      chat, the Legal tab and the platform's privacy page (24 states).
//
//   (cd packages/db && node --conditions=react-server --env-file=../../.env ../../plan/legal-walk.mjs)

import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { supabase } from '../packages/db/dist/service.js';
import { openBrowser } from './ui-refresh-cdp.mjs';

const BASE = 'http://localhost:3000';
const HERE = dirname(fileURLToPath(import.meta.url));
const AXE = readFileSync(join(HERE, 'ui-refresh', 'axe', 'axe.min.js'), 'utf8');
const SHOTS = join(HERE, 'legal');
mkdirSync(SHOTS, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (ok, label, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
};

const users = [];
let tenantId = null;
let browser;
let audited = 0;
const found = [];
const slug = `legal-walk-${randomBytes(3).toString('hex')}`;
const NAME = 'Legal Walk Resort';
try {
  const { data: t, error } = await supabase.from('tenants').insert({ slug, business_name: NAME, assistant_name: 'Lex' }).select('id').single();
  if (error) throw new Error(`tenant: ${error.message}`);
  tenantId = t.id;
  const app = await supabase.from('tenant_applications').insert({ tenant_id: tenantId, application_key: 'bookings', config: { timezone: 'Asia/Manila' } });
  if (app.error) throw new Error(`application: ${app.error.message}`);
  const { data: unit } = await supabase.from('units').insert({ tenant_id: tenantId, name: 'Whole property', capacity: 10, sort_order: 1, active: true }).select('id').single();
  const { data: slot } = await supabase.from('slots').insert({ tenant_id: tenantId, name: 'Overnight', start_time: '14:00', duration: '22 hours', nightly: true }).select('id').single();
  const rate = await supabase.from('unit_rates').insert({ tenant_id: tenantId, unit_id: unit.id, slot_id: slot.id, weekday_price: 500000, weekend_price: 600000 });
  if (rate.error) throw new Error(`rate: ${rate.error.message}`);
  await supabase.from('documents').insert({ tenant_id: tenantId, title: 'About', content: 'A resort.' });

  const { data: s, error: sError } = await supabase.auth.admin.createUser({ email: `legal-walk-${Date.now()}@example.com`, password: 'x'.repeat(8) + randomBytes(9).toString('base64url'), email_confirm: true });
  if (sError) throw new Error(sError.message);
  users.push(s.user.id);
  await supabase.from('platform_admins').insert({ user_id: s.user.id });
  const password = 'Walk-' + randomBytes(12).toString('base64url');
  await supabase.auth.admin.updateUserById(s.user.id, { password });
  const login = await fetch(`${BASE}/api/platform/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: s.user.email, password }) });
  const platformCookie = (login.headers.getSetCookie?.() ?? []).find((x) => x.startsWith('rag_platform='))?.split(';')[0]?.slice('rag_platform='.length);
  if (!platformCookie) throw new Error(`platform login ${login.status}`);
  const status = async (path) => (await fetch(`${BASE}${path}`)).status;

  browser = await openBrowser();
  let { page } = browser;
  await page.viewport(1280);
  await page.send('Network.setCookie', { name: 'rag_platform', value: platformCookie, url: `${BASE}/api/platform/`, path: '/api/platform' });
  const openLegalTab = async () => {
    await page.goto(`${BASE}/platform`);
    await page.until(`!!document.querySelector('[aria-label="Edit ${NAME}"]')`, 45000);
    await page.eval(`document.querySelector('[aria-label="Edit ${NAME}"]').click(); true`);
    await page.until("[...document.querySelectorAll('[role=tab]')].some(t => t.textContent.trim() === 'Legal')", 30000);
    await page.eval("[...document.querySelectorAll('[role=tab]')].find(t => t.textContent.trim() === 'Legal').click(); true");
    await page.until("!!document.querySelector('#legal-email')", 15000);
    await sleep(300);
  };
  const setValue = (sel, value) =>
    `(() => { const i = document.querySelector(${JSON.stringify(sel)}); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, ${JSON.stringify(value)}); i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`;

  // 1
  {
    await openLegalTab();
    await page.eval(setValue('#legal-dpa-date', '2026-10-01'));
    await page.type('#legal-name', 'Data Protection Officer');
    await page.type('#legal-email', 'dpo@legalwalk.example');
    await page.eval("document.querySelector('#legal-email').closest('form').querySelector('.save-bar button[type=submit]').click(); true");
    const saved = await page.until("[...document.querySelectorAll('.toast-message')].some(t => t.textContent === 'Legal details saved.')", 20000);
    const { data: row } = await supabase.from('tenants').select('dpa_signed_on, privacy_contact_name, privacy_contact_email').eq('id', tenantId).single();
    const html = await (await fetch(`${BASE}/t/${slug}/privacy`)).text();
    check(
      saved && row?.dpa_signed_on === '2026-10-01' && row.privacy_contact_email === 'dpo@legalwalk.example' && html.includes('Data Protection Officer, at dpo@legalwalk.example'),
      '1. the Legal tab saves the DPA date and the privacy contact; the privacy page names that contact',
      `toast ${saved} · ${JSON.stringify(row)} · page names it ${html.includes('dpo@legalwalk.example')}`,
    );
  }

  // 2
  {
    await page.goto(`${BASE}/t/${slug}`);
    await page.until("!!document.querySelector('.composer-notice')", 45000);
    const notice = await page.eval("({ text: document.querySelector('.composer-notice').textContent, links: [...document.querySelectorAll('.composer-notice a')].map(a => a.getAttribute('href')) })");
    const codes = await Promise.all(notice.links.map((h) => status(h)));
    check(
      /AI assistant/.test(notice.text) && /saved/.test(notice.text) && /staff/.test(notice.text) && /OpenAI/.test(notice.text) && notice.links.join() === `/t/${slug}/privacy,/t/${slug}/terms` && codes.every((c) => c === 200),
      "2. the chat's notice: AI, saved, staff, OpenAI; Privacy and Terms linked and 200",
      `${notice.text} · ${notice.links.join(' ')} → ${codes.join(' ')}`,
    );
  }

  // 3
  const toConsentStep = async () => {
    await page.goto(`${BASE}/t/${slug}/book`);
    await page.until("!!document.querySelector('input[type=date]')", 30000);
    await sleep(2000);
    await page.eval(`(() => { const i = document.querySelector('input[type=date]'); const d = new Date(i.min + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + 10); const day = i.max && d.toISOString().slice(0, 10) > i.max ? i.max : d.toISOString().slice(0, 10); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, day); i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
    const next = async () => {
      await page.until("[...document.querySelectorAll('button')].some(b => b.textContent.trim().startsWith('Continue') && !b.disabled && b.offsetParent !== null)", 15000);
      await page.eval("[...document.querySelectorAll('button')].find(b => b.textContent.trim().startsWith('Continue') && !b.disabled && b.offsetParent !== null).click(); true");
      await sleep(600);
    };
    await next();
    // Guests: a visible number field, if the step has one empty.
    await page.eval(`(() => { const i = [...document.querySelectorAll('input[type=number]')].find(x => x.offsetParent !== null); if (i && !i.value) { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, '2'); i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new Event('change', { bubbles: true })); } return true; })()`);
    await next();
    await page.until("!!document.querySelector('#name') && document.querySelector('#name').offsetParent !== null", 15000);
    await page.type('#name', 'Legal Walker');
    await page.type('#phone', '0917 555 0199');
    await page.type('#email', 'walker@legalwalk.example');
    await next();
    await page.until("!!document.querySelector('#book-consent') && document.querySelector('#book-consent').offsetParent !== null", 20000);
    await page.until("!!document.querySelector('.quote') && !document.querySelector('.quote-skeleton')", 20000);
    await sleep(500);
  };
  {
    await toConsentStep();
    const before = await page.eval("({ ticked: document.querySelector('#book-consent').checked, send: document.querySelector('.book-send').disabled, links: [...document.querySelectorAll('.consent-check a')].map(a => a.getAttribute('href')) })");
    await page.shot(join(SHOTS, 'consent-step-1280.png'));
    await page.click('#book-consent');
    const on = await page.until("!document.querySelector('.book-send').disabled", 5000);
    await page.click('.book-send');
    const receipt = await page.until("!!document.querySelector('.receipt')", 20000);
    const reference = await page.eval("document.querySelector('.receipt .reference')?.textContent?.trim() ?? null");
    const stay = reference ? (await supabase.from('stays').select('consent_version, consented_at').eq('tenant_id', tenantId).eq('reference', reference).single()).data : null;
    check(
      before.ticked === false && before.send === true && before.links.join() === `/t/${slug}/privacy,/t/${slug}/terms` && on && receipt && stay?.consent_version === '1' && !!stay.consented_at,
      '3. the consent box starts unticked with Send off; ticked, Send is on; sent, the stay records version 1 and when',
      `before ${JSON.stringify(before)} · on ${on} · receipt ${receipt} ${reference} · stay ${JSON.stringify(stay)}`,
    );
  }

  // 4
  {
    const links = await page.eval("[...document.querySelectorAll('.public-footer a')].map(a => a.textContent.trim() + ' ' + a.getAttribute('href'))");
    check(links.includes(`Privacy /t/${slug}/privacy`) && links.includes(`Terms /t/${slug}/terms`), "4. the booking page's footer links Privacy and Terms", links.join(' · '));
  }

  // 5
  {
    const landing = await (await fetch(`${BASE}/`)).text();
    const codes = [await status('/privacy'), await status('/terms')];
    check(codes.every((c) => c === 200) && landing.includes('href="/privacy"') && landing.includes('href="/terms"'), "5. the platform's /privacy and /terms are 200 and linked from the landing page", codes.join(' '));
  }
  browser.close();
  browser = null;

  // 6
  for (const scheme of ['light', 'dark']) {
    browser = await openBrowser({ scheme });
    page = browser.page;
    await page.send('Network.setCookie', { name: 'rag_platform', value: platformCookie, url: `${BASE}/api/platform/`, path: '/api/platform' });
    const audit = async (label) => {
      await page.eval(AXE);
      const violations = JSON.parse(
        await page.eval(`axe.run(document, { runOnly: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'] }).then(r => JSON.stringify(r.violations.map(v => ({ id: v.id, impact: v.impact, nodes: v.nodes.length, sample: v.nodes[0]?.target?.join(' ') }))))`),
      );
      audited++;
      for (const v of violations) found.push(`${label} [${scheme}] ${v.id} (${v.impact}, ${v.nodes}): ${v.sample}`);
      await page.shot(join(SHOTS, `${label.replace(/[^a-z0-9]+/gi, '-')}-${scheme}.png`));
    };
    for (const width of [1280, 375]) {
      await page.viewport(width);
      for (const path of [`/t/${slug}/privacy`, `/t/${slug}/terms`, '/privacy']) {
        await page.goto(`${BASE}${path}`);
        await page.until("!!document.querySelector('.legal-doc')", 30000);
        await sleep(400);
        await audit(`${path === '/privacy' ? 'platform privacy' : path.split('/').pop()} @${width}`);
      }
      await page.goto(`${BASE}/t/${slug}`);
      await page.until("!!document.querySelector('.composer-notice')", 30000);
      await sleep(600);
      await audit(`chat @${width}`);
      await toConsentStep();
      await audit(`consent step @${width}`);
      await openLegalTab();
      await audit(`legal tab @${width}`);
    }
    browser.close();
    browser = null;
  }
} catch (error) {
  check(false, 'setup', error.message);
} finally {
  browser?.close();
  if (tenantId) await supabase.from('tenants').delete().eq('id', tenantId);
  for (const id of users) {
    await supabase.from('platform_admins').delete().eq('user_id', id);
    await supabase.auth.admin.deleteUser(id);
  }
}
console.log(`\naxe: ${audited} states, ${found.length} violation(s)`);
for (const f of found) console.log(`  ${f}`);
console.log(failures ? `${failures} FAILED` : 'walk: all passed');
process.exit(failures === 0 && found.length === 0 && audited === 24 ? 0 : 1);
