// sources-access-walk.mjs — who sees the sources behind a reply (D-140),
// against pnpm dev: the chat route sends the chunks to a signed-in member
// with sources:read and to nobody else, in both deliveries.
//
//   (cd packages/db && node --conditions=react-server --env-file=../../.env ../../plan/sources-access-walk.mjs)
//
// On a THROWAWAY tenant with three THROWAWAY members (owner, admin, staff),
// all removed at the end by the ids this run made (trap 26). Every question
// is "hello", answered in code (D-049): nothing reaches OpenAI, and the
// reply still carries `sources` ([]) and `searchQuery` for whoever may see
// them. What is checked is whether the KEYS are there, which is the route's
// doing, not the pipeline's. Each request sends a fresh X-Forwarded-For
// (D-137: the count outlives the process).
//   1. a guest, JSON: 200 with a reply, no `sources`, no `searchQuery`;
//      the tool calls key is still there;
//   2. a guest, the stream: the meta event has no `sources`;
//   3. staff: none either; owner and admin: `sources` is an array and
//      `searchQuery` a string, JSON and stream alike;
//   4. the tenant's own permissions (D-128): a row grants staff
//      sources:read and they get the list; a row takes it from the owner
//      and they do not; the rows removed, the defaults are back.

import { randomBytes } from 'node:crypto';
import { supabase } from '../packages/db/dist/service.js';

const BASE = process.argv[2] ?? 'http://localhost:3000';
let failures = 0;
const check = (ok, what, detail = '') => {
  failures += ok ? 0 : 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? `  — ${detail}` : ''}`);
};
const freshIp = () => `10.${randomBytes(1)[0]}.${randomBytes(1)[0]}.${randomBytes(1)[0]}`;

const stamp = Date.now();
const slug = `sources-walk-${randomBytes(3).toString('hex')}`;
const users = [];
let tenantId = null;

async function login(email, password) {
  const r = await fetch(`${BASE}/api/t/${slug}/admin/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
  const cookie = (r.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).find((c) => c.startsWith('rag_admin='));
  if (r.status !== 200 || !cookie) throw new Error(`login ${email}: ${r.status}`);
  return cookie;
}
/** The JSON delivery: the keys the body has, and the status. */
async function askJson(cookie) {
  const r = await fetch(`${BASE}/api/t/${slug}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-forwarded-for': freshIp(), ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify({ conversationId: null, message: 'hello' }),
  });
  const body = await r.json();
  return { status: r.status, keys: Object.keys(body).sort(), body };
}
/** The stream: the meta event's keys. */
async function askStream(cookie) {
  const r = await fetch(`${BASE}/api/t/${slug}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', 'x-forwarded-for': freshIp(), ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify({ conversationId: null, message: 'hello' }),
  });
  const text = await r.text();
  const meta = /event: meta\ndata: (.*)\n/.exec(text);
  return { status: r.status, type: r.headers.get('content-type'), metaKeys: meta ? Object.keys(JSON.parse(meta[1])).sort() : null, done: text.includes('event: done') };
}
const hasSources = (keys) => keys?.includes('sources') && keys.includes('searchQuery');

try {
  const { data: t, error } = await supabase.from('tenants').insert({ slug, business_name: 'Sources Walk', assistant_name: 'Sol' }).select('id').single();
  if (error) throw new Error(error.message);
  tenantId = t.id;
  const members = {};
  for (const role of ['owner', 'admin', 'staff']) {
    const email = `sources-walk-${role}-${stamp}@example.com`;
    const password = randomBytes(18).toString('base64url');
    const { data, error: userError } = await supabase.auth.admin.createUser({ email, password, email_confirm: true });
    if (userError) throw new Error(`create ${role}: ${userError.message}`);
    users.push(data.user.id);
    const { error: memberError } = await supabase.from('memberships').insert({ user_id: data.user.id, tenant_id: tenantId, role });
    if (memberError) throw new Error(`membership ${role}: ${memberError.message}`);
    members[role] = { cookie: await login(email, password) };
  }

  // 1
  {
    const guest = await askJson(null);
    check(
      guest.status === 200 && typeof guest.body.reply === 'string' && !guest.keys.includes('sources') && !guest.keys.includes('searchQuery') && guest.keys.includes('toolCalls'),
      '1. a guest, JSON: a reply, no sources, no searchQuery; toolCalls still there',
      `${guest.status} keys ${guest.keys.join(',')}`,
    );
  }

  // 2
  {
    const guest = await askStream(null);
    check(guest.status === 200 && guest.type?.includes('text/event-stream') && guest.metaKeys !== null && !hasSources(guest.metaKeys) && guest.done, '2. a guest, the stream: meta without sources, then done', `${guest.status} meta ${guest.metaKeys?.join(',')} done ${guest.done}`);
  }

  // 3
  {
    const staffJson = await askJson(members.staff.cookie);
    const staffStream = await askStream(members.staff.cookie);
    const adminJson = await askJson(members.admin.cookie);
    const adminStream = await askStream(members.admin.cookie);
    const ownerJson = await askJson(members.owner.cookie);
    check(
      !hasSources(staffJson.keys) && !hasSources(staffStream.metaKeys) && hasSources(adminJson.keys) && Array.isArray(adminJson.body.sources) && typeof adminJson.body.searchQuery === 'string' && hasSources(adminStream.metaKeys) && hasSources(ownerJson.keys),
      '3. staff: no sources (JSON and stream); admin and owner: sources an array and searchQuery a string, both deliveries',
      `staff ${staffJson.keys.join(',')} | ${staffStream.metaKeys?.join(',')} · admin ${adminJson.keys.join(',')} | ${adminStream.metaKeys?.join(',')} · owner ${ownerJson.keys.join(',')}`,
    );
  }

  // 4
  {
    const rows = await supabase.from('role_permissions').insert([
      { tenant_id: tenantId, role: 'staff', permission: 'sources:read', allowed: true },
      { tenant_id: tenantId, role: 'owner', permission: 'sources:read', allowed: false },
    ]);
    if (rows.error) throw new Error(`role_permissions: ${rows.error.message}`);
    const staffGranted = await askJson(members.staff.cookie);
    const ownerTaken = await askJson(members.owner.cookie);
    const adminStill = await askJson(members.admin.cookie);
    const gone = await supabase.from('role_permissions').delete().eq('tenant_id', tenantId).select('role');
    const staffBack = await askJson(members.staff.cookie);
    const ownerBack = await askJson(members.owner.cookie);
    check(
      hasSources(staffGranted.keys) && !hasSources(ownerTaken.keys) && hasSources(adminStill.keys) && gone.data?.length === 2 && !hasSources(staffBack.keys) && hasSources(ownerBack.keys),
      "4. the tenant's rows: staff granted sees sources, the owner stripped does not, admin unchanged; rows removed, the defaults are back",
      `granted staff ${hasSources(staffGranted.keys)} · stripped owner ${hasSources(ownerTaken.keys)} · admin ${hasSources(adminStill.keys)} · removed ${gone.data?.length} · back: staff ${hasSources(staffBack.keys)} owner ${hasSources(ownerBack.keys)}`,
    );
  }
} catch (error) {
  check(false, 'setup', error.message);
} finally {
  if (tenantId) await supabase.from('tenants').delete().eq('id', tenantId);
  for (const id of users) await supabase.auth.admin.deleteUser(id);
}
console.log(failures ? `\n${failures} FAILED` : '\nsources-access walk: all passed');
process.exit(failures ? 1 : 0);
