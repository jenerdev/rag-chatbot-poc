// auth-spike.mjs — auth-rls Phase 0: can this server mint a token PostgREST accepts?
//
// The project uses Supabase's asymmetric JWT signing keys, so Supabase holds
// the private key it signs with, and PostgREST trusts whatever is in the
// project's JWKS. We cannot sign with Supabase's key. The question is whether
// we can get a key of OUR OWN trusted (option A), or still use the legacy
// shared secret (option B). plan/auth-rls.md § 2.1 has the table.
//
// Every signature here is hand-rolled on node:crypto (D-002's spirit): a JWT is
// base64url(header) . base64url(payload) . base64url(signature over the first
// two), and nothing about that needs a library.
//
// Needs plan/auth-phase0-spike.sql run first (it creates whoami()).
//
//   node … tools/auth-spike.mjs keygen          make an EC P-256 pair in scratch/
//   node … tools/auth-spike.mjs a               ES256 with our key → rpc/whoami
//   LEGACY_JWT_SECRET=… node … auth-spike.mjs b  HS256 with the legacy secret
//   node … tools/auth-spike.mjs auth <email> <password>   Supabase Auth sign-in
//   node … tools/auth-spike.mjs explain         match_chunks plan, villa, service_role
//
// Throwaway: deleted with whoami() when auth-rls Phase 2 is signed off.

import { createPrivateKey, createHmac, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

const url = process.env.SUPABASE_URL;
const publishable = process.env.SUPABASE_PUBLISHABLE_KEY;
// scratch/ is gitignored. The private key must never be committed: anyone
// holding it can mint a token claiming anything (§ 2.2).
const KEY_FILE = new URL('../../../scratch/tenant-signing-key.private.jwk.json', import.meta.url);

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const decode = (jwt) => JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString());

// The claims the plan's chat token will carry: authenticated, a tenant, five
// minutes. No `sub`, on purpose (§ 2.4): auth.uid() on a non-uuid sub raises.
function spikeClaims() {
  const now = Math.floor(Date.now() / 1000);
  return { role: 'authenticated', tenant_id: 3, iat: now, exp: now + 300 };
}

function jwt(header, payload, signer) {
  const input = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  return `${input}.${b64url(signer(input))}`;
}

