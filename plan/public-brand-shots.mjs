// public-brand-shots.mjs — the PUBLIC pages, photographed per tenant
// (plan/public-brand.md): the chat (S-1), the booking page (S-6) and Manage
// booking (S-13), at 1280 and 375, light and dark.
//
//   (cd packages/db && node --conditions=react-server --env-file=../../.env ../../plan/public-brand-shots.mjs <label>)
//
// Writes plan/public-brand/<label>-<tenant>-<page>-<scheme>-<width>.png.
// Tenants: villa (accent + background), harbor (no theme, suggested
// questions), alteza (a full theme), and a throwaway `brand-probe` with a
// LOGO and a BANNER (no real tenant has either yet), which copies harbor's
// suggested questions and is deleted at the end. Needs pnpm dev. Nothing is
// sent: the browser only loads pages.

import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { supabase } from '../packages/db/dist/service.js';
import { openBrowser } from './ui-refresh-cdp.mjs';

const BASE = 'http://localhost:3000';
const LABEL = process.argv[2] ?? 'shot';
const ONLY = process.argv[3] ?? null; // e.g. "chat" to shoot one page
const OUT = join(dirname(fileURLToPath(import.meta.url)), 'public-brand');
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Two public, stable https images: a square logo and a wide banner.
const LOGO = 'https://images.unsplash.com/photo-1566073771259-6a8506099945?w=160&h=160&fit=crop';
const BANNER = 'https://images.unsplash.com/photo-1507525428034-b723cf961d3e?w=1600&h=500&fit=crop';

let probeId = null;
let browser;
try {
  const { data: harbor } = await supabase.from('tenants').select('suggested_questions').eq('slug', 'harbor').single();
  const { data: probe, error } = await supabase
    .from('tenants')
    .insert({ slug: 'brand-probe', business_name: 'Casa Brava Beach Resort', assistant_name: 'Brava', logo_url: LOGO, banner_url: BANNER, theme: { accent: '#c2410c' }, suggested_questions: harbor?.suggested_questions ?? [] })
    .select('id')
    .single();
  if (error) throw new Error(error.message);
  probeId = probe.id;
  // The booking page 404s without the application and a priced unit: give the probe one of each.
  const app = await supabase.from('tenant_applications').insert({ tenant_id: probeId, application_key: 'bookings', config: { timezone: 'Asia/Manila' } });
  if (app.error) throw new Error(`application: ${app.error.message}`);
  const { data: unit } = await supabase.from('units').insert({ tenant_id: probeId, name: 'Beachfront Villa', capacity: 6 }).select('id').single();
  const { data: slot } = await supabase.from('slots').insert({ tenant_id: probeId, name: 'Overnight', start_time: '14:00', duration: '22 hours', nightly: true }).select('id').single();
  const rate = await supabase.from('unit_rates').insert({ tenant_id: probeId, unit_id: unit.id, slot_id: slot.id, weekday_price: 1200000, weekend_price: 1500000 });
  if (rate.error) throw new Error(`rate: ${rate.error.message}`);

  const tenants = (process.argv[4] ?? 'villa,harbor,alteza,brand-probe').split(',');
  const pages = [
    ['chat', '', "!!document.querySelector('.composer')"],
    ['book', '/book', "!!document.querySelector('main') && !document.querySelector('.skeleton')"],
    ['manage', '/manage', "!!document.querySelector('main form, main input')"],
  ].filter(([name]) => !ONLY || name === ONLY);

  for (const scheme of ['light', 'dark']) {
    browser = await openBrowser({ scheme });
    const { page } = browser;
    for (const slug of tenants) {
      for (const [name, path, ready] of pages) {
        for (const width of [1280, 375]) {
          await page.viewport(width);
          await page.goto(`${BASE}/t/${slug}${path}`);
          // A tenant without the page (no bookings) 404s: photograph that as it is.
          await page.until(`${ready} || !!document.querySelector('.not-found, h1')`, 30000);
          await sleep(1800);
          await page.shot(join(OUT, `${LABEL}-${slug}-${name}-${scheme}-${width}.png`));
        }
      }
    }
    browser.close();
    browser = null;
  }
  console.log(`written to ${OUT}`);
} finally {
  browser?.close();
  if (probeId) await supabase.from('tenants').delete().eq('id', probeId);
}
