// manage-layout-shots.mjs — Manage booking (S-13) photographed: the look-up
// form, then real stays found by reference + email (one per guest status the
// database has, villa and harbor), on the Payment tab and the details, at
// 1280 and 375, light and dark; and axe over every state photographed (the
// rules of ui-refresh-a11y.mjs), which must end at 0 violations.
//
//   (cd packages/db && node --conditions=react-server --env-file=../../.env ../../plan/manage-layout-shots.mjs <label>)
//
// Writes plan/manage-layout/<label>-<n>-<state>-<scheme>-<width>.png. Needs
// pnpm dev. Real tenants' stays are only read; the pending one is made on a
// throwaway tenant and deleted. Each look-up is a hit, never a miss, so no
// reference is locked.

import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { supabase } from '../packages/db/dist/service.js';
import { openBrowser } from './ui-refresh-cdp.mjs';

const BASE = 'http://localhost:3000';
const LABEL = process.argv[2] ?? 'shot';
const SCHEMES = (process.argv[3] ?? 'light,dark').split(',');
const OUT = join(dirname(fileURLToPath(import.meta.url)), 'manage-layout');
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const AXE = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'ui-refresh', 'axe', 'axe.min.js'), 'utf8');
const found = [];
let audited = 0;
/** Photograph the page and run axe on it. */
async function shoot(page, file, what) {
  await page.shot(file);
  await page.eval(AXE);
  const violations = JSON.parse(
    await page.eval(`axe.run(document, { runOnly: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'] }).then(r => JSON.stringify(r.violations.map(v => ({ id: v.id, impact: v.impact, nodes: v.nodes.length, sample: v.nodes[0]?.target?.join(' ') }))))`),
  );
  audited++;
  for (const v of violations) found.push(`${what} ${v.id} (${v.impact}, ${v.nodes}): ${v.sample}`);
  console.log(`${violations.length === 0 ? 'clean' : `${violations.length} violation(s)`}  ${what}`);
}

// The busiest state, on a THROWAWAY tenant (`manage-shots`, deleted at the
// end; the cascade takes its stay): pending, unpaid, a deadline counting
// down, two rooms, two ways to pay, terms, a cancellation table.
let probeId = null;
const picks = [];
try {
  const { data: t, error } = await supabase
    .from('tenants')
    .insert({ slug: 'manage-shots', business_name: 'Casa Brava Beach Resort', assistant_name: 'Brava', theme: { accent: '#c2410c', accentSoft: '#fdeee6' } })
    .select('id')
    .single();
  if (error) throw new Error(`tenant: ${error.message}`);
  probeId = t.id;
  const app = await supabase.from('tenant_applications').insert({
    tenant_id: probeId, application_key: 'bookings',
    config: {
      timezone: 'Asia/Manila', booking_type: 'per_room',
      payments: {
        methods: [
          { kind: 'gcash', label: 'GCash', account_name: 'Casa Brava Resort', account_number: '0917 555 0123' },
          { kind: 'bank', label: 'BPI', account_name: 'Casa Brava Resort Inc.', account_number: '1234-5678-90', instructions: 'Use your reference as the transfer note.' },
        ],
        fee: { kind: 'percent', value: 5000 },
        pay_within_hours: 24,
        terms: 'A 50% down payment confirms your stay. The balance is paid on arrival.',
        cancellation: [{ days_before: 14, refund_percent: 100 }, { days_before: 7, refund_percent: 50 }],
        reschedule_until_days_before: 7,
      },
    },
  });
  if (app.error) throw new Error(`application: ${app.error.message}`);
  const { data: units } = await supabase.from('units').insert([
    { tenant_id: probeId, name: 'Garden Room', capacity: 3, sort_order: 1, active: true },
    { tenant_id: probeId, name: 'Beachfront Villa', capacity: 6, sort_order: 2, active: true },
  ]).select('id');
  const { data: slot } = await supabase.from('slots').insert({ tenant_id: probeId, name: 'Overnight', start_time: '14:00', duration: '22 hours', nightly: true }).select('id').single();
  for (const u of units) {
    const r = await supabase.from('unit_rates').insert({ tenant_id: probeId, unit_id: u.id, slot_id: slot.id, weekday_price: 450000, weekend_price: 600000 });
    if (r.error) throw new Error(`rate: ${r.error.message}`);
  }
  const day = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
  const email = `shots-${Date.now()}@example.com`;
  const { data: rows, error: reqError } = await supabase.rpc('request_booking', {
    p_tenant_id: probeId, p_slot_id: slot.id, p_unit_ids: units.map((u) => u.id), p_guests: [2, 4], p_check_in: day, p_nights: 2,
    p_name: 'Maria Santos', p_phone: '09171234567', p_email: email, p_notes: null,
  });
  if (reqError) throw new Error(`request_booking: ${reqError.message}`);
  picks.push({ slug: 'manage-shots', state: 'pending', reference: rows[0].reference, contact: email });
} catch (error) {
  if (probeId) await supabase.from('tenants').delete().eq('id', probeId);
  throw error;
}

