// booking-types-phase7-bundle.mjs — CLAUDE.md rule 2's bundle check, after
// booking types (plan/booking-types.md Phase 7): nothing secret reaches the
// browser. Scans every file under apps/web/.next/static/ for the NAMES that
// must never ship and for the secret VALUES themselves, read from .env and
// never printed (only counts are).
//
// Run after a fresh `next build`:
//   node --env-file=.env plan/booking-types-phase7-bundle.mjs "<label>"

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('../apps/web/.next/static/', import.meta.url);
const files = [];
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path);
    else files.push(path);
  }
})(ROOT.pathname.replace(/^\/([A-Za-z]:)/, '$1'));

const text = files.map((f) => ({ f, body: readFileSync(f, 'latin1') }));
const count = (needle, caseless = false) =>
  text.filter(({ body }) => (caseless ? body.toLowerCase().includes(needle.toLowerCase()) : body.includes(needle))).length;

// Names, as CLAUDE.md rule 2 lists them, plus this plan's new server-only
// surfaces: the RLS-bypassing client, and the photo bucket's write path.
const names = ['service_role', 'SUPABASE_SECRET', 'SUPABASE_SERVICE_ROLE', 'TENANT_SIGNING_JWK', 'guest_phone', '@rag/db/service', 'admin_key_hash'];
const lines = names.map((n) => `${n}: ${count(n, true)} files`);

// Values. A prefix long enough to be unique, never the whole secret.
const jwk = (() => {
  try {
    return JSON.parse(process.env.TENANT_SIGNING_JWK ?? '{}');
  } catch {
    return {};
  }
})();
const values = {
  'service_role key value': process.env.SUPABASE_SERVICE_ROLE_KEY,
  'secret key value': process.env.SUPABASE_SECRET_KEY,
  'OpenAI key value': process.env.OPENAI_API_KEY,
  'cookie secret value': process.env.ADMIN_COOKIE_SECRET,
  'signing key private d': jwk.d,
  'signing key kid': jwk.kid,
};
for (const [label, value] of Object.entries(values)) {
  lines.push(value && value.length >= 12 ? `${label}: ${count(value.slice(0, 24))} files` : `${label}: (not set in this environment)`);
}

const bad = lines.filter((l) => / [1-9]\d* files$/.test(l));
console.log(`$ scan apps/web/.next/static/ — ${process.argv[2] ?? ''}`);
for (const l of lines) console.log(l);
console.log(`static files scanned: ${files.length}`);
console.log(bad.length === 0 ? 'NOTHING SECRET IN THE BUNDLE' : `FOUND: ${bad.join('; ')}`);
process.exitCode = bad.length === 0 ? 0 : 1;
