// legal-dpa-missing.mjs — which tenants already have the bookings
// application but no signed data processing agreement on record (D-130,
// plan/legal.md § 5). The gate only stops a NEW switch-on; these were on
// before it existed. Lists them and stops: no date is invented, nothing is
// switched off. The user decides.
//
//   (cd packages/db && node --conditions=react-server --env-file=../../.env ../../plan/legal-dpa-missing.mjs)

import { supabase } from '../packages/db/dist/service.js';

const { data: apps, error } = await supabase.from('tenant_applications').select('tenant_id').eq('application_key', 'bookings');
if (error) throw new Error(error.message);
const ids = apps.map((a) => a.tenant_id);
const { data: tenants, error: tError } = ids.length
  ? await supabase.from('tenants').select('id, slug, business_name, dpa_signed_on, archived_at').in('id', ids).order('id')
  : { data: [], error: null };
if (tError) throw new Error(tError.message);
const missing = tenants.filter((t) => !t.dpa_signed_on);
console.log(`${tenants.length} tenant(s) have bookings; ${missing.length} have no DPA date on record:`);
for (const t of missing) console.log(`  ${t.slug.padEnd(16)} ${t.business_name}${t.archived_at ? ' (archived)' : ''}`);
if (missing.length) console.log('\nRecord each one\'s date on the platform tenant form\'s Legal tab once the agreement is signed.');