async function whoami(token, label) {
  const res = await fetch(`${url}/rest/v1/rpc/whoami`, {
    method: 'POST',
    headers: { apikey: publishable, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: '{}',
  });
  const body = await res.text();
  console.log(`[${label}] POST /rest/v1/rpc/whoami → ${res.status} ${res.statusText}`);
  console.log(`[${label}] ${body}`);
  return res.ok;
}

const [mode, ...args] = process.argv.slice(2);

if (mode === 'keygen') {
  if (existsSync(KEY_FILE)) throw new Error(`${KEY_FILE.pathname} exists; refusing to overwrite a key that may already be imported`);
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = { ...privateKey.export({ format: 'jwk' }), kid: randomUUID(), alg: 'ES256', use: 'sig' };
  mkdirSync(new URL('.', KEY_FILE), { recursive: true });
  writeFileSync(KEY_FILE, JSON.stringify(jwk, null, 2));
  console.log(`wrote ${KEY_FILE.pathname}  (kid ${jwk.kid})`);
  console.log('Paste that file\'s contents into the dashboard\'s "import a private key" field.');
} else if (mode === 'a') {
  const jwk = JSON.parse(readFileSync(KEY_FILE, 'utf8'));
  const key = createPrivateKey({ key: jwk, format: 'jwk' });
  // ES256 signatures in a JWT are raw r||s (IEEE P1363), not the DER that
  // node:crypto produces by default. DER here gives a signature every
  // verifier rejects, with a message that does not say why.
  const token = jwt({ alg: 'ES256', typ: 'JWT', kid: jwk.kid }, spikeClaims(),
    (input) => sign('sha256', Buffer.from(input), { key, dsaEncoding: 'ieee-p1363' }));
  const jwks = await (await fetch(process.env.SUPABASE_JWKS_URL)).json();
  console.log(`[A] JWKS kids: ${jwks.keys.map((k) => `${k.kid} (${k.alg})`).join(', ')}`);
  console.log(`[A] our kid ${jwk.kid} ${jwks.keys.some((k) => k.kid === jwk.kid) ? 'IS' : 'is NOT'} in the JWKS`);
  await whoami(token, 'A');
} else if (mode === 'b') {
  const secret = process.env.LEGACY_JWT_SECRET;
  if (!secret) throw new Error('set LEGACY_JWT_SECRET for this one run; do not put it in .env yet');
  const token = jwt({ alg: 'HS256', typ: 'JWT' }, spikeClaims(),
    (input) => createHmac('sha256', secret).update(input).digest());
  await whoami(token, 'B');
} else if (mode === 'auth') {
  const [email, password] = args;
  const client = createClient(url, publishable, { auth: { persistSession: false } });
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error) {
    console.log(`[auth] signInWithPassword → ${error.status} ${error.message}`);
  } else {
    const token = data.session.access_token;
    const header = JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString());
    const { iss, aud, role, sub, exp, iat } = decode(token);
    console.log(`[auth] header alg=${header.alg} kid=${header.kid}`);
    console.log(`[auth] iss=${iss} aud=${aud} role=${role} sub=${sub} lifetime=${exp - iat}s`);
    await whoami(token, 'auth');
  }
} else if (mode === 'explain') {
  const { supabase } = await import('../dist/index.js');
  // A villa chunk's own embedding as the query, as in tenancy Phase 2: no API
  // key, and a known nearest neighbour. This is match_chunks' body inlined,
  // because explaining the function call shows only "Function Scan".
  const { data: probe, error } = await supabase.from('chunks').select('id').eq('tenant_id', 3).order('id').limit(1).single();
  if (error) throw error;
  const query = `select c.id, c.document_id, 1 - (c.embedding <=> q.e) as similarity
    from chunks c, (select embedding as e from chunks where id = ${probe.id}) q
    where c.tenant_id = 3 and 1 - (c.embedding <=> q.e) >= 0.3
    order by c.embedding <=> q.e limit 5`;
  const { data: lines, error: explainError } = await supabase.rpc('auth_explain', { query });
  if (explainError) throw explainError;
  console.log(`-- villa (tenant 3), query = chunk ${probe.id}'s embedding, as service_role`);
  console.log(query.replace(/\s+/g, ' '));
  console.log(lines.join('\n'));
} else if (mode === 'phase2') {
  // auth-rls Phase 2 (§ 2.3): the SAME two queries explained as service_role
  // (no RLS) and as villa's token (RLS applies), each with the planner's
  // default and with seq scans off, then the ids each role gets back from
  // the real functions. Needs plan/auth-phase2-explain.sql.
  const { supabase } = await import('../dist/index.js');
  const jwk = JSON.parse(process.env.TENANT_SIGNING_JWK);
  const key = createPrivateKey({ key: jwk, format: 'jwk' });
  const now = Math.floor(Date.now() / 1000);
  // app_explain is the claim auth_explain_token() demands. No real token has it.
  const token = jwt({ alg: 'ES256', typ: 'JWT', kid: jwk.kid },
    { role: 'authenticated', tenant_id: 3, app_explain: true, iat: now, exp: now + 300 },
    (input) => sign('sha256', Buffer.from(input), { key, dsaEncoding: 'ieee-p1363' }));
  const asToken = createClient(url, publishable, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  });

  const probeId = 142; // villa's first chunk, the Phase 0 baseline's query vector
  const question = 'What time is check-in?';
  const queries = {
    'match_chunks (inlined body)': `select c.id, c.document_id, 1 - (c.embedding <=> q.e) as similarity
      from chunks c, (select embedding as e from chunks where id = ${probeId}) q
      where c.tenant_id = 3 and 1 - (c.embedding <=> q.e) >= 0.3
      order by c.embedding <=> q.e limit 5`,
    'match_chunks_fts (inlined body)': `select c.id, ts_rank(to_tsvector('english', c.content), to_or_tsquery('${question}')) as rank
      from chunks c
      where c.tenant_id = 3 and to_tsvector('english', c.content) @@ to_or_tsquery('${question}')
      order by rank desc limit 5`,
  };
  const roles = [
    ['service_role', supabase, 'auth_explain'],
    ["villa's token", asToken, 'auth_explain_token'],
  ];
  for (const [name, query] of Object.entries(queries)) {
    console.log(`\n=== ${name}\n${query.replace(/\s+/g, ' ')}`);
    for (const seqscan of [true, false]) {
      for (const [role, client, fn] of roles) {
        const { data, error } = await client.rpc(fn, { query, seqscan });
        console.log(`\n--- as ${role}, ${seqscan ? 'planner default' : 'enable_seqscan off'}`);
        console.log(error ? `ERROR ${error.code} ${error.message}` : data.join('\n'));
      }
    }
  }

  // At 34 chunks the planner never picks the HNSW index in either role, so
  // the default plans cannot show § 2.3's failure. Force it the way tenancy
  // Phase 2 did: `tenant_id + 0` makes chunks_tenant_idx unusable for OUR
  // filter, and seq scans are off. What remains to watch is whether the
  // policy's own qual steals the plan back to chunks_tenant_idx under RLS.
  {
    const query = `select c.id, 1 - (c.embedding <=> (select embedding from chunks where id = ${probeId})) as similarity
      from chunks c where (c.tenant_id + 0) = 3
      order by c.embedding <=> (select embedding from chunks where id = ${probeId}) limit 5`;
    console.log(`\n=== HNSW forced: (tenant_id + 0) = 3, enable_seqscan off\n${query.replace(/\s+/g, ' ')}`);
    for (const [role, client, fn] of roles) {
      const { data, error } = await client.rpc(fn, { query, seqscan: false });
      console.log(`\n--- as ${role}`);
      console.log(error ? `ERROR ${error.code} ${error.message}` : data.join('\n'));
    }
  }

  // The ids, through the real functions, as each role. Rule 3: the same rows.
  const { data: probe } = await supabase.from('chunks').select('embedding').eq('id', probeId).single();
  const vector = JSON.parse(probe.embedding);
  console.log('\n=== ids through the real functions');
  for (const [role, client] of roles) {
    const vec = await client.rpc('match_chunks', { query_embedding: vector, p_tenant_id: 3, match_count: 5, min_similarity: 0.3 });
    const fts = await client.rpc('match_chunks_fts', { query_text: question, query_embedding: vector, p_tenant_id: 3, match_count: 5 });
    const ids = (r) => (r.error ? `ERROR ${r.error.message}` : r.data.map((x) => x.id).join(' · '));
    console.log(`${role.padEnd(14)} match_chunks: ${ids(vec)}   match_chunks_fts: ${ids(fts)}`);
  }

  // The guard: a real chat token, without app_explain, is refused.
  const plain = jwt({ alg: 'ES256', typ: 'JWT', kid: jwk.kid },
    { role: 'authenticated', tenant_id: 3, iat: now, exp: now + 300 },
    (input) => sign('sha256', Buffer.from(input), { key, dsaEncoding: 'ieee-p1363' }));
  const refused = await createClient(url, publishable, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${plain}` } },
  }).rpc('auth_explain_token', { query: 'select 1' });
  console.log(`\n=== a chat token WITHOUT app_explain → ${refused.error ? `${refused.error.code} ${refused.error.message}` : 'ALLOWED'}`);
} else {
  console.log('usage: auth-spike.mjs keygen | a | b | auth <email> <password> | explain | phase2');
  process.exitCode = 1;
}
