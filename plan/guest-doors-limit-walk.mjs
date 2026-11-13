// Audit S-4 and S-5 (D-162), over HTTP against pnpm dev (or next start).
//
//   (cd packages/db && node --conditions=react-server --env-file=../../.env ../../plan/guest-doors-limit-walk.mjs)
//
// 1. book/quote: 60 price checks from one address answer, the 61st is the
//    429 with its sentence; rate_windows holds the key at 61.
// 2. The change doors count toward the lockout: five change requests and
//    withdrawals with a wrong contact, against a made-up reference, leave
//    five misses in guest_lookup_failures (before D-162: none, because
//    request_change() raised and rolled its miss back). A sixth try is the
//    same 404 (the reference is now locked, as the lookup would be).
//
// Nothing real is touched: the reference is made up (no stay has it), and
// only its own rows are removed at the end, by tenant and that reference.
// Each run uses fresh addresses (the counts outlive the process, D-137).
import { randomBytes } from 'node:crypto';
import { supabase } from '../packages/db/dist/service.js';

const BASE = process.env.WALK_BASE ?? 'http://localhost:3000';
const SLUG = 'villa';
const run = randomBytes(2).toString('hex');
const addr = (i) => `198.18.${parseInt(run.slice(0, 2), 16)}.${i}`;
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
const { data: unit } = await supabase.from('units').select('id').eq('tenant_id', tenant.id).eq('active', true).limit(1).single();
const { data: slot } = await supabase.from('slots').select('id').eq('tenant_id', tenant.id).eq('active', true).order('id').limit(1).single();

// 1.
{
  const ip = addr(1);
  const body = { slotId: slot.id, rooms: [{ unitId: unit.id, guests: 2 }], checkIn: '2027-03-15', nights: 1, promoCode: null };
  const statuses = [];
  let last;
  for (let i = 0; i < 61; i++) {
    last = await post(`/api/t/${SLUG}/book/quote`, body, ip);
    statuses.push(last.status);
  }
  const answered = statuses.slice(0, 60);
  const { data: rows } = await supabase.from('rate_windows').select('count').eq('tenant_id', tenant.id).eq('key', `quote|${tenant.id}|${ip}`);
  check(
    answered.every((s) => s === 200) && statuses[60] === 429 && /Too many price checks/.test(last.error ?? '') && rows?.[0]?.count === 61,
    '1. book/quote: 60 real quotes (200) from one address, the 61st is 429; the window counts 61',
    `first ${answered[0]} · 61st ${statuses[60]} "${last.error}" · count ${rows?.[0]?.count}`,
  );
}

// 2.
const reference = `ZZQ-${randomBytes(3).toString('hex').toUpperCase()}`;
try {
  const { count: exists } = await supabase.from('stays').select('group_id', { count: 'exact', head: true }).eq('tenant_id', tenant.id).eq('reference', reference);
  if (exists) throw new Error(`reference ${reference} exists; run again`);
  const wrong = { reference, contact: 'nobody-d162@example.com' };
  const results = [];
  for (let i = 0; i < 3; i++) results.push(await post(`/api/t/${SLUG}/manage/change`, { ...wrong, kind: 'cancel', dryRun: true }, addr(10 + i)));
  for (let i = 0; i < 2; i++) results.push(await post(`/api/t/${SLUG}/manage/change/withdraw`, wrong, addr(20 + i)));
  const { count: misses } = await supabase.from('guest_lookup_failures').select('reference', { count: 'exact', head: true }).eq('tenant_id', tenant.id).eq('reference', reference);
  check(
    results.every((r) => r.status === 404) && misses === 5,
    '2. three change requests and two withdrawals with a wrong contact are five misses toward the lockout',
    `${results.map((r) => r.status).join(',')} · misses ${misses}`,
  );
  const sixth = await post(`/api/t/${SLUG}/manage/change`, { ...wrong, kind: 'cancel', dryRun: true }, addr(30));
  const { count: after } = await supabase.from('guest_lookup_failures').select('reference', { count: 'exact', head: true }).eq('tenant_id', tenant.id).eq('reference', reference);
  check(sixth.status === 404 && after === 5, '2b. the sixth try is the same 404 and adds no miss: the reference is locked', `${sixth.status} · misses ${after}`);
} finally {
  const { count } = await supabase.from('guest_lookup_failures').delete({ count: 'exact' }).eq('tenant_id', tenant.id).eq('reference', reference);
  console.log(`cleaned ${count ?? 0} miss row(s) for ${reference}`);
}

console.log(failures === 0 ? '\nALL GUEST DOORS LIMIT WALK CHECKS PASS' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
