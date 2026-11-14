// Audit E-6 (D-177): the booking page's date picker shades a night on which
// nothing is free, before a guest picks it. Against pnpm dev.
//
//   (cd packages/db && node --conditions=react-server --env-file=../../.env ../../plan/full-nights-walk.mjs)
//
// On a THROWAWAY tenant (whole property, one slot, a rate) with ONE confirmed
// booking, made here and deleted at the end with everything it holds.
// 1. book/nights returns that night, and only it.
// 2. In the picker at 390 px, that night is shaded ("off full"), named
//    "…, fully booked" for a screen reader, and a click does not choose it.
// 3. The night after is choosable.
// Screenshot in plan/full-nights/.
import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { supabase } from '../packages/db/dist/service.js';
import { openBrowser } from './ui-refresh-cdp.mjs';

const BASE = process.env.WALK_BASE ?? 'http://localhost:3000';
const SHOTS = join(dirname(fileURLToPath(import.meta.url)), 'full-nights');
mkdirSync(SHOTS, { recursive: true });
const slug = `full-walk-${randomBytes(3).toString('hex')}`;
let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const manilaDay = (offset) => new Date(Date.now() + 8 * 3600000 + offset * 86400000).toISOString().slice(0, 10);

let tenantId = null;
let browser;
try {
  const { data: t, error } = await supabase.from('tenants').insert({ slug, business_name: 'Full Walk Resort', assistant_name: 'Fay' }).select('id').single();
  if (error) throw new Error(`tenant: ${error.message}`);
  tenantId = t.id;
  const app = await supabase.from('tenant_applications').insert({ tenant_id: tenantId, application_key: 'bookings', config: { timezone: 'Asia/Manila' } });
  if (app.error) throw new Error(`application: ${app.error.message}`);
  const { data: unit } = await supabase.from('units').insert({ tenant_id: tenantId, name: 'Whole property', capacity: 10, sort_order: 1, active: true }).select('id').single();
  const { data: slot } = await supabase.from('slots').insert({ tenant_id: tenantId, name: 'Overnight', start_time: '14:00', duration: '22 hours', nightly: true }).select('id').single();
  const rate = await supabase.from('unit_rates').insert({ tenant_id: tenantId, unit_id: unit.id, slot_id: slot.id, weekday_price: 500000, weekend_price: 600000 });
  if (rate.error) throw new Error(`rate: ${rate.error.message}`);
  const FULL = manilaDay(5);
  const NEXT = manilaDay(6);
  const booked = await supabase.from('bookings').insert({ tenant_id: tenantId, unit_id: unit.id, slot_id: slot.id, booked_date: FULL, guest_name: 'Full Walk', guest_count: 2, status: 'confirmed' });
  if (booked.error) throw new Error(`booking: ${booked.error.message}`);

  // 1.
  const res = await fetch(`${BASE}/api/t/${slug}/book/nights`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': `198.25.${randomBytes(1)[0]}.${randomBytes(1)[0]}` }, body: JSON.stringify({ slotId: slot.id }),
  });
  const body = await res.json();
  check(res.status === 200 && JSON.stringify(body.full) === JSON.stringify([FULL]), '1. book/nights returns the confirmed night, and only it', `${res.status} ${JSON.stringify(body)} · expected ${FULL}`);

  // 2.
  browser = await openBrowser({ scheme: 'light' });
  const { page } = browser;
  await page.viewport(390);
  await page.goto(`${BASE}/t/${slug}/book`);
  await page.until("!!document.querySelector('.date-trigger')", 30000);
  await sleep(1500);
  await page.click('.date-trigger');
  await page.until("document.querySelectorAll('.date-day').length > 0", 10000);
  // A day's accessible name starts "Friday 25 December 2026" (lib/date-field.ts dayName()): built here, not by the browser's locale.
  const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const nameOf = (day) => { const d = new Date(`${day}T00:00:00Z`); return `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`; };
  const cell = (day) => `[...document.querySelectorAll('.date-day')].find((b) => (b.getAttribute('aria-label') ?? '').startsWith(${JSON.stringify(nameOf(day))}))`;
  // The full night's month may be the next one.
  for (let i = 0; i < 2; i++) {
    if (await page.eval(`!!(${cell(FULL)})`)) break;
    await page.eval("document.querySelector('[aria-label=\"Next month\"]').click(); true");
    await sleep(300);
  }
  const full = await page.eval(`(() => { const b = ${cell(FULL)}; return b ? { cls: b.className, label: b.getAttribute('aria-label'), disabled: b.getAttribute('aria-disabled') } : null; })()`);
  await page.shot(join(SHOTS, 'picker-390.png'));
  await page.eval(`(${cell(FULL)}).click(); true`);
  await sleep(300);
  const valueAfter = await page.eval("document.querySelector('.date-native')?.value ?? ''");
  check(!!full && /\boff\b/.test(full.cls) && /\bfull\b/.test(full.cls) && /fully booked$/.test(full.label) && full.disabled === 'true' && valueAfter !== FULL,
    '2. the full night is shaded, named "fully booked", and a click does not choose it', `${JSON.stringify(full)} · value after click "${valueAfter}"`);

  // 3.
  const next = await page.eval(`(() => { const b = ${cell(NEXT)}; return b ? { cls: b.className, label: b.getAttribute('aria-label'), disabled: b.getAttribute('aria-disabled') } : null; })()`);
  check(!!next && !/\boff\b/.test(next.cls) && next.disabled === null && !/fully booked/.test(next.label), '3. the night after is choosable', JSON.stringify(next));
} catch (error) {
  check(false, 'walk', error.message);
} finally {
  browser?.close();
  if (tenantId) {
    const { error } = await supabase.from('tenants').delete().eq('id', tenantId);
    console.log(error ? `WARN  could not delete ${slug}: ${error.message}` : `cleanup: tenant ${slug} deleted`);
  }
}
console.log(failures === 0 ? '\nALL FULL NIGHTS WALK CHECKS PASS' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
