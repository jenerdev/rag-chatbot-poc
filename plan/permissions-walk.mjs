// permissions-walk.mjs — role permissions per tenant and the platform's
// knowledge base (D-128), end to end, against pnpm dev.
//
// On a THROWAWAY tenant (`perm-walk-…`, deleted at the end with everything
// it owns) with an OWNER who logs in; a throwaway SUPER USER drives the
// platform form.
//   1. the Permissions tab lists every permission; the defaults are ticked
//      (owner may add documents) and the fixed rows are disabled;
//   2. unticking "Add, edit and delete documents" for owner and admin and
//      saving says "Permissions saved." and stores exactly those two rows;
//   3. the owner still lists documents (200), adding one is a 403 that says
//      why, and the owner's Knowledge base screen offers no "Add a document";
//   4. the super user adds a document on the Knowledge base tab: a toast
//      with its chunks, the list shows it, and the owner's list has it too;
//   5. the super user deletes it: the list and the owner's list are empty;
//   6. "Use the defaults" and Save: no rows left, the owner may add again
//      (the screen offers "Add a document");
//   7. axe over the Permissions and Knowledge base tabs, 1280 and 375, light
//      and dark (8 states).
// Step 4 calls OpenAI once (one short document is embedded).
//
//   (cd packages/db && node --conditions=react-server --env-file=../../.env ../../plan/permissions-walk.mjs)

import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { supabase } from '../packages/db/dist/service.js';
import { openBrowser } from './ui-refresh-cdp.mjs';

