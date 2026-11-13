// Audit S-7 (D-164): a state-changing request must come from our own pages.
// Against pnpm dev or next start; no login, no OpenAI call, nothing written
// (book/quote reads; the refused requests never reach a handler).
//
//   (cd packages/db && node --conditions=react-server --env-file=../../.env ../../plan/same-origin-walk.mjs)
//
// 1. A POST naming another site in Origin is 403, before the route runs.
// 2. A POST from a sibling subdomain of the same host is 403 too.
// 3. text/plain and urlencoded bodies are 415, even with our own Origin.
// 4. In a real browser, our own page's fetch (Chrome sets Origin) still
//    gets its answer: book/quote is 200 from the booking page.
// 5. A page on another origin, in the same browser, posting to us with
//    credentials gets 403 (seen in the network log: the request was sent
//    and refused, not only hidden by CORS).
import { createServer } from 'node:http';
import { openBrowser } from './ui-refresh-cdp.mjs';
import { supabase } from '../packages/db/dist/service.js';

const BASE = process.env.WALK_BASE ?? 'http://localhost:3000';
const SLUG = 'villa';
let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failures++;
};
const ip = `198.20.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
const post = async (path, { origin, type = 'application/json', body = '{}' } = {}) => {
  const headers = { 'X-Forwarded-For': ip, 'Content-Type': type };
  if (origin) headers.Origin = origin;
  const response = await fetch(`${BASE}${path}`, { method: 'POST', headers, body });
  return { status: response.status, error: (await response.json().catch(() => ({}))).error };
};

const { data: tenant } = await supabase.from('tenants').select('id').eq('slug', SLUG).single();
const { data: unit } = await supabase.from('units').select('id').eq('tenant_id', tenant.id).eq('active', true).limit(1).single();
const { data: slot } = await supabase.from('slots').select('id').eq('tenant_id', tenant.id).eq('active', true).order('id').limit(1).single();
const quote = JSON.stringify({ slotId: slot.id, rooms: [{ unitId: unit.id, guests: 2 }], checkIn: '2027-03-15', nights: 1 });
const host = new URL(BASE).host;

// 1–3.
{
  const foreign = await post(`/api/t/${SLUG}/book/quote`, { origin: 'https://evil.example', body: quote });
  check(foreign.status === 403 && /did not come from this site/.test(foreign.error ?? ''), '1. another site in Origin is 403', `${foreign.status} "${foreign.error}"`);
  const sibling = await post(`/api/t/${SLUG}/admin/session`, { origin: `http://staff.${host}`, body: JSON.stringify({ email: 'a@example.com', password: 'x' }) });
  check(sibling.status === 403, '2. a sibling subdomain posting to the staff login is 403', `${sibling.status}`);
  const plain = await post(`/api/t/${SLUG}/book/quote`, { origin: new URL(BASE).origin, type: 'text/plain;charset=UTF-8', body: quote });
  const form = await post(`/api/t/${SLUG}/admin/session`, { type: 'application/x-www-form-urlencoded', body: 'email=a%40example.com&password=x' });
  check(plain.status === 415 && form.status === 415, '3. text/plain and urlencoded bodies are 415, even from our own origin', `${plain.status} · ${form.status}`);
}

// 4–5.
let browser;
const attacker = createServer((_, res) => res.writeHead(200, { 'Content-Type': 'text/html' }).end('<!doctype html><title>decoy</title>'));
try {
  browser = await openBrowser({ scheme: 'light' });
  const { page } = browser;
  const statuses = [];
  await page.send('Network.enable');
  page.on('Network.responseReceived', ({ response }) => {
    if (response.url.includes('/book/quote')) statuses.push(response.status);
  });

  await page.goto(`${BASE}/t/${SLUG}/book`);
  const own = await page.eval(`fetch('/api/t/${SLUG}/book/quote', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: ${JSON.stringify(quote)} }).then((r) => r.status)`);
  check(own === 200, '4. our own booking page, in a browser (Chrome sets Origin), gets its quote', `${own}`);

  await new Promise((r) => attacker.listen(0, '127.0.0.1', r));
  const other = `http://127.0.0.1:${attacker.address().port}`;
  statuses.length = 0;
  await page.goto(`${other}/`);
  await page.eval(`fetch('${BASE}/api/t/${SLUG}/book/quote', { method: 'POST', mode: 'no-cors', credentials: 'include', headers: { 'Content-Type': 'text/plain' }, body: ${JSON.stringify(quote)} }).catch(() => null)`);
  await new Promise((r) => setTimeout(r, 1500));
  check(statuses.includes(403), '5. a page on another origin posting with credentials is sent and refused (403)', `network: ${statuses.join(',') || 'none seen'}`);
} catch (error) {
  check(false, 'browser', error.message);
} finally {
  browser?.close();
  attacker.close();
}

console.log(failures === 0 ? '\nALL SAME-ORIGIN WALK CHECKS PASS' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
