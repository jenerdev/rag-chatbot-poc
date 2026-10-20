// welcome-text-walk.mjs — the welcome line per tenant (D-139), against
// pnpm dev: the platform route takes it, the chat shows it, and the audit
// log keeps it.
//
//   (cd packages/db && node --conditions=react-server --env-file=../../.env ../../plan/welcome-text-walk.mjs)
//
// On a THROWAWAY tenant and a THROWAWAY super user (both removed at the end
// by the ids this run made, never by a name: trap 26). The tenant gets ONE
// documents row on service_role (no chunks: nothing is embedded), because an
// EMPTY knowledge base swaps the welcome line for "I am still being set up"
// (chat-screen.tsx, emptyKb), which the first run of this walk found. The
// welcome's text is read in a browser at 375, the routes over HTTP:
//   1. the chat opens with the DEFAULT line (lib/welcome-text.ts);
//   2. PATCH refuses an empty line and a 201-character one (400, the form's
//      words), takes a line (200, the detail carries it, trimmed),
//      tenant_public() gives it to anon, and the chat opens with it,
//      photographed into plan/welcome-text/;
//   3. the audit log has the super user's row with the column's name and
//      the before and after;
//   4. PATCH null clears it and the chat is back to the default.
// Nothing reaches OpenAI: the browser only loads the page.

import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { supabase } from '../packages/db/dist/service.js';
import { openBrowser } from './ui-refresh-cdp.mjs';

const BASE = process.argv[2] ?? 'http://localhost:3000';
const OUT = join(dirname(fileURLToPath(import.meta.url)), 'welcome-text');
mkdirSync(OUT, { recursive: true });
const DEFAULT = 'Discover more about our resort, accommodations, amenities, and booking options.';
const LINE = 'Ask about our cabins, the lake and how to book a weekend.';

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
  return { status: response.status, data, text, cookie: setCookie.find((c) => c.startsWith('rag_')) };
}
const err = (r) => (typeof r.data === 'object' && r.data ? r.data.error : String(r.data).slice(0, 60));

const stamp = Date.now();
const slug = `welcome-walk-${randomBytes(3).toString('hex')}`;
let userId = null;
let tenantId = null;
let browser = null;
try {
  const email = `welcome-walk-${stamp}@example.com`;
  const password = randomBytes(18).toString('base64url');
  const { data: user, error: userError } = await supabase.auth.admin.createUser({ email, password, email_confirm: true });
  if (userError) throw new Error(`create user: ${userError.message}`);
  userId = user.user.id;
  const { error: superError } = await supabase.from('platform_admins').insert({ user_id: userId });
  if (superError) throw new Error(`platform_admins: ${superError.message}`);
  const login = await call('POST', '/api/platform/session', { json: { email, password } });
  const cookie = login.cookie;
  if (login.status !== 200 || !cookie) throw new Error(`login ${login.status}: ${err(login)}`);
  const created = await call('POST', '/api/platform/tenants', { cookie, json: { slug, businessName: 'Lakeside Cabins', assistantName: 'Nina' } });
  tenantId = created.data?.id ?? null;
  if (!tenantId) throw new Error(`create tenant ${created.status}: ${err(created)}`);
  const doc = await supabase.from('documents').insert({ tenant_id: tenantId, title: 'About the cabins', content: 'Six cabins by the lake.' });
  if (doc.error) throw new Error(`document: ${doc.error.message}`);

  browser = await openBrowser({ scheme: 'light' });
  const { page } = browser;
  await page.viewport(375);
  /** The welcome card's line, as rendered. */
  async function welcomeLine() {
    await page.goto(`${BASE}/t/${slug}`);
    await page.until("!!document.querySelector('.welcome-text')", 30000);
    return page.eval("document.querySelector('.welcome-text')?.textContent ?? null");
  }

  // 1
  {
    const shown = await welcomeLine();
    check(created.data.welcomeText === null && shown === DEFAULT, '1. a new tenant: welcomeText null, the chat opens with the default line', JSON.stringify(shown));
  }

  // 2
  {
    const empty = await call('PATCH', `/api/platform/tenants/${tenantId}`, { cookie, json: { welcomeText: '' } });
    const long = await call('PATCH', `/api/platform/tenants/${tenantId}`, { cookie, json: { welcomeText: 'x'.repeat(201) } });
    const set = await call('PATCH', `/api/platform/tenants/${tenantId}`, { cookie, json: { welcomeText: `  ${LINE}  ` } });
    const pub = await supabase.rpc('tenant_public', { p_slug: slug });
    const shown = await welcomeLine();
    await page.shot(join(OUT, 'welcome-375.png'));
    check(
      empty.status === 400 && long.status === 400 && set.status === 200 && set.data.welcomeText === LINE && pub.data?.[0]?.welcome_text === LINE && shown === LINE,
      '2. PATCH: empty 400, 201 characters 400, a line 200 and trimmed; tenant_public() carries it; the chat opens with it (plan/welcome-text/welcome-375.png)',
      `${empty.status} "${err(empty)}" · ${long.status} "${err(long)}" · ${set.status} ${JSON.stringify(set.data?.welcomeText)} · public ${JSON.stringify(pub.data?.[0]?.welcome_text)} · shown ${JSON.stringify(shown)}`,
    );
  }

  // 3
  {
    const { data: rows } = await supabase.from('audit_log').select('actor_kind, actor_user, area, action, changed, before, after').eq('tenant_id', tenantId).eq('area', 'tenant').order('id', { ascending: false }).limit(1);
    const row = rows?.[0];
    check(
      row?.actor_kind === 'super' && row.actor_user === userId && row.action === 'update' && row.changed?.includes('welcome_text') && row.before?.welcome_text === null && row.after?.welcome_text === LINE,
      '3. the audit log: the super user updated the tenant, welcome_text named, before null and after the line',
      row ? `${row.actor_kind} ${row.action} changed ${JSON.stringify(row.changed)} before ${JSON.stringify(row.before?.welcome_text)} after ${JSON.stringify(row.after?.welcome_text)}` : 'no row',
    );
  }

  // 4
  {
    const cleared = await call('PATCH', `/api/platform/tenants/${tenantId}`, { cookie, json: { welcomeText: null } });
    const shown = await welcomeLine();
    check(cleared.status === 200 && cleared.data.welcomeText === null && shown === DEFAULT, '4. PATCH null clears it; the chat is back to the default line', `${cleared.status} ${JSON.stringify(cleared.data?.welcomeText)} · shown ${JSON.stringify(shown)}`);
  }
} catch (error) {
  check(false, 'setup', error.message);
} finally {
  browser?.close();
  if (tenantId) await supabase.from('tenants').delete().eq('id', tenantId);
  if (userId) {
    await supabase.from('platform_admins').delete().eq('user_id', userId);
    await supabase.auth.admin.deleteUser(userId);
  }
}
console.log(failures ? `\n${failures} FAILED` : '\nwelcome-text walk: all passed');
process.exit(failures ? 1 : 0);
