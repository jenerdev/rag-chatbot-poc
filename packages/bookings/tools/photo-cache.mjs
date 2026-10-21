// photo-cache.mjs — give every EXISTING room photo the one-year Cache-Control
// that new uploads carry (PHOTO_CACHE_SECONDS, 2026-10-21).
//
// Storage sets an object's Cache-Control at upload and keeps it; before this
// date images.ts set none, so every photo already in the bucket answers with
// Storage's default, `max-age=3600`, and a returning browser re-validates it
// every hour. The header can only be changed by writing the object again, so
// this downloads each photo a `unit_images` row names and uploads the same
// bytes over it (`upsert: true`) with the header. Same path, same bytes, same
// URL: nothing on a screen changes.
//
// DRY RUN BY DEFAULT: it reads each object's header and counts the ones
// still on the default. `--apply` rewrites those, and then reads the header
// back from the PUBLIC URL, the way a browser would, because "the upload
// returned no error" is not "the header changed" (CLAUDE.md, verify the
// effect). An object that is already on a year is left alone, so a re-run
// does nothing.
//
// Operator tooling on the service client (allowed under tools/, rule 2): it
// walks every tenant's rows. Needs no API key.
//
//   pnpm --filter @rag/bookings photo-cache            (count)
//   pnpm --filter @rag/bookings photo-cache -- --apply

import { supabase } from '@rag/db/service';
import { IMAGE_BUCKET, PHOTO_CACHE_SECONDS } from '../dist/index.js';

const apply = process.argv.includes('--apply');
const WANT = `max-age=${PHOTO_CACHE_SECONDS}`;
const TYPES = { webp: 'image/webp', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png' };

const { data: rows, error } = await supabase.from('unit_images').select('id, tenant_id, unit_id, path').order('id');
if (error) throw new Error(`unit_images: ${error.message}`);

/**
 * The header the OBJECT carries: a GET, not a HEAD (Storage answers a HEAD
 * with `private, no-cache`), with a throwaway query string so the CDN in
 * front of Storage misses and asks the origin. Without it the CDN answered
 * from its copy of the old object, `max-age=3600`, for up to an hour after
 * the rewrite (the first --apply run, 2026-10-21), and the check read stale.
 */
async function cacheControl(path) {
  const url = supabase.storage.from(IMAGE_BUCKET).getPublicUrl(path).data.publicUrl;
  const res = await fetch(`${url}?fresh=${Date.now()}-${Math.random().toString(36).slice(2)}`, { headers: { Range: 'bytes=0-0' } });
  if (!res.ok && res.status !== 206) return `HTTP ${res.status}`;
  return res.headers.get('cache-control') ?? '(none)';
}

let onDefault = 0;
let rewritten = 0;
let verified = 0;
const failed = [];
for (const row of rows) {
  const before = await cacheControl(row.path);
  const done = before.includes(WANT);
  console.log(`${done ? 'ok     ' : 'default'}  tenant ${row.tenant_id}  unit ${row.unit_id}  ${row.path}  ${before}`);
  if (done) continue;
  onDefault += 1;
  if (!apply) continue;

  const ext = row.path.split('.').pop()?.toLowerCase() ?? '';
  const contentType = TYPES[ext];
  if (!contentType) {
    failed.push(`${row.path}: unknown extension`);
    continue;
  }
  const got = await supabase.storage.from(IMAGE_BUCKET).download(row.path);
  if (got.error) {
    failed.push(`${row.path}: download: ${got.error.message}`);
    continue;
  }
  const put = await supabase.storage.from(IMAGE_BUCKET).upload(row.path, got.data, { contentType, upsert: true, cacheControl: String(PHOTO_CACHE_SECONDS) });
  if (put.error) {
    failed.push(`${row.path}: upload: ${put.error.message}`);
    continue;
  }
  rewritten += 1;
  const after = await cacheControl(row.path);
  if (after.includes(WANT)) verified += 1;
  else failed.push(`${row.path}: header after rewrite is "${after}" (the CDN may hold the old copy for up to an hour)`);
}

console.log('');
console.log(`${rows.length} photo rows; ${onDefault} on the default header${apply ? `; ${rewritten} rewritten, ${verified} read back on a year` : ' (dry run; --apply rewrites them)'}`);
for (const f of failed) console.log(`  ! ${f}`);
if (failed.length > 0) process.exitCode = 1;
