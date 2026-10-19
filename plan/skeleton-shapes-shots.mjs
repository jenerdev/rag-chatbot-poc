// skeleton-shapes-shots.mjs — every loading skeleton beside the screen it
// stands for (2026-10-20, the user: "skeleton loading UI should match the
// shape of real data/ui"), against pnpm dev.
//
// For each screen: the page's /api/ GETs are HELD in the browser (Fetch
// domain), so the skeleton stays up; a screenshot; then the held requests go
// through, the rows arrive, and a second screenshot. Saved as
// plan/skeleton-shapes/<screen>-1-loading.png and -2-loaded.png, plus the
// two pages' heights, so a jump shows as a number too. Read-only: nothing is
// written (non-GET requests are failed). A throwaway owner of alteza and a
// throwaway super user, deleted at the end.
//
//   (cd packages/db && node --conditions=react-server --env-file=../../.env ../../plan/skeleton-shapes-shots.mjs [width] [screen,screen])

import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { supabase } from '../packages/db/dist/service.js';
import { openBrowser } from './ui-refresh-cdp.mjs';

const BASE = 'http://localhost:3000';
const WIDTH = Number(process.argv[2] ?? 1280);
const OUT = join(dirname(fileURLToPath(import.meta.url)), 'skeleton-shapes');
const SLUG = 'alteza';
const AXE = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'ui-refresh', 'axe', 'axe.min.js'), 'utf8');
const ONLY = process.argv[3]?.split(',');
const violations = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cookieOf = (r, name) => (r.headers.getSetCookie?.() ?? []).find((x) => x.startsWith(`${name}=`))?.split(';')[0]?.slice(name.length + 1);

const { data: tenant } = await supabase.from('tenants').select('id').eq('slug', SLUG).single();
const { data: anyStay } = await supabase.from('bookings').select('reference').eq('tenant_id', tenant.id).not('reference', 'is', null).order('id', { ascending: false }).limit(1).single();
const { data: anyChat } = await supabase.from('conversations').select('id').eq('tenant_id', tenant.id).order('created_at', { ascending: false }).limit(1).single();

const SCREENS = [
  ['dashboard', '/admin/dashboard'],
  ['documents', '/admin/documents'],
  ['unanswered', '/admin/unanswered'],
  ['conversations', '/admin/conversations'],
  ['transcript', `/admin/conversations/${anyChat?.id}`],
  ['bookings', '/admin/bookings'],
  ['stay', `/admin/bookings/${anyStay?.reference}`],
  ['calendar', '/admin/calendar'],
  ['payments', '/admin/payments'],
  ['notifications', '/admin/notifications'],
  ['rooms', '/admin/accommodations'],
  ['holidays', '/admin/holidays'],
  ['slots', '/admin/slots'],
  ['promos', '/admin/promos'],
  ['members', '/admin/members'],
];

const made = [];
async function makeUser(name) {
  const email = `skeleton-${name}-${Date.now()}@example.com`;
  const password = randomBytes(18).toString('base64url');
  const { data, error } = await supabase.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(error.message);
  made.push(data.user.id);
  return { id: data.user.id, email, password };
}

let browser;
try {
  const owner = await makeUser('owner');
  await supabase.from('memberships').insert({ user_id: owner.id, tenant_id: tenant.id, role: 'owner' });
  const sup = await makeUser('super');
  await supabase.from('platform_admins').insert({ user_id: sup.id });
  const admin = cookieOf(await fetch(`${BASE}/api/t/${SLUG}/admin/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: owner.email, password: owner.password }) }), 'rag_admin');
  const platform = cookieOf(await fetch(`${BASE}/api/platform/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: sup.email, password: sup.password }) }), 'rag_platform');

  browser = await openBrowser({ scheme: 'light' });
  const { page } = browser;
  await page.viewport(WIDTH);
  await page.send('Network.setCookie', { name: 'rag_admin', value: admin, url: `${BASE}/api/t/${SLUG}/`, path: `/api/t/${SLUG}` });
  await page.send('Network.setCookie', { name: 'rag_platform', value: platform, url: `${BASE}/api/platform/`, path: '/api/platform' });

  // Hold every /api/ GET while `hold` is true; fail anything that would write.
  let hold = false;
  const held = [];
  await page.send('Fetch.enable', { patterns: [{ urlPattern: '*/api/*' }] });
  page.on('Fetch.requestPaused', (p) => {
    if (p.request.method !== 'GET') return void page.send('Fetch.failRequest', { requestId: p.requestId, errorReason: 'BlockedByClient' });
    // The session checks pass: a page waiting on its login never reaches its list.
    if (hold && !/\/(attention|session)(\?|$)/.test(p.request.url)) held.push(p.requestId);
    else void page.send('Fetch.continueRequest', { requestId: p.requestId });
  });
  const height = () => page.eval('Math.round(document.querySelector("main")?.getBoundingClientRect().height ?? document.body.scrollHeight)');

  const shoot = async (name, url) => {
    hold = true;
    held.length = 0;
    await page.goto(url);
    await sleep(2500);
    const skeleton = await page.eval(`document.querySelectorAll('.skeleton-shape').length + ' shaped, ' + document.querySelectorAll('.skeleton-list').length + ' generic'`);
    await page.shot(join(OUT, `${name}-1-loading.png`));
    // axe on the skeleton itself: new markup, so it is audited while it shows.
    await page.eval(AXE);
    const found = JSON.parse(await page.eval(`axe.run(document, { runOnly: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'] }).then(r => JSON.stringify(r.violations.map(v => v.id + ' (' + v.nodes.length + ') ' + v.nodes.map(n => n.target.join(' ') + ' :: ' + (n.any[0]?.message ?? '')).join(' || '))))`));
    if (found.length) violations.push(`${name}: ${found.join('; ')}`);
    const before = await height();
    // Loaded: the same page again with nothing held (releasing held requests
    // proved unreliable on the dev server), once no skeleton is left.
    hold = false;
    for (const id of held.splice(0)) void page.send('Fetch.failRequest', { requestId: id, errorReason: 'Aborted' });
    await page.goto(url);
    const done = await page.until(`!document.querySelector('.skeleton-shape, .skeleton-list')`, 30000).then(() => true, () => false);
    await sleep(800);
    await page.shot(join(OUT, `${name}-2-loaded.png`));
    const after = await height();
    console.log(`${name.padEnd(14)} skeletons: ${skeleton} · main ${before}px loading → ${after}px loaded${done ? '' : ' (STILL LOADING after 30 s)'}`);
  };

  for (const [name, path] of SCREENS) if (!ONLY || ONLY.includes(name)) await shoot(name, `${BASE}/t/${SLUG}${path}`);
  if (!ONLY || ONLY.includes('platform')) await shoot('platform', `${BASE}/platform`);
  console.log(violations.length ? `axe on the skeletons: ${violations.length} screen(s) with violations: ${violations.join(' | ')}` : 'axe on the skeletons: no violation');
} finally {
  browser?.close();
  for (const id of made) await supabase.auth.admin.deleteUser(id);
}
console.log(`\nshots in ${OUT}`);
