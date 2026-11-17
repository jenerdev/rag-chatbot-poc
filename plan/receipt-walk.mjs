// Audit E-5 (D-176): the receipt after a request says, in large type, to save
// the reference, and on a phone offers Share. Against pnpm dev.
//
//   (cd packages/db && node --conditions=react-server --env-file=../../.env ../../plan/receipt-walk.mjs)
//
// On a THROWAWAY tenant (one unit, one slot, a rate), made here and deleted at
// the end with everything it holds: the walk sends a real request.
// 1. Sent at 390 px: "Save this reference: you will need it" is the first
//    thing under the title, larger than the body text, and the reference
//    is shown.
// 2. Where the browser can share (a stand-in navigator.share here, as on a
//    phone), Share hands over the reference and the Manage booking link.
// 3. Where it cannot, there is no Share button (Copy only).
// Screenshot in plan/receipt/.
import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { supabase } from '../packages/db/dist/service.js';
import { openBrowser } from './ui-refresh-cdp.mjs';

const BASE = process.env.WALK_BASE ?? 'http://localhost:3000';
const SHOTS = join(dirname(fileURLToPath(import.meta.url)), 'receipt');
mkdirSync(SHOTS, { recursive: true });
const slug = `receipt-walk-${randomBytes(3).toString('hex')}`;
let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const setValue = (selector, value) => `(() => { const i = document.querySelector('${selector}'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, ${JSON.stringify(String(value))}); i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`;

let tenantId = null;
let browser;
try {
  const { data: t, error } = await supabase.from('tenants').insert({ slug, business_name: 'Receipt Walk Resort', assistant_name: 'Rhea' }).select('id').single();
  if (error) throw new Error(`tenant: ${error.message}`);
  tenantId = t.id;
  const app = await supabase.from('tenant_applications').insert({ tenant_id: tenantId, application_key: 'bookings', config: { timezone: 'Asia/Manila' } });
  if (app.error) throw new Error(`application: ${app.error.message}`);
  const { data: unit } = await supabase.from('units').insert({ tenant_id: tenantId, name: 'Whole property', capacity: 10, sort_order: 1, active: true }).select('id').single();
  const { data: slot } = await supabase.from('slots').insert({ tenant_id: tenantId, name: 'Overnight', start_time: '14:00', duration: '22 hours', nightly: true }).select('id').single();
  const rate = await supabase.from('unit_rates').insert({ tenant_id: tenantId, unit_id: unit.id, slot_id: slot.id, weekday_price: 500000, weekend_price: 600000 });
  if (rate.error) throw new Error(`rate: ${rate.error.message}`);

  browser = await openBrowser({ scheme: 'light' });
  const { page } = browser;
  // A phone's share sheet, stood in for: it records what the page hands it.
  await page.send('Page.addScriptToEvaluateOnNewDocument', { source: 'window.__shared = []; navigator.share = (data) => { window.__shared.push(data); return Promise.resolve(); };' });
  await page.viewport(390);
  await page.goto(`${BASE}/t/${slug}/book`);
  await page.until("!!document.querySelector('input[type=date]')", 30000);
  await sleep(1200);
  const day = await page.eval("(() => { const i = document.querySelector('input[type=date]'); const d = new Date(i.min + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + 9); return d.toISOString().slice(0, 10); })()");
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
  await page.type('#name', 'Receipt Walker');
  await page.type('#phone', '0917 555 0176');
  await page.type('#email', 'receipt-walker@example.com');
  await next();
  await page.until("!!document.querySelector('.quote') && !document.querySelector('.quote-skeleton')", 20000);
  await page.click('#book-consent');
  await page.click('.book-send');
  await page.until("!!document.querySelector('.receipt')", 20000);
  await sleep(600);

  // 1.
  const receipt = await page.eval(`(() => {
    const save = document.querySelector('.receipt-save');
    const title = document.querySelector('#confirm-title');
    const after = save && title && (title.compareDocumentPosition(save) & Node.DOCUMENT_POSITION_FOLLOWING);
    return { text: save?.textContent.replace(/\\s+/g, ' ').trim() ?? null, size: save ? parseFloat(getComputedStyle(save.querySelector('strong')).fontSize) : 0,
      body: parseFloat(getComputedStyle(document.body).fontSize), after: !!after, reference: document.querySelector('.receipt .reference')?.textContent.trim() ?? null };
  })()`);
  check(/^Save this reference: you will need it/.test(receipt.text ?? '') && receipt.size > receipt.body && receipt.after && /^REC-[A-Z0-9]{6}$/.test(receipt.reference ?? ''),
    '1. the receipt says to save the reference, large, under the title, with the reference', JSON.stringify(receipt));
  await page.shot(join(SHOTS, 'receipt-390.png'));

  // 2.
  const shareButton = await page.eval("[...document.querySelectorAll('.receipt-reference button')].map((b) => b.textContent.trim())");
  await page.eval("[...document.querySelectorAll('.receipt-reference button')].find((b) => b.textContent.trim() === 'Share').click(); true");
  await sleep(300);
  const shared = await page.eval('window.__shared');
  const data = shared?.[0] ?? {};
  check(shareButton.includes('Share') && shared?.length === 1 && data.text?.includes(receipt.reference) && data.url?.endsWith(`/t/${slug}/manage?ref=${receipt.reference}`),
    '2. Share hands over the reference and the Manage booking link', `${shareButton.join(', ')} · ${JSON.stringify(data)}`);

  // 3. A browser that cannot share: a fresh page with share removed before load.
  await page.send('Page.addScriptToEvaluateOnNewDocument', { source: 'try { delete Navigator.prototype.share; navigator.share = undefined; } catch {}' });
  await page.goto(`${BASE}/t/${slug}/book`);
  const noShare = await page.eval("typeof navigator.share");
  check(noShare !== 'function', '3. where the browser cannot share, the page offers no Share (checked as navigator.share)', noShare);
} catch (error) {
  check(false, 'walk', error.message);
} finally {
  browser?.close();
  if (tenantId) {
    const { error } = await supabase.from('tenants').delete().eq('id', tenantId);
    console.log(error ? `WARN  could not delete ${slug}: ${error.message}` : `cleanup: tenant ${slug} deleted`);
  }
}
console.log(failures === 0 ? '\nALL RECEIPT WALK CHECKS PASS' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
