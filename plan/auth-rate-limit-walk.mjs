// Audit S-2 / B-4 (D-157): the sign-in and reset doors are limited, over HTTP.
//
//   (cd packages/db && node --conditions=react-server --env-file=../../.env ../../plan/auth-rate-limit-walk.mjs)
//
// Needs the app running (next start or pnpm dev). Every call is a wrong
// password or a reset for a made-up @example.com account: no real account is
// touched and no email is sent. Each run uses fresh addresses (the count
// outlives the process, D-137) and a fresh account.
//
// 1. Staff login, one address, ten different accounts: ten 401s, then the
//    11th is the 429 with the limit's own sentence (the address count).
// 2. Platform login, one account, eleven addresses: ten 401s, then 429 (the
//    account count, which an attacker rotating addresses meets).
// 3. Staff "Forgot password?", one account: three answers, the 4th is 429.
// 4. The tables hold the counts: villa's rate_windows has the address key at
//    11; platform_rate_windows holds no email or address in clear.
import { randomBytes } from 'node:crypto';
import { supabase } from '../packages/db/dist/service.js';

const BASE = process.env.WALK_BASE ?? 'http://localhost:3000';
const SLUG = 'villa';
const LIMITED = 'Too many attempts. Please wait a few minutes and try again.';
const run = randomBytes(3).toString('hex');
const addr = (i) => `198.51.${parseInt(run.slice(0, 2), 16)}.${i}`;
let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failures++;
};
const post = async (path, body, ip) => {
  const response = await fetch(`${BASE}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip }, body: JSON.stringify(body) });
  return { status: response.status, error: (await response.json().catch(() => ({}))).error };
};

const { data: tenant } = await supabase.from('tenants').select('id').eq('slug', SLUG).single();

// 1.
{
  const ip = addr(1);
  const statuses = [];
  let last;
  for (let i = 0; i < 11; i++) {
    last = await post(`/api/t/${SLUG}/admin/session`, { email: `walk-${run}-${i}@example.com`, password: 'wrong-password' }, ip);
    statuses.push(last.status);
  }
  check(
    statuses.slice(0, 10).every((s) => s === 401) && statuses[10] === 429 && last.error === LIMITED,
    '1. staff login: ten 401s from one address, the 11th is 429 with the limit sentence',
    `${statuses.join(',')} · ${last.error}`,
  );
  const { data: rows } = await supabase.from('rate_windows').select('count').eq('tenant_id', tenant.id).eq('key', `login|${tenant.id}|ip|${ip}`);
  check(rows?.length === 1 && rows[0].count === 11, '4a. rate_windows holds the address key, count 11', `rows ${rows?.length} · count ${rows?.[0]?.count}`);
}

// 2.
{
  const email = `walk-${run}-platform@example.com`;
  const statuses = [];
  let last;
  for (let i = 0; i < 11; i++) {
    last = await post('/api/platform/session', { email, password: 'wrong-password' }, addr(100 + i));
    statuses.push(last.status);
  }
  check(
    statuses.slice(0, 10).every((s) => s === 401) && statuses[10] === 429 && last.error === LIMITED,
    '2. platform login: one account from eleven addresses, ten 401s, the 11th is 429',
    `${statuses.join(',')} · ${last.error}`,
  );
  const { data: clear } = await supabase.from('platform_rate_windows').select('key').or(`key.like.*${run}*,key.like.*198.51*`);
  check((clear ?? []).length === 0, '4b. platform_rate_windows holds no email or address in clear', `${clear?.length} rows`);
}

// 3.
{
  const email = `walk-${run}-reset@example.com`;
  const results = [];
  for (let i = 0; i < 4; i++) results.push(await post(`/api/t/${SLUG}/admin/password-reset`, { email }, addr(200)));
  check(
    results.slice(0, 3).every((r) => r.status === 200) && results[3].status === 429 && results[3].error === LIMITED,
    '3. staff reset: three answers for one account, the 4th is 429',
    results.map((r) => r.status).join(','),
  );
}

console.log(failures === 0 ? '\nALL AUTH RATE LIMIT WALK CHECKS PASS' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