const BASE = 'http://localhost:3000';
const HERE = dirname(fileURLToPath(import.meta.url));
const AXE = readFileSync(join(HERE, 'ui-refresh', 'axe', 'axe.min.js'), 'utf8');
const SHOTS = join(HERE, 'permissions');
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
const slug = `perm-walk-${randomBytes(3).toString('hex')}`;
const NAME = 'Permission Walk Resort';
try {
  const { data: t, error } = await supabase.from('tenants').insert({ slug, business_name: NAME, assistant_name: 'Walker' }).select('id').single();
  if (error) throw new Error(`tenant: ${error.message}`);
  tenantId = t.id;
  const person = async (tag) => {
    const email = `${tag}-${Date.now()}-${randomBytes(2).toString('hex')}@example.com`;
    const password = randomBytes(18).toString('base64url');
    const { data, error: e } = await supabase.auth.admin.createUser({ email, password, email_confirm: true });
    if (e) throw new Error(e.message);
    users.push(data.user.id);
    return { id: data.user.id, email, password };
  };
  const sup = await person('perm-super');
  const owner = await person('perm-owner');
  await supabase.from('platform_admins').insert({ user_id: sup.id });
  const m = await supabase.from('memberships').insert({ user_id: owner.id, tenant_id: tenantId, role: 'owner' });
  if (m.error) throw new Error(`membership: ${m.error.message}`);
  const cookieOf = (r, name) => (r.headers.getSetCookie?.() ?? []).find((x) => x.startsWith(`${name}=`))?.split(';')[0]?.slice(name.length + 1);
  const platformCookie = cookieOf(
    await fetch(`${BASE}/api/platform/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: sup.email, password: sup.password }) }),
    'rag_platform',
  );
  const adminCookie = cookieOf(
    await fetch(`${BASE}/api/t/${slug}/admin/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: owner.email, password: owner.password }) }),
    'rag_admin',
  );
  if (!platformCookie || !adminCookie) throw new Error(`login: platform ${!!platformCookie} admin ${!!adminCookie}`);
  const asOwner = async (path, init = {}) => {
    const r = await fetch(`${BASE}${path}`, { ...init, headers: { ...(init.headers ?? {}), 'Content-Type': 'application/json', cookie: `rag_admin=${adminCookie}` } });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const rows = async () => (await supabase.from('role_permissions').select('role, permission, allowed').eq('tenant_id', tenantId).order('role')).data ?? [];

  browser = await openBrowser();
  let { page } = browser;
  await page.viewport(1280);
  await page.send('Network.setCookie', { name: 'rag_platform', value: platformCookie, url: `${BASE}/api/platform/`, path: '/api/platform' });
  await page.send('Network.setCookie', { name: 'rag_admin', value: adminCookie, url: `${BASE}/api/t/${slug}/`, path: `/api/t/${slug}` });
  const openTab = async (label) => {
    await page.goto(`${BASE}/platform`);
    await page.until(`!!document.querySelector('[aria-label="Edit ${NAME}"]')`, 45000);
    await page.eval(`document.querySelector('[aria-label="Edit ${NAME}"]').click(); true`);
    await page.until(`[...document.querySelectorAll('[role=tab]')].some(t => t.textContent.trim() === ${JSON.stringify(label)})`, 30000);
    await page.eval(`[...document.querySelectorAll('[role=tab]')].find(t => t.textContent.trim() === ${JSON.stringify(label)}).click(); true`);
    await sleep(400);
  };
  const box = (role, label) => `[...document.querySelectorAll('.perm-table input[type=checkbox]')].find(b => b.getAttribute('aria-label').startsWith(${JSON.stringify(`${role}: ${label}`)}))`;
  // Every tab's panel is mounted (components/tabs.tsx), so a Save is found inside its own form, never the first on the page.
  const toastSays = (re) => page.until(`[...document.querySelectorAll('.toast-message')].some(t => ${re}.test(t.textContent))`, 60000);

  // 1
  await openTab('Permissions');
  await page.until("document.querySelectorAll('.perm-table tbody tr:not(.perm-area)').length > 0", 15000);
  const table = await page.eval(`({
    rows: document.querySelectorAll('.perm-table tbody tr:not(.perm-area)').length,
    ownerDocs: ${box('Owner', 'Add, edit and delete documents')}?.checked,
    staffDocs: ${box('Staff', 'Add, edit and delete documents')}?.checked,
    fixedDisabled: ${box('Admin', 'Verify and reject proofs')}?.disabled,
  })`);
  check(table.rows === 21 && table.ownerDocs === true && table.staffDocs === false && table.fixedDisabled === true, '1. the Permissions tab lists all 21 permissions: the defaults ticked, a fixed row disabled', JSON.stringify(table));
  await page.shot(join(SHOTS, 'permissions-tab-1280.png'));

  // 2
  await page.eval(`${box('Owner', 'Add, edit and delete documents')}.click(); ${box('Admin', 'Add, edit and delete documents')}.click(); true`);
  await page.eval("document.querySelector('.perm-table').closest('form').querySelector('.save-bar button[type=submit]').click(); true");
  const saved = await toastSays('/Permissions saved/');
  const stored = await rows();
  check(
    saved && stored.length === 2 && stored.every((r) => r.permission === 'documents:write' && r.allowed === false),
    '2. owner and admin unticked for documents, saved: "Permissions saved." and exactly those two rows stored',
    `toast ${saved} · ${JSON.stringify(stored)}`,
  );

  // 3
  {
    const list = await asOwner(`/api/t/${slug}/documents`);
    const add = await asOwner(`/api/t/${slug}/documents`, { method: 'POST', body: JSON.stringify({ title: 'Refused', content: 'The owner cannot add this.' }) });
    await page.goto(`${BASE}/t/${slug}/admin/documents`);
    await page.until("!!document.querySelector('.staff-content') && !document.querySelector('.skeleton')", 45000);
    await sleep(800);
    const screen = await page.eval("({ add: [...document.querySelectorAll('button')].some(b => b.textContent.includes('Add a document')), note: document.body.innerText.includes('not part of your role') })");
    check(
      list.status === 200 && add.status === 403 && /documents:write/.test(add.body?.error ?? '') && !screen.add && screen.note,
      '3. the owner still lists documents (200); adding one is a 403 naming documents:write; the screen offers no "Add a document" and says why',
      `list ${list.status} · add ${add.status} ${add.body?.error} · screen ${JSON.stringify(screen)}`,
    );
  }

  // 4
  {
    await openTab('Knowledge base');
    await page.until("!!document.querySelector('#kb-title')", 15000);
    await page.type('#kb-title', 'House rules');
    await page.type('#kb-content', 'Check-in is at 2 PM and check-out at noon. Quiet hours start at 10 PM. Pets are welcome in the garden rooms.');
    await page.eval("[...document.querySelectorAll('button[type=submit]')].find(b => b.textContent.includes('Add document')).click(); true");
    const added = await toastSays('/Added "House rules": \\d+ chunks/');
    await page.until("[...document.querySelectorAll('.kb-title')].some(t => t.textContent.includes('House rules'))", 30000);
    const ownerList = await asOwner(`/api/t/${slug}/documents`);
    check(
      added && ownerList.status === 200 && ownerList.body?.length === 1 && ownerList.body[0].title === 'House rules' && ownerList.body[0].chunkCount >= 1,
      '4. the super user adds a document on the Knowledge base tab (a toast with its chunks); the owner lists it',
      `toast ${added} · owner ${ownerList.status} ${JSON.stringify(ownerList.body?.map((d) => [d.title, d.chunkCount]))}`,
    );
    await page.shot(join(SHOTS, 'knowledge-tab-1280.png'));
  }

  // 5
  {
    await page.eval("document.querySelector('[aria-label=\"Delete House rules\"]').click(); true");
    await page.until("!!document.querySelector('dialog[open]')", 10000);
    await page.eval("[...document.querySelectorAll('dialog[open] button')].find(b => b.textContent.trim() === 'Delete').click(); true");
    const deleted = await toastSays('/Deleted "House rules"/');
    await page.until("!document.querySelector('.kb-list')", 20000);
    const ownerList = await asOwner(`/api/t/${slug}/documents`);
    const { count: chunks } = await supabase.from('chunks').select('id', { count: 'exact', head: true }).eq('tenant_id', tenantId);
    check(deleted && ownerList.body?.length === 0 && chunks === 0, '5. the super user deletes it: the owner lists none, and no chunk is left', `toast ${deleted} · owner ${ownerList.body?.length} · chunks ${chunks}`);
  }

  // 6
  {
    await openTab('Permissions');
    await page.until("[...document.querySelectorAll('button')].some(b => b.textContent.trim() === 'Use the defaults')", 15000);
    await page.eval("[...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Use the defaults').click(); true");
    await page.eval("document.querySelector('.perm-table').closest('form').querySelector('.save-bar button[type=submit]').click(); true");
    const back = await toastSays('/back on the defaults/');
    const left = await rows();
    await page.goto(`${BASE}/t/${slug}/admin/documents`);
    await page.until("!!document.querySelector('.staff-content') && !document.querySelector('.skeleton')", 45000);
    await sleep(800);
    const add = await page.eval("[...document.querySelectorAll('button')].some(b => b.textContent.includes('Add a document'))");
    check(back && left.length === 0 && add, '6. "Use the defaults" and Save: no rows left, and the owner\'s screen offers "Add a document" again', `toast ${back} · rows ${left.length} · add ${add}`);
  }
  browser.close();
  browser = null;

  // 7
  for (const scheme of ['light', 'dark']) {
    browser = await openBrowser({ scheme });
    page = browser.page;
    await page.send('Network.setCookie', { name: 'rag_platform', value: platformCookie, url: `${BASE}/api/platform/`, path: '/api/platform' });
    for (const width of [1280, 375]) {
      await page.viewport(width);
      for (const tab of ['Permissions', 'Knowledge base']) {
        await openTab(tab);
        await sleep(800);
        await page.eval(AXE);
        const violations = JSON.parse(
          await page.eval(`axe.run(document, { runOnly: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'] }).then(r => JSON.stringify(r.violations.map(v => ({ id: v.id, impact: v.impact, nodes: v.nodes.length, sample: v.nodes[0]?.target?.join(' ') }))))`),
        );
        audited++;
        for (const v of violations) found.push(`${tab} @${width} [${scheme}] ${v.id} (${v.impact}, ${v.nodes}): ${v.sample}`);
        await page.shot(join(SHOTS, `${tab === 'Permissions' ? 'permissions' : 'knowledge'}-tab-${scheme}-${width}.png`));
      }
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
process.exit(failures === 0 && found.length === 0 && audited === 8 ? 0 : 1);
