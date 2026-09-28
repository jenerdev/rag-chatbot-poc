// storage-orphans.mjs — objects in the `unit-images` bucket that no
// `unit_images` row names (R-30), and rows that name no object.
//
// A photo lives in two places: a row (deleted by cascade when its room or
// tenant goes) and an object (deleted by @rag/bookings, one at a time, and
// only logged when Storage refuses). So an object can outlive its row. It
// is invisible to every screen and only costs space, and nothing else in
// the code base looks for it. This does.
//
// DRY RUN BY DEFAULT: it lists and counts. `--remove` deletes the orphaned
// objects, and the count of what Storage says it removed must equal what
// was asked, because a refused delete is silent (CLAUDE.md trap 17). Rows
// with no object are only reported: that is a broken image on a screen, and
// which side is wrong is a person's call.
//
// Operator tooling, on the service client (allowed under tools/, CLAUDE.md
// rule 2), because it reads EVERY tenant's folder, including folders of
// tenants that no longer exist. Needs no API key.
//
//   pnpm --filter @rag/bookings storage-orphans            (list)
//   pnpm --filter @rag/bookings storage-orphans -- --remove

import { supabase } from '@rag/db/service';

const BUCKET = 'unit-images';
const remove = process.argv.includes('--remove');

/** Every object under a prefix, paged: Storage's list caps a page at 100 by default. */
async function listAll(prefix) {
  const names = [];
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await supabase.storage.from(BUCKET).list(prefix, { limit: 1000, offset });
    if (error) throw new Error(`list ${prefix || '/'}: ${error.message}`);
    names.push(...data);
    if (data.length < 1000) return names;
  }
}

// The bucket is <tenant_id>/<unit_id>/<uuid>.<ext>, three levels, walked as
// such rather than by a recursive search: a folder entry has no `id`, a file
// has one. Anything that does not fit the shape is reported, never removed.
const objects = [];
const odd = [];
for (const tenantFolder of await listAll('')) {
  if (tenantFolder.id) {
    odd.push(tenantFolder.name);
    continue;
  }
  for (const unitFolder of await listAll(tenantFolder.name)) {
    if (unitFolder.id) {
      odd.push(`${tenantFolder.name}/${unitFolder.name}`);
      continue;
    }
    for (const file of await listAll(`${tenantFolder.name}/${unitFolder.name}`)) {
      const path = `${tenantFolder.name}/${unitFolder.name}/${file.name}`;
      if (!file.id || file.name.startsWith('.')) odd.push(path);
      else objects.push({ path, tenantId: Number(tenantFolder.name), bytes: file.metadata?.size ?? null });
    }
  }
}

const { data: rows, error: rowsError } = await supabase.from('unit_images').select('id, tenant_id, path');
if (rowsError) throw new Error(`unit_images: ${rowsError.message}`);
const { data: tenants, error: tenantsError } = await supabase.from('tenants').select('id, slug');
if (tenantsError) throw new Error(`tenants: ${tenantsError.message}`);
const slugOf = new Map(tenants.map((t) => [t.id, t.slug]));

const named = new Set(rows.map((r) => r.path));
const present = new Set(objects.map((o) => o.path));
const orphans = objects.filter((o) => !named.has(o.path));
const broken = rows.filter((r) => !present.has(r.path));

console.log(`bucket ${BUCKET}: ${objects.length} objects · unit_images: ${rows.length} rows · tenants: ${tenants.length}`);
// The positive twin: the matched count. A scan that matched nothing because
// the paths are shaped differently would call every object an orphan.
console.log(`matched: ${objects.length - orphans.length} objects have their row`);

const byTenant = new Map();
for (const o of orphans) byTenant.set(o.tenantId, [...(byTenant.get(o.tenantId) ?? []), o]);
for (const [tenantId, list] of byTenant) {
  const bytes = list.reduce((sum, o) => sum + (o.bytes ?? 0), 0);
  console.log(`orphans in ${tenantId} (${slugOf.get(tenantId) ?? 'NO SUCH TENANT'}): ${list.length}, ${bytes} bytes`);
  for (const o of list) console.log(`  ${o.path}`);
}
for (const r of broken) console.log(`row without an object: unit_images #${r.id} (${slugOf.get(r.tenant_id) ?? r.tenant_id}) ${r.path}`);
for (const p of odd) console.log(`not the expected shape, left alone: ${p}`);

if (orphans.length === 0) {
  console.log('NO ORPHANED OBJECTS');
} else if (!remove) {
  console.log(`${orphans.length} ORPHANED OBJECT(S); nothing removed (dry run). Re-run with -- --remove to delete them.`);
} else {
  const paths = orphans.map((o) => o.path);
  const { data, error } = await supabase.storage.from(BUCKET).remove(paths);
  const count = data?.length ?? 0;
  console.log(error ? `remove FAILED: ${error.message}` : `removed ${count} of ${paths.length}`);
  process.exitCode = !error && count === paths.length ? 0 : 1;
}
if (broken.length > 0) process.exitCode = 1;
