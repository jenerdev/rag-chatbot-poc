// Screenshots of the staff Bookings screen: its list of stays, then the New
// booking drawer (D-111's form, regrouped):
// villa (whole_resort) and harbor (per_room), empty and filled, desktop and
// phone. The drawer books nothing (it stops before Book); harbor's list gets
// three temporary stays, deleted at the end.
//
//   (cd packages/db && node --conditions=react-server --env-file=../../.env ../../plan/staff-booking-drawer-shots.mjs)
//
// Needs pnpm dev. A temporary admin of both tenants, deleted at the end.

import { randomBytes } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { supabase } from '../packages/db/dist/service.js';
import { openBrowser } from './ui-refresh-cdp.mjs';

const BASE = process.argv[2] ?? 'http://localhost:3000';
const OUT = join(dirname(fileURLToPath(import.meta.url)), 'ui-refresh', 'staff-booking');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// React reads a value set through the native setter, then an input event.
const setValue = (selector, value) =>
  `(() => { const el = document.querySelector(${JSON.stringify(selector)}); const proto = el.tagName === 'SELECT' ? HTMLSelectElement.prototype : el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); })()`;
const openDrawer = "[...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'New booking')?.click()";

const slugs = ['villa', 'harbor'];
const { data: tenants } = await supabase.from('tenants').select('id, slug').in('slug', slugs);
let userId;
let browser;
const seeded = [];
try {
  const email = `drawer-shots-${Date.now()}@example.com`;
  const password = randomBytes(18).toString('base64url');
  const { data, error } = await supabase.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(error.message);
  userId = data.user.id;
  for (const t of tenants) {
    const m = await supabase.from('memberships').insert({ user_id: userId, tenant_id: t.id, role: 'admin' });
    if (m.error) throw new Error(m.error.message);
  }

  // Three stays on harbor, so its list has rows to draw: pending, confirmed,
  // and a confirmed walk-in. Through the staff route, deleted at the end.
  {
    const harbor = tenants.find((t) => t.slug === 'harbor');
    const r = await fetch(`${BASE}/api/t/harbor/admin/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
    const cookie = (r.headers.getSetCookie?.() ?? []).find((x) => x.startsWith('rag_admin='))?.split(';')[0];
    const call = (path, init = {}) => fetch(`${BASE}/api/t/harbor${path}`, { ...init, headers: { 'Content-Type': 'application/json', cookie } });
    const setup = await (await call('/bookings/setup')).json();
    const night = setup.slots.find((x) => x.nightly);
    const { data: units } = await supabase.from('units').select('id').eq('tenant_id', harbor.id).eq('active', true).order('sort_order');
    const day = (n) => { const d = new Date(`${setup.today}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
    const stays = [
      { offset: 3, unit: 0, nights: 2, name: 'Maria Santos', walkIn: false, confirm: false },
      { offset: 5, unit: 1, nights: 1, name: 'Jose Reyes', walkIn: false, confirm: true },
      { offset: 0, unit: 2, nights: 3, name: 'Ana Cruz', walkIn: true, confirm: true },
    ];
    for (const [i, st] of stays.entries()) {
      const res = await call('/bookings', { method: 'POST', body: JSON.stringify({ slotId: night.id, rooms: [{ unitId: units[st.unit].id, guests: 2 }], checkIn: day(st.offset), nights: st.nights, name: st.name, phone: `0917 555 01${10 + i}`, email: `shots.${i}@example.com`, walkIn: st.walkIn }) });
      const body = await res.json();
      if (res.status !== 201) throw new Error(`seed ${st.name}: ${res.status} ${body.error}`);
      seeded.push({ tenant: harbor.id, group: body.groupId });
      if (st.confirm) await call(`/bookings/requests/${body.groupId}`, { method: 'PATCH', body: JSON.stringify({ action: 'confirm', note: 'screenshot seed' }) });
    }
  }

  for (const width of [1280, 390]) {
    for (const slug of slugs) {
      browser?.close();
      browser = await openBrowser({ scheme: 'light' });
      const page = browser.page;
      await page.viewport(width);
      const r = await fetch(`${BASE}/api/t/${slug}/admin/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
      const cookie = (r.headers.getSetCookie?.() ?? []).find((x) => x.startsWith('rag_admin='))?.split(';')[0]?.slice('rag_admin='.length);
      if (!cookie) throw new Error(`login failed at ${slug}`);
      await page.send('Network.setCookie', { name: 'rag_admin', value: cookie, url: `${BASE}/api/t/${slug}/`, path: `/api/t/${slug}` });
      await page.goto(`${BASE}/t/${slug}/admin/bookings`);
      await page.until("[...document.querySelectorAll('button')].some(b => b.textContent.trim() === 'New booking')", 30000);
      // The list of stays first (the date grid's replacement), then the drawer.
      await page.until("!!document.querySelector('.card.stays .stay-row, .card.stays .empty-list')", 30000);
      await sleep(300);
      await page.shot(join(OUT, `${slug}-list-${width}.png`));
      await page.eval(openDrawer);
      await page.until("!!document.querySelector('dialog.drawer[open] .booking-form')", 10000);
      if (slug === 'harbor') await page.until("!!document.querySelector('.room-pick')", 15000);
      await sleep(400);
      await page.shot(join(OUT, `${slug}-empty-${width}.png`));

      // A nightly slot if there is one, two nights, a week out.
      const nightly = await page.eval("[...document.querySelector('#slot').options].find(o => /night/i.test(o.textContent))?.value ?? null");
      if (nightly) await page.eval(setValue('#slot', nightly));
      await sleep(200);
      const week = await page.eval("(() => { const d = new Date(document.querySelector('#date').min + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + 7); return d.toISOString().slice(0, 10); })()");
      await page.eval(setValue('#date', week));
      if (await page.eval("!!document.querySelector('#nights')")) await page.eval(setValue('#nights', '2'));
      if (slug === 'harbor') {
        await page.until("!!document.querySelector('.room-pick input[type=checkbox]')", 15000);
        await page.eval("document.querySelector('.room-pick input[type=checkbox]').click()");
        await sleep(200);
        await page.eval(setValue('.room-pick.picked input[type=number]', '2'));
      } else {
        await page.eval(setValue('#guest-count', '12'));
      }
      await page.eval(setValue('#guest-name', 'Maria Santos'));
      await page.eval(setValue('#guest-phone', '0917 123 4567'));
      await page.eval(setValue('#guest-email', 'maria@example.com'));
      await page.eval("document.querySelector('.option-card input[type=checkbox]').click()");
      await page.until("!!document.querySelector('.drawer-footer-total strong')", 15000);
      await sleep(300);
      await page.shot(join(OUT, `${slug}-filled-${width}.png`));
      await page.eval("document.querySelector('dialog.drawer[open]').scrollTop = 1e6");
      await sleep(300);
      await page.shot(join(OUT, `${slug}-filled-bottom-${width}.png`));
      const footer = await page.eval("document.querySelector('.drawer-footer').innerText.replace(/\\s+/g, ' ')");
      console.log(`${slug} ${width}: footer "${footer}"`);
    }
  }
} finally {
  browser?.close();
  for (const s of seeded) await supabase.from('bookings').delete().eq('tenant_id', s.tenant).eq('group_id', s.group);
  if (userId) await supabase.auth.admin.deleteUser(userId);
}
console.log(`shots in ${OUT}`);
