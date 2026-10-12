// conversations-walk.mjs — S-16 Conversations over HTTP and in a browser
// (plan/conversations.md Phase 4, D-115).
//
// Seeds two conversations into harbor through the service client (one with a
// refusal, a table answer and an interrupted reply; one that says a unique
// phrase), logs in as a probe STAFF member (the lowest role: § 7 q1 gives
// every member the screen), and checks the routes, then the two pages, with
// screenshots in light and dark at 1280 and 390. Deletes everything it made.
//
//   (cd packages/db && node --conditions=react-server --env-file=../../.env ../../plan/conversations-walk.mjs)
//
// Needs pnpm dev.

import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { supabase } from '../packages/db/dist/service.js';
import { openBrowser } from './ui-refresh-cdp.mjs';

const BASE = process.argv[2] ?? 'http://localhost:3000';
const SLUG = 'harbor';
const OUT = join(dirname(fileURLToPath(import.meta.url)), 'conversations', 'walk');
const MARKER = "I don't know based on the documents I have.";
const PHRASE = `walk-phrase-${Date.now()}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failures++;
};

const { data: tenant } = await supabase.from('tenants').select('id').eq('slug', SLUG).single();
const { data: villa } = await supabase.from('tenants').select('id').eq('slug', 'villa').single();
let userId;
let browser;
const made = [];
try {
  // The seed. Times a minute apart, newest last, so A and B lead the list.
  const ago = (min) => new Date(Date.now() - min * 60_000).toISOString();
  const conversation = async (tenantId) => {
    const { data, error } = await supabase.from('conversations').insert({ tenant_id: tenantId }).select('id').single();
    if (error) throw new Error(error.message);
    made.push(data.id);
    return data.id;
  };
  const A = await conversation(tenant.id);
  const B = await conversation(tenant.id);
  const V = await conversation(villa.id);
  const msg = (conversation_id, tenant_id, role, content, min) => ({ tenant_id, conversation_id, role, content, created_at: ago(min) });
  const seeded = await supabase.from('messages').insert([
    msg(A, tenant.id, 'user', 'Do you have a sauna?', 6),
    msg(A, tenant.id, 'assistant', MARKER, 6),
    msg(A, tenant.id, 'user', 'Which rooms are there?', 5),
    msg(A, tenant.id, 'assistant', 'We have two rooms:\n\n| Room | Guests |\n|---|---|\n| Garden Room | 2 |\n| Sea Room | 4 |', 5),
    msg(A, tenant.id, 'user', 'And breakfast?', 4),
    msg(A, tenant.id, 'assistant', 'Breakfast is served from […answer interrupted]', 4),
    msg(B, tenant.id, 'user', `Is the ${PHRASE} open today?`, 2),
    msg(B, tenant.id, 'assistant', 'Yes, from 9 AM.', 2),
    msg(V, villa.id, 'user', 'A villa question', 1),
    msg(V, villa.id, 'assistant', 'A villa answer.', 1),
  ]).select('id, conversation_id, content');
  if (seeded.error) throw new Error(seeded.error.message);
  const refusalId = seeded.data.find((m) => m.conversation_id === A && m.content === MARKER).id;

  // A STAFF member of harbor.
  const email = `conversations-walk-${Date.now()}@example.com`;
  const password = randomBytes(18).toString('base64url');
  const { data: user, error: userError } = await supabase.auth.admin.createUser({ email, password, email_confirm: true });
  if (userError) throw new Error(userError.message);
  userId = user.user.id;
  const m = await supabase.from('memberships').insert({ user_id: userId, tenant_id: tenant.id, role: 'staff' });
  if (m.error) throw new Error(m.error.message);
  const login = await fetch(`${BASE}/api/t/${SLUG}/admin/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
  const cookie = (login.headers.getSetCookie?.() ?? []).find((x) => x.startsWith('rag_admin='))?.split(';')[0];
  if (!cookie) throw new Error('login failed');
  const call = (path, withCookie = true) => fetch(`${BASE}/api/t/${SLUG}${path}`, { headers: withCookie ? { cookie } : {} });

  // 1. Signed out: 401, not a list.
  const out = await call('/admin/conversations', false);
  check(out.status === 401, '1. the list without a session is 401', String(out.status));

  // 2. Staff: A and B lead the list, A with its refusal counted.
  const list = await call('/admin/conversations?days=7');
  const page = await list.json();
  const rowA = page.rows?.find((r) => r.id === A);
  const rowB = page.rows?.find((r) => r.id === B);
  check(
    list.status === 200 && page.rows[0]?.id === B && page.rows[1]?.id === A && rowA?.turns === 3 && rowA?.refusals === 1 && rowA?.firstQuestion === 'Do you have a sauna?' && rowB?.refusals === 0 && !page.rows.some((r) => r.id === V),
    '2. a staff member lists harbor\'s chats, newest first, the refusal counted; no villa chat',
    `${list.status} · first ${page.rows?.[0]?.id === B ? 'B' : page.rows?.[0]?.id} · A ${rowA?.turns}/${rowA?.refusals} · total ${page.total}`,
  );

  // 3. The search asks the server over every message; "only refused" keeps A.
  const found = await (await call(`/admin/conversations?q=${encodeURIComponent(PHRASE)}`)).json();
  const refusedOnly = await (await call('/admin/conversations?days=7&refused=1')).json();
  check(
    found.total === 1 && found.rows[0]?.id === B && refusedOnly.rows.some((r) => r.id === A) && !refusedOnly.rows.some((r) => r.id === B),
    '3. the search finds the chat that says it; "only unanswered" keeps A and drops B',
    `search ${found.total} · refused ${refusedOnly.total}`,
  );

  // 4. A's transcript: every kind named, the refusal open, the partial text without its suffix.
  const tr = await call(`/admin/conversations/${A}`);
  const transcript = await tr.json();
  check(
    tr.status === 200 && transcript.messages?.map((x) => x.kind).join(',') === 'question,refusal,question,answer,question,interrupted'
      && transcript.messages[1].resolved === false && transcript.messages[5].content === 'Breakfast is served from' && typeof transcript.fallback === 'string' && transcript.timezone,
    '4. the transcript names each message: question, refusal (open), answer, interrupted',
    `${tr.status} · ${transcript.messages?.map((x) => x.kind).join(',')} · tz ${transcript.timezone}`,
  );

  // 5. Not harbor's, malformed, and the removed open route: all 404.
  const foreign = await call(`/admin/conversations/${V}`);
  const malformed = await call('/admin/conversations/not-a-uuid');
  const oldRoute = await call(`/conversations/${A}/messages`, false);
  check(foreign.status === 404 && malformed.status === 404 && oldRoute.status === 404, '5. a villa chat, a malformed id and the removed open route are all 404', `${foreign.status} · ${malformed.status} · ${oldRoute.status}`);

  // 6. Unanswered carries the conversation id, for its link.
  const unanswered = await (await call('/unanswered')).json();
  const item = unanswered.find((u) => u.id === refusalId);
  check(item?.conversationId === A, '6. the Unanswered row of A\'s refusal carries A\'s id', item ? item.conversationId : 'not listed');

  // The browser: the staff cookie, then the two pages.
  browser = await openBrowser({ scheme: 'light' });
  const { page: tab } = browser;
  await tab.send('Network.setCookie', { name: 'rag_admin', value: cookie.slice('rag_admin='.length), url: `${BASE}/api/t/${SLUG}/`, path: `/api/t/${SLUG}` });
  await tab.viewport(1280);

  // 7. The list: A's row is badged; the sidebar has the item; the row opens the transcript.
  await tab.goto(`${BASE}/t/${SLUG}/admin/conversations?days=7`);
  await tab.until("!!document.querySelector('.conversation-row')", 30000);
  const badge = await tab.eval(`[...document.querySelectorAll('.conversation-row')].find(r => r.querySelector('a').getAttribute('href').includes(${JSON.stringify(A)}))?.querySelector('.badge')?.textContent ?? ''`);
  const navItem = await tab.eval("[...document.querySelectorAll('a')].some(a => a.textContent.trim() === 'Conversations' && a.getAttribute('aria-current') === 'page')");
  check(
    badge === '1 not answered' && navItem,
    '7. A\'s row says "1 not answered"; the sidebar marks Conversations current',
    badge ? `badge "${badge}" · nav ${navItem}` : `page: ${(await tab.eval('document.body.innerText')).replace(/\s+/g, ' ').slice(0, 300)}`,
  );
  await tab.shot(join(OUT, 'list-light-1280.png'));

  // 8. Typing in the search narrows the list on the server, and the URL keeps it.
  await tab.type('.list-search input', PHRASE);
  const narrowed = await tab.until("document.querySelectorAll('.conversation-row').length === 1", 10000);
  const url = await tab.eval('location.search');
  check(narrowed && url.includes(`q=${PHRASE}`) && url.includes('days=7'), '8. the search narrows to one row and the URL keeps the filters', url);

  // 9. The row opens its transcript; Back returns with the filters.
  await tab.click('.conversation-row-link');
  await tab.until("!!document.querySelector('.transcript')", 30000);
  const back = await tab.eval("[...document.querySelectorAll('a')].find(a => a.textContent.trim() === 'Conversations' && a.classList.contains('button'))?.getAttribute('href') ?? ''");
  check((await tab.eval('location.pathname')).endsWith(B) && back.includes(`q=${PHRASE}`), '9. the row opens its transcript; Back carries the search', back);

  // 10. A's transcript at ?m=<refusal>: the badge and the words the visitor saw, a drawn table, the interrupted badge, the focus.
  await tab.goto(`${BASE}/t/${SLUG}/admin/conversations/${A}?m=${refusalId}`);
  await tab.until("!!document.querySelector('.transcript')", 30000);
  await sleep(500);
  const shape = await tab.eval(`({
    refusal: document.querySelector('#message-${refusalId} .badge')?.textContent ?? '',
    saw: document.querySelector('#message-${refusalId} .transcript-refusal')?.textContent ?? '',
    focused: document.querySelector('#message-${refusalId}')?.classList.contains('focused') ?? false,
    table: document.querySelectorAll('.transcript table td').length,
    interrupted: [...document.querySelectorAll('.transcript .badge')].some(b => b.textContent === 'Interrupted'),
    html: document.querySelector('.transcript').innerHTML.includes('|---|'),
  })`);
  check(
    shape.refusal === 'Not answered' && shape.saw.startsWith('The visitor saw:') && shape.saw.includes('Open in Unanswered') && shape.focused && shape.table === 4 && shape.interrupted && !shape.html,
    '10. the transcript: "Not answered" with what the visitor saw, the table drawn as cells, "Interrupted", the refusal focused',
    JSON.stringify(shape),
  );
  await tab.shot(join(OUT, 'transcript-light-1280.png'));

  // 11. Unanswered links to it.
  await tab.goto(`${BASE}/t/${SLUG}/admin/unanswered`);
  await tab.until("!!document.querySelector('.unanswered')", 30000);
  const link = await tab.eval(`[...document.querySelectorAll('.unanswered a')].find(a => a.textContent === 'View conversation' && a.getAttribute('href').endsWith('${A}?m=${refusalId}'))?.getAttribute('href') ?? ''`);
  check(link !== '', '11. Unanswered\'s row links to the transcript at its refusal', link);

  // 12. Phone and dark: no sideways scroll on either page.
  const widths = [];
  for (const scheme of ['light', 'dark']) {
    await tab.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] });
    for (const width of [1280, 390]) {
      await tab.viewport(width);
      for (const [name, path] of [['list', '/admin/conversations?days=7'], ['transcript', `/admin/conversations/${A}`]]) {
        await tab.goto(`${BASE}/t/${SLUG}${path}`);
        await tab.until(`!!document.querySelector('${name === 'list' ? '.conversation-row' : '.transcript'}')`, 30000);
        await sleep(300);
        const docWidth = await tab.eval('document.documentElement.scrollWidth');
        widths.push(`${name} ${scheme} ${width}: ${docWidth}`);
        if (docWidth > width) check(false, `12. ${name} ${scheme} at ${width} scrolls sideways`, String(docWidth));
        await tab.shot(join(OUT, `${name}-${scheme}-${width}.png`));
      }
    }
  }
  check(widths.every((w) => Number(w.split(': ')[1]) <= Number(w.split(' ')[2].replace(':', ''))), '12. no sideways scroll, light and dark, 1280 and 390', widths.join(' · '));
} catch (error) {
  check(false, 'walk', error.message);
} finally {
  browser?.close();
  if (made.length) {
    const { error } = await supabase.from('conversations').delete().in('id', made);
    if (error) console.log(`WARN  could not delete the walk's conversations: ${error.message}`);
  }
  if (userId) {
    const { error } = await supabase.auth.admin.deleteUser(userId);
    if (error) console.log(`WARN  could not delete the walk user: ${error.message}`);
  }
  const { count } = await supabase.from('conversations').select('id', { count: 'exact', head: true }).in('id', made.length ? made : ['00000000-0000-0000-0000-000000000000']);
  console.log(`left behind: ${count ?? '?'} conversation(s)`);
}
console.log(failures === 0 ? '\nALL CONVERSATION WALK CHECKS PASS' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