// One web stay per (tenant, status), the newest.
for (const slug of ['villa', 'harbor']) {
  const { data: t } = await supabase.from('tenants').select('id').eq('slug', slug).single();
  for (const status of ['pending', 'confirmed', 'cancelled']) {
    const { data } = await supabase
      .from('bookings')
      .select('reference, guest_email, status, during')
      .eq('tenant_id', t.id)
      .eq('status', status)
      .not('reference', 'is', null)
      .not('guest_email', 'is', null)
      .order('id', { ascending: false })
      .limit(1);
    if (data?.[0]) picks.push({ slug, state: status, reference: data[0].reference, contact: data[0].guest_email });
  }
}
console.log(picks.map((p) => `${p.slug} ${p.state} ${p.reference}`).join('\n'));

let browser;
try {
  for (const scheme of SCHEMES) {
    browser = await openBrowser({ scheme });
    const { page } = browser;
    for (const width of [1280, 375]) {
      await page.viewport(width);
      await page.goto(`${BASE}/t/villa/manage`);
      await page.until("!!document.querySelector('#reference')", 30000);
      await sleep(800);
      await shoot(page, join(OUT, `${LABEL}-0-lookup-${scheme}-${width}.png`), `lookup @${width} [${scheme}]`);
      let n = 1;
      for (const p of picks) {
        await page.goto(`${BASE}/t/${p.slug}/manage`);
        await page.until("!!document.querySelector('#reference')", 30000);
        await sleep(1200);
        await page.eval("document.querySelector('#reference').value=''; true");
        await page.type('#reference', p.reference);
        await page.type('#contact', p.contact);
        await page.eval("document.querySelector('main form button[type=submit]').click(); true");
        const found = await page.until("!!document.querySelector('#stay-title')", 20000);
        if (!found) {
          console.log(`not found: ${p.slug} ${p.reference}: ${await page.eval("document.querySelector('.notice.error')?.textContent ?? ''")}`);
          continue;
        }
        await sleep(600);
        const name = `${LABEL}-${n}-${p.slug}-${p.state}`;
        await shoot(page, join(OUT, `${name}-${scheme}-${width}.png`), `${p.slug} ${p.state} @${width} [${scheme}]`);
        // The other tab, when there are tabs.
        const tabs = await page.eval("document.querySelectorAll('[role=tab]').length");
        if (tabs > 1) {
          await page.eval("document.querySelectorAll('[role=tab]')[1].click(); true");
          await sleep(400);
          await shoot(page, join(OUT, `${name}-tab2-${scheme}-${width}.png`), `${p.slug} ${p.state} tab 2 @${width} [${scheme}]`);
        }
        n++;
      }
    }
    browser.close();
    browser = null;
  }
  console.log(`written to ${OUT}`);
  console.log(`axe: ${audited} states, ${found.length} violation(s)`);
  for (const f of found) console.log(`  ${f}`);
  if (found.length) process.exitCode = 1;
} finally {
  browser?.close();
  if (probeId) await supabase.from('tenants').delete().eq('id', probeId);
}
