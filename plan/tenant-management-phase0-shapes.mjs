// tenant-management-phase0-shapes.mjs — would today's tenants pass the
// constraints Phase 1 adds? (plan/tenant-management.md § 2.5, § 3.3, Phase 0)
//
// A check constraint that a live row fails is a migration, not a check: the
// ALTER TABLE itself would be refused. So before schema-roles.sql exists, the
// SAME rules are applied here, in JavaScript, to every tenants row and every
// bookings config, and the result is recorded. Read-only, on the service
// client, because it reads `tenants`, which no token may read.
//
//   cd packages/db && node --conditions=react-server --env-file=../../.env ../../plan/tenant-management-phase0-shapes.mjs

import { supabase } from '../packages/db/dist/service.js';

let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failures++;
};

// The rules, exactly as Phase 1 will write them in SQL.
const THEME_KEYS = ['accent', 'accentSoft', 'bg', 'panel', 'ink'];
const COLOUR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/; // lib/branding.ts's regex
const RESERVED = ['api', 'admin', 't', '_next', 'static', 'new', 'login', 'health', 'platform'];
const isHttps = (u) => {
  if (u === null) return true;
  try {
    return new URL(u).protocol === 'https:';
  } catch {
    return false;
  }
};

const { data: tenants, error } = await supabase
  .from('tenants')
  .select('id, slug, business_name, assistant_name, logo_url, banner_url, theme, fallback_messages')
  .order('id');
if (error) throw new Error(error.message);
console.log(`${tenants.length} tenants`);

for (const t of tenants) {
  const tag = `${t.slug} (#${t.id})`;
  const theme = t.theme ?? {};
  const themeIsObject = typeof theme === 'object' && theme !== null && !Array.isArray(theme);
  const extraKeys = themeIsObject ? Object.keys(theme).filter((k) => !THEME_KEYS.includes(k)) : ['(not an object)'];
  const badColours = themeIsObject ? Object.entries(theme).filter(([, v]) => !COLOUR.test(String(v))) : [];
  check(
    themeIsObject && extraKeys.length === 0 && badColours.length === 0,
    `${tag}: tenants_theme_shape`,
    `${Object.keys(theme).length} key(s)${extraKeys.length ? `, unknown: ${extraKeys.join(', ')}` : ''}${badColours.length ? `, bad: ${badColours.map(([k, v]) => `${k}=${v}`).join(', ')}` : ''}`,
  );
  check(isHttps(t.logo_url) && isHttps(t.banner_url), `${tag}: tenants_urls_https`, `logo ${t.logo_url ?? 'null'} · banner ${t.banner_url ?? 'null'}`);
  check(t.business_name.length >= 1 && t.business_name.length <= 100, `${tag}: business_name 1–100`, `${t.business_name.length} chars`);
  check(t.assistant_name.length >= 1 && t.assistant_name.length <= 50, `${tag}: assistant_name 1–50`, `${t.assistant_name.length} chars`);
  check(!RESERVED.includes(t.slug), `${tag}: slug not reserved (incl. "platform")`);
}

const { data: apps, error: appsError } = await supabase.from('tenant_applications').select('tenant_id, application_key, config').order('tenant_id');
if (appsError) throw new Error(appsError.message);
for (const a of apps) {
  const slug = tenants.find((t) => t.id === a.tenant_id)?.slug ?? `#${a.tenant_id}`;
  const nights = a.config.max_stay_nights;
  const days = a.config.max_advance_days;
  const nightsOk = nights === undefined || (Number.isInteger(nights) && nights >= 1 && nights <= 60);
  const daysOk = days === undefined || (Number.isInteger(days) && days >= 1 && days <= 730);
  check(nightsOk && daysOk, `${slug}: ${a.application_key} config max_stay_nights / max_advance_days`, `${nights ?? 'absent → 14'} / ${days ?? 'absent → 365'}`);
}

console.log(failures ? `\n${failures} FAILED: Phase 1's constraints would be refused as written.` : '\nEvery live row passes the Phase 1 constraints.');
process.exitCode = failures ? 1 : 0;
