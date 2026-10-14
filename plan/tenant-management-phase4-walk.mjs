// tenant-management-phase4-walk.mjs — the platform and members routes over
// HTTP, against a running `pnpm dev` (plan/tenant-management.md Phase 4).
//
// Creates, and deletes at the end: a throwaway super user, two throwaway
// accounts (an owner-to-be and a staffer), and the tenant `probe-tm`, which
// the walk itself creates through the platform route. The service client is
// used ONLY to set up, look and clean up, never to do the thing tested.
// Every refusal has its positive twin (CLAUDE.md trap 12).
//
//   cd packages/db && node --conditions=react-server --env-file=../../.env ../../plan/tenant-management-phase4-walk.mjs [base-url]

import { randomBytes } from 'node:crypto';
import { supabase } from '../packages/db/dist/service.js';

const BASE = process.argv[2] ?? 'http://localhost:3000';
let failures = 0;
const check = (ok, label, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  — ${detail}`);
  if (!ok) failures++;
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
  return { status: response.status, data, cookie: setCookie.find((c) => c.startsWith('rag_')) };
}
const err = (r) => (typeof r.data === 'object' && r.data ? r.data.error : String(r.data).slice(0, 60));

const stamp = Date.now();
const users = {};
async function makeUser(name) {
  const email = `walk-tm-${name}-${stamp}@example.com`;
  const password = randomBytes(18).toString('base64url');
  const { data, error } = await supabase.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`create ${name}: ${error.message}`);
  users[name] = { id: data.user.id, email, password };
  return users[name];
}
const login = (email, password) => call('POST', '/api/platform/session', { json: { email, password } });
const tenantLogin = (slug, email, password) => call('POST', `/api/t/${slug}/admin/session`, { json: { email, password } });

let tenantId = null;
try {
  const superUser = await makeUser('super');
  await makeUser('owner');
  await makeUser('staffer');
  const { error: superError } = await supabase.from('platform_admins').insert({ user_id: superUser.id });
  if (superError) throw new Error(`platform_admins: ${superError.message}`);

  // 1. Login: the right password → 200 and a rag_platform cookie; a real
  //    account that does not run the platform, a wrong password and an
  //    unknown email → the same 401 message. No cookie: GET says platform false.
  const ok = await login(superUser.email, superUser.password);
  const cookie = ok.cookie;
  const notSuper = await login(users.owner.email, users.owner.password);
  const wrong = await login(superUser.email, 'not-it');
  const unknown = await login(`nobody-${stamp}@example.com`, 'whatever');
  const anon = await call('GET', '/api/platform/session');
  check(
    ok.status === 200 && cookie?.startsWith('rag_platform=') && notSuper.status === 401 && wrong.status === 401 && unknown.status === 401 && err(notSuper) === err(wrong) && err(wrong) === err(unknown) && anon.data.platform === false,
    '1. platform login: 200 + cookie; three failures, one message; no cookie → platform false',
    `${ok.status} ${cookie ? cookie.split('.').length + ' parts' : 'NO COOKIE'} · ${notSuper.status}/${wrong.status}/${unknown.status} "${err(wrong)}" · anon ${JSON.stringify(anon.data)}`,
  );

  // 2. Create: a bad slug → 400 (the form's words), a reserved slug → 400
  //    (Postgres's), then probe-tm → 201; the same slug again → 409.
  const badSlug = await call('POST', '/api/platform/tenants', { cookie, json: { slug: 'Probe TM', businessName: 'x', assistantName: 'y' } });
  const reserved = await call('POST', '/api/platform/tenants', { cookie, json: { slug: 'platform', businessName: 'x', assistantName: 'y' } });
  const created = await call('POST', '/api/platform/tenants', { cookie, json: { slug: 'probe-tm', businessName: 'Probe Resort', assistantName: 'Pia' } });
  tenantId = created.data?.id ?? null;
  const dup = await call('POST', '/api/platform/tenants', { cookie, json: { slug: 'probe-tm', businessName: 'x', assistantName: 'y' } });
  check(
    badSlug.status === 400 && reserved.status === 400 && created.status === 201 && typeof tenantId === 'number' && created.data.members === 0 && dup.status === 409,
    '2. create: bad slug 400, reserved 400, probe-tm 201 with 0 members, duplicate 409',
    `${badSlug.status} "${err(badSlug)}" · ${reserved.status} "${err(reserved)}" · ${created.status} #${tenantId} · ${dup.status} "${err(dup)}"`,
  );
  if (!tenantId) throw new Error('no tenant to walk with');

  // 3. List and get: the new tenant is in the list; GET by id has the detail.
  const list = await call('GET', '/api/platform/tenants', { cookie });
  const one = await call('GET', `/api/platform/tenants/${tenantId}`, { cookie });
  check(
    list.status === 200 && list.data.some((t) => t.slug === 'probe-tm') && list.data.some((t) => t.slug === 'villa') && one.status === 200 && one.data.slug === 'probe-tm' && one.data.applications.length === 0,
    '3. list holds probe-tm and villa; GET by id has the detail',
    `list ${list.status} (${list.data.length} tenants) · one ${one.status} ${one.data.slug} apps ${JSON.stringify(one.data.applications)}`,
  );

  // 4. Edit: names and a theme → 200 and the tenant's chat page shows the
  //    new name; a bad colour → 400 from zod; an http logo → 400; a theme
  //    that bypasses zod's shape cannot be sent, so Postgres's wall is
  //    verify's (check 102).
  const edited = await call('PATCH', `/api/platform/tenants/${tenantId}`, {
    cookie,
    json: { businessName: 'Probe Resort & Spa', theme: { accent: '#0f766e', bg: '#faf7f2' }, fallbackMessages: { english: 'Sorry, ask the desk.' } },
  });
  const page = await fetch(`${BASE}/t/probe-tm`);
  const html = await page.text();
  const badColour = await call('PATCH', `/api/platform/tenants/${tenantId}`, { cookie, json: { theme: { accent: 'url(x)' } } });
  const httpLogo = await call('PATCH', `/api/platform/tenants/${tenantId}`, { cookie, json: { logoUrl: 'http://example.com/logo.png' } });
  const slugEdit = await call('PATCH', `/api/platform/tenants/${tenantId}`, { cookie, json: { slug: 'other' } });
  check(
    edited.status === 200 && edited.data.businessName === 'Probe Resort & Spa' && page.status === 200 && html.includes('Probe Resort &amp; Spa') && html.includes('--accent:#0f766e') && badColour.status === 400 && httpLogo.status === 400 && slugEdit.status === 400,
    '4. edit names, theme and fallback → 200 and the page shows them; bad colour, http logo and a slug edit → 400',
    `${edited.status} · page ${page.status} name ${html.includes('Probe Resort &amp; Spa')} accent ${html.includes('--accent:#0f766e')} · ${badColour.status} "${err(badColour)}" · ${httpLogo.status} · slug ${slugEdit.status}`,
  );

  // 5. Applications: bookings with no timezone → 400 (the trigger's sentence);
  //    with a timezone → 200 and the key is on; max_stay_nights 0 → 400;
  //    3 nights and 60 days → 200; an unknown key → 400.
  //    D-130 first: without a signed DPA the switch is refused, in words; the
  //    date recorded on the Legal tab's PATCH, the checks below run as before.
  const noDpa = await call('PUT', `/api/platform/tenants/${tenantId}/applications/bookings`, { cookie, json: { config: { timezone: 'Asia/Manila' } } });
  const dpa = await call('PATCH', `/api/platform/tenants/${tenantId}`, { cookie, json: { dpaSignedOn: '2026-10-01' } });
  check(
    noDpa.status === 400 && /data processing agreement/.test(err(noDpa) ?? '') && dpa.status === 200 && dpa.data.legal?.dpaSignedOn === '2026-10-01',
    '5a. D-130: bookings without a signed DPA → 400 in words; the DPA date recorded → 200',
    `${noDpa.status} "${err(noDpa)}" · dpa ${dpa.status} ${dpa.data?.legal?.dpaSignedOn}`,
  );
  const noTz = await call('PUT', `/api/platform/tenants/${tenantId}/applications/bookings`, { cookie, json: { config: {} } });
  const on = await call('PUT', `/api/platform/tenants/${tenantId}/applications/bookings`, { cookie, json: { config: { timezone: 'Asia/Manila' } } });
  const zero = await call('PUT', `/api/platform/tenants/${tenantId}/applications/bookings`, { cookie, json: { config: { timezone: 'Asia/Manila', max_stay_nights: 0 } } });
  const limits = await call('PUT', `/api/platform/tenants/${tenantId}/applications/bookings`, { cookie, json: { config: { timezone: 'Asia/Manila', max_stay_nights: 3, max_advance_days: 60 } } });
  const unknownApp = await call('PUT', `/api/platform/tenants/${tenantId}/applications/payments`, { cookie, json: { config: {} } });
  check(
    noTz.status === 400 && /timezone/.test(err(noTz) ?? '') && on.status === 200 && on.data.applications.includes('bookings') && zero.status === 400 && /1 to 60/.test(err(zero) ?? '') && limits.status === 200 && limits.data.applicationConfigs.bookings.max_stay_nights === 3 && unknownApp.status === 400,
    '5. applications: no timezone 400, on 200, 0 nights 400, 3/60 200, unknown key 400',
    `${noTz.status} "${err(noTz)}" · on ${on.status} · zero ${zero.status} "${err(zero)}" · limits ${limits.status} → ${JSON.stringify(limits.data.applicationConfigs?.bookings)} · payments ${unknownApp.status}`,
  );

  // 6. Members, from the platform: an unknown email → 404 naming the CLI;
  //    the owner-to-be as owner → 201; the staffer as staff → 201; the list
  //    has 2 with emails; demoting the only owner → 409 (Postgres's words).
  const noAccount = await call('POST', `/api/platform/tenants/${tenantId}/members`, { cookie, json: { email: `ghost-${stamp}@example.com`, role: 'owner' } });
  const addOwner = await call('POST', `/api/platform/tenants/${tenantId}/members`, { cookie, json: { email: users.owner.email.toUpperCase(), role: 'owner' } });
  const addStaff = await call('POST', `/api/platform/tenants/${tenantId}/members`, { cookie, json: { email: users.staffer.email, role: 'staff' } });
  const again = await call('POST', `/api/platform/tenants/${tenantId}/members`, { cookie, json: { email: users.staffer.email, role: 'admin' } });
  const demote = await call('PATCH', `/api/platform/tenants/${tenantId}/members`, { cookie, json: { userId: users.owner.id, role: 'staff' } });
  check(
    noAccount.status === 404 && /member:add/.test(err(noAccount) ?? '') && addOwner.status === 201 && addStaff.status === 201 && addStaff.data.length === 2 && addStaff.data.every((m) => m.email.includes('walk-tm-')) && again.status === 409 && demote.status === 409 && /no owner/.test(err(demote) ?? ''),
    '6. platform members: unknown email 404 (names member:add), owner 201, staff 201 (2 listed with emails), duplicate 409, last-owner demotion 409',
    `${noAccount.status} · ${addOwner.status} · ${addStaff.status} (${addStaff.data?.length}) · again ${again.status} · demote ${demote.status} "${err(demote)}"`,
  );

  // 6b. "Make me an owner" (plan § 8 q5): the platform adds ITSELF by user id
  //     → 201 and it is listed as owner; then removes itself → 200 (the other
  //     owner stays, so the last-owner trigger allows it), and the list is 2 again.
  const selfAdd = await call('POST', `/api/platform/tenants/${tenantId}/members`, { cookie, json: { userId: superUser.id, role: 'owner' } });
  const selfRemove = await call('DELETE', `/api/platform/tenants/${tenantId}/members`, { cookie, json: { userId: superUser.id } });
  check(
    selfAdd.status === 201 && selfAdd.data.some((m) => m.userId === superUser.id && m.role === 'owner') && selfRemove.status === 200 && selfRemove.data.length === 2,
    '6b. the platform adds itself as owner by user id → 201; removes itself → 200, 2 left',
    `add ${selfAdd.status} (${selfAdd.data?.length}) · remove ${selfRemove.status} (${selfRemove.data?.length})`,
  );

  // 7. The tenant's own members route: the owner (staff cookie) lists 2 and
  //    promotes the staffer to admin; the staffer (now admin) → 403 there,
  //    and 200 on the documents list; a platform cookie sent by hand → 401.
  const ownerLogin = await tenantLogin('probe-tm', users.owner.email, users.owner.password);
  const ownerCookie = ownerLogin.cookie;
  const ownerList = await call('GET', '/api/t/probe-tm/members', { cookie: ownerCookie });
  const promote = await call('PATCH', '/api/t/probe-tm/members', { cookie: ownerCookie, json: { userId: users.staffer.id, role: 'admin' } });
  const stafferLogin = await tenantLogin('probe-tm', users.staffer.email, users.staffer.password);
  const stafferMembers = await call('GET', '/api/t/probe-tm/members', { cookie: stafferLogin.cookie });
  const stafferDocs = await call('GET', '/api/t/probe-tm/documents', { cookie: stafferLogin.cookie });
  const platformAtTenant = await call('GET', '/api/t/probe-tm/members', { cookie });
  check(
    ownerLogin.status === 200 && ownerList.status === 200 && ownerList.data.length === 2 && promote.status === 200 && promote.data.find((m) => m.userId === users.staffer.id)?.role === 'admin' && stafferMembers.status === 403 && stafferDocs.status === 200 && platformAtTenant.status === 401,
    "7. owner's members route: list 2, promote → 200; admin → 403 there, 200 on documents; a platform cookie at a tenant → 401",
    `owner ${ownerLogin.status}/${ownerList.status} (${ownerList.data?.length}) promote ${promote.status} · admin members ${stafferMembers.status} "${err(stafferMembers)}" docs ${stafferDocs.status} · platform cookie ${platformAtTenant.status}`,
  );

  // 8. The other direction: a tenant cookie sent by hand to the platform → 401.
  const tenantAtPlatform = await call('GET', '/api/platform/tenants', { cookie: ownerCookie });
  check(tenantAtPlatform.status === 401, '8. a tenant cookie at the platform → 401', `${tenantAtPlatform.status} "${err(tenantAtPlatform)}"`);

  // 9. Archive: the chat page, the admin page and the chat route → 404; the
  //    platform still GETs it (by id) and the list shows archivedAt; unarchive
  //    → the page is back.
  const archived = await call('POST', `/api/platform/tenants/${tenantId}/archive`, { cookie });
  const gonePage = await fetch(`${BASE}/t/probe-tm`);
  const goneAdmin = await fetch(`${BASE}/t/probe-tm/admin`);
  const goneChat = await call('POST', '/api/t/probe-tm/chat', { json: { message: 'hello' } });
  const stillThere = await call('GET', `/api/platform/tenants/${tenantId}`, { cookie });
  const unarchived = await call('DELETE', `/api/platform/tenants/${tenantId}/archive`, { cookie });
  const backPage = await fetch(`${BASE}/t/probe-tm`);
  check(
    archived.status === 200 && archived.data.archivedAt && gonePage.status === 404 && goneAdmin.status === 404 && goneChat.status === 404 && stillThere.status === 200 && stillThere.data.archivedAt && unarchived.status === 200 && unarchived.data.archivedAt === null && backPage.status === 200,
    '9. archive: page, admin and chat → 404, platform GET still 200; unarchive → page 200',
    `archive ${archived.status} · page ${gonePage.status} admin ${goneAdmin.status} chat ${goneChat.status} · platform ${stillThere.status} · unarchive ${unarchived.status} · page ${backPage.status}`,
  );

  // 10. Switch bookings off (no bookings exist) → 200 and the key is gone;
  //     again → 404.
  const off = await call('DELETE', `/api/platform/tenants/${tenantId}/applications/bookings`, { cookie });
  const offAgain = await call('DELETE', `/api/platform/tenants/${tenantId}/applications/bookings`, { cookie });
  check(off.status === 200 && off.data.applications.length === 0 && offAgain.status === 404, '10. bookings off → 200 (no key), again → 404', `${off.status} ${JSON.stringify(off.data.applications)} · ${offAgain.status}`);

  // 11. Removed mid-session: the platform_admins row gone, the SAME cookie → 401.
  await supabase.from('platform_admins').delete().eq('user_id', superUser.id);
  const after = await call('GET', '/api/platform/tenants', { cookie });
  const session = await call('GET', '/api/platform/session', { cookie });
  check(after.status === 401 && session.data.platform === false, '11. super:remove mid-session → next request 401, session says false', `${after.status} "${err(after)}" · session ${JSON.stringify(session.data)}`);
} catch (error) {
  check(false, 'walk setup', error.message);
} finally {
  if (tenantId) {
    const { error } = await supabase.from('tenants').delete().eq('id', tenantId);
    if (error) console.log(`WARN  could not delete probe-tm: ${error.message}`);
  }
  for (const user of Object.values(users)) {
    const { error } = await supabase.auth.admin.deleteUser(user.id);
    if (error) console.log(`WARN  could not delete ${user.email}: ${error.message}`);
  }
}

console.log(failures ? `\n${failures} FAILED` : '\nALL PHASE 4 WALK CHECKS PASS');
process.exit(failures ? 1 : 0);
