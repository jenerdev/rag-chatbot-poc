// storage-orphans.mjs — objects in the `unit-images` bucket (and, since D-123,
// `brand-images`) that no
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
// Since manage booking (Phase 8) it also walks the PRIVATE `payment-proofs`
// bucket (<tenant_id>/incoming/<uuid>.<ext>):
//   * an object no payments row names, older than an hour (a submit that
//     failed after its upload; younger ones may still be in flight), is an
//     orphan like a photo's, removed with --remove;
//   * --expired deletes the FILE of every proof whose stay ended more than
//     PROOF_RETENTION_DAYS (180) ago (§ 9 q7), then clears the row's
//     proof_path and sets proof_removed_at. The payments row, its amounts
//     and its reviewer are kept. "Ended" is the stay's last booked date.
//
//   pnpm --filter @rag/bookings storage-orphans            (list)
//   pnpm --filter @rag/bookings storage-orphans -- --remove
//   pnpm --filter @rag/bookings storage-orphans -- --expired

import { supabase } from '@rag/db/service';
import { PROOF_BUCKET, PROOF_RETENTION_DAYS } from '../dist/index.js';

const BUCKET = 'unit-images';
const remove = process.argv.includes('--remove');
const expired = process.argv.includes('--expired');

/** Every object under a prefix, paged: Storage's list caps a page at 100 by default. */
async function listAll(prefix, bucket = BUCKET) {
  const names = [];
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await supabase.storage.from(bucket).list(prefix, { limit: 1000, offset });
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

// ─── payment-proofs (manage booking Phase 8) ────────────────────────────

const proofs = [];
const oddProofs = [];
for (const tenantFolder of await listAll('', PROOF_BUCKET)) {
  if (tenantFolder.id) {
    oddProofs.push(tenantFolder.name);
    continue;
  }
  for (const sub of await listAll(tenantFolder.name, PROOF_BUCKET)) {
    if (sub.id || sub.name !== 'incoming') {
      oddProofs.push(`${tenantFolder.name}/${sub.name}`);
      continue;
    }
    for (const file of await listAll(`${tenantFolder.name}/incoming`, PROOF_BUCKET)) {
      const path = `${tenantFolder.name}/incoming/${file.name}`;
      if (!file.id || file.name.startsWith('.')) oddProofs.push(path);
      else proofs.push({ path, tenantId: Number(tenantFolder.name), createdAt: file.created_at ?? null });
    }
  }
}
const { data: payRows, error: payError } = await supabase.from('payments').select('id, tenant_id, group_id, proof_path').not('proof_path', 'is', null);
if (payError) throw new Error(`payments: ${payError.message}`);
const proofNamed = new Map(payRows.map((r) => [r.proof_path, r]));
const anHourAgo = Date.now() - 3600 * 1000;
const proofOrphans = proofs.filter((o) => !proofNamed.has(o.path) && o.createdAt && Date.parse(o.createdAt) < anHourAgo);
const youngUnclaimed = proofs.filter((o) => !proofNamed.has(o.path) && !proofOrphans.includes(o)).length;

console.log(`\nbucket ${PROOF_BUCKET}: ${proofs.length} objects · payments with a proof: ${payRows.length}`);
console.log(`matched: ${proofs.length - proofOrphans.length - youngUnclaimed} objects have their payment · ${youngUnclaimed} unclaimed but under an hour old (left alone)`);
for (const o of proofOrphans) console.log(`  orphan proof (${slugOf.get(o.tenantId) ?? 'NO SUCH TENANT'}): ${o.path}`);
for (const p of oddProofs) console.log(`not the expected shape, left alone: ${p}`);

if (proofOrphans.length > 0 && remove) {
  const paths = proofOrphans.map((o) => o.path);
  const { data, error } = await supabase.storage.from(PROOF_BUCKET).remove(paths);
  const count = data?.length ?? 0;
  console.log(error ? `remove FAILED: ${error.message}` : `removed ${count} of ${paths.length} orphan proofs`);
  if (error || count !== paths.length) process.exitCode = 1;
} else if (proofOrphans.length > 0) {
  console.log(`${proofOrphans.length} ORPHANED PROOF(S); nothing removed (dry run).`);
}

// ─── brand-images (D-123) ─────────────────────────────────────────────────
// A tenant's uploaded logo, banner and assistant avatar,
// <tenant_id>/<kind>-<uuid>.<ext>. An object is in use when some tenant's
// row holds its public URL; one that is not, and over an hour old (an upload
// may be between its object and its row), is an orphan. The upload route
// and the platform's Save already remove what they replace; this catches
// the rest, and a removed tenant's images (tenant:remove runs it).
const BRAND_BUCKET = 'brand-images';
// Named, never select('*') on tenants (CLAUDE.md conventions).
const BRAND_COLUMNS = ['logo_url', 'banner_url', 'assistant_avatar_url'];
const { data: brandRows, error: brandRowError } = await supabase.from('tenants').select(BRAND_COLUMNS.join(', '));
if (brandRowError) throw new Error(brandRowError.message);
const inUse = new Set(brandRows.flatMap((t) => BRAND_COLUMNS.map((c) => t[c]).filter(Boolean)));
const brandPrefix = supabase.storage.from(BRAND_BUCKET).getPublicUrl('').data.publicUrl.replace(/\/?$/, '/');
const brandOrphans = [];
let brandCount = 0;
for (const folder of await listAll('', BRAND_BUCKET)) {
  for (const file of await listAll(folder.name, BRAND_BUCKET)) {
    brandCount++;
    const path = `${folder.name}/${file.name}`;
    const young = file.created_at && Date.now() - new Date(file.created_at).getTime() < 3600000;
    if (!inUse.has(`${brandPrefix}${path}`) && !young) brandOrphans.push(path);
  }
}
console.log(`\nbucket ${BRAND_BUCKET}: ${brandCount} objects · ${inUse.size} brand URLs in tenants' rows`);
for (const path of brandOrphans) console.log(`  orphan brand image: ${path}`);
if (brandOrphans.length > 0 && remove) {
  const { data, error } = await supabase.storage.from(BRAND_BUCKET).remove(brandOrphans);
  const count = data?.length ?? 0;
  console.log(error ? `remove FAILED: ${error.message}` : `removed ${count} of ${brandOrphans.length} orphan brand images`);
  if (error || count !== brandOrphans.length) process.exitCode = 1;
} else if (brandOrphans.length > 0) {
  console.log(`${brandOrphans.length} ORPHANED BRAND IMAGE(S); nothing removed (dry run).`);
}

// Retention: the stays whose LAST booked date is older than the period.
const cutoff = new Date(Date.now() - PROOF_RETENTION_DAYS * 86400000).toISOString().slice(0, 10);
const due = [];
for (const r of payRows) {
  const { data: last } = await supabase.from('bookings').select('booked_date').eq('tenant_id', r.tenant_id).eq('group_id', r.group_id)
    .order('booked_date', { ascending: false }).limit(1).maybeSingle();
  if (last && last.booked_date < cutoff) due.push(r);
}
console.log(`retention (${PROOF_RETENTION_DAYS} days after the stay, before ${cutoff}): ${due.length} proof(s) due`);
if (due.length > 0 && expired) {
  const { data, error } = await supabase.storage.from(PROOF_BUCKET).remove(due.map((r) => r.proof_path));
  const gone = new Set((data ?? []).map((o) => o.name));
  // Only rows whose object Storage says it removed are cleared (trap 17).
  let cleared = 0;
  for (const r of due) {
    if (!gone.has(r.proof_path)) continue;
    const { error: updError } = await supabase.from('payments').update({ proof_path: null, proof_removed_at: new Date().toISOString() }).eq('id', r.id);
    if (!updError) cleared++;
  }
  console.log(error ? `expire FAILED: ${error.message}` : `expired ${gone.size} of ${due.length} proof files; ${cleared} payment rows cleared, kept`);
  if (error || gone.size !== due.length || cleared !== due.length) process.exitCode = 1;
} else if (due.length > 0) {
  console.log(`${due.length} PROOF(S) PAST RETENTION; nothing removed (dry run). Re-run with -- --expired to delete their files.`);
}
