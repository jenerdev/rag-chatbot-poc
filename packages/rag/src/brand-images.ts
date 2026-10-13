// brand-images.ts — a tenant's logo and banner, UPLOADED on the platform page
// (D-123), into the public `brand-images` bucket (sql/schema-brand-images.sql).
//
// Who may: a super user, on the platform token (D-076). Storage's policies
// ask app_is_super() for every insert, select and delete; the route asks
// requirePlatform() first. The image's URL then goes into the tenant's row
// through updateTenant(), the platform's one write, so the https rule and
// the shape checks still apply (tenants_urls_https).
//
// What is accepted: a JPEG, PNG or WebP, by its BYTES, never by its name or
// the browser's word, at most 2 MiB (the bucket says so too). The browser
// resizes and re-encodes first (lib/resize-image.ts), which also drops
// EXIF/GPS; a direct POST skipping that is still bounded here.
//
// A replaced image is removed from the bucket, and so is one whose URL is
// cleared on the form: an image in no tenant's row is an orphan (R-30).
// Only an object in OUR bucket is ever removed; a pasted URL elsewhere is
// left alone.

import { randomUUID } from 'node:crypto';
import { sniffImageType } from '@rag/bookings';
import { getTenant, PlatformInputError, updateTenant, type PlatformContext, type TenantDetail } from './platform.js';

export const BRAND_BUCKET = 'brand-images';
/** The bucket's own file_size_limit; the route refuses a bigger body first. */
export const MAX_BRAND_BYTES = 2 * 1024 * 1024;
/** What may be uploaded, and the tenant field each sets. */
export const BRAND_IMAGE_KINDS = ['logo', 'banner'] as const;
export type BrandImageKind = (typeof BRAND_IMAGE_KINDS)[number];
const FIELD: Readonly<Record<BrandImageKind, 'logoUrl' | 'bannerUrl'>> = { logo: 'logoUrl', banner: 'bannerUrl' };

/** The object path of a URL in our bucket, or null for any other URL. Pure, tested. */
export function brandObjectPath(publicPrefix: string, url: string | null | undefined): string | null {
  if (!url || !url.startsWith(publicPrefix)) return null;
  const path = decodeURIComponent(url.slice(publicPrefix.length));
  // '<tenant_id>/<kind>-<uuid>.<ext>' and nothing else: no '..', no deeper folder.
  return /^\d+\/[a-z]+-[0-9a-f-]{36}\.(?:jpg|png|webp)$/.test(path) ? path : null;
}

/** "https://<project>.supabase.co/storage/v1/object/public/brand-images/" */
function publicPrefix(platform: PlatformContext): string {
  return platform.db.storage.from(BRAND_BUCKET).getPublicUrl('').data.publicUrl.replace(/\/?$/, '/');
}

/** Remove our object behind a URL, if it is ours. Counted: a refused delete is silent (trap 17). */
async function removeObject(platform: PlatformContext, url: string | null | undefined): Promise<void> {
  const path = brandObjectPath(publicPrefix(platform), url);
  if (!path) return;
  const { data, error } = await platform.db.storage.from(BRAND_BUCKET).remove([path]);
  if (error || (data ?? []).length !== 1) console.warn(`[brand] could not remove ${path}: ${error?.message ?? `${(data ?? []).length} removed`}`);
}

/**
 * Store an image for a tenant and point its logo or banner at it. The old
 * image, if it was ours, is removed. The tenant as it now is.
 */
export async function uploadBrandImage(platform: PlatformContext, tenantId: number, kind: string, bytes: Uint8Array): Promise<TenantDetail> {
  if (!(BRAND_IMAGE_KINDS as readonly string[]).includes(kind)) throw new PlatformInputError(`An image is one of: ${BRAND_IMAGE_KINDS.join(', ')}.`);
  if (bytes.length === 0) throw new PlatformInputError('The image is empty.');
  if (bytes.length > MAX_BRAND_BYTES) throw new PlatformInputError('The image is larger than 2 MB.');
  const type = sniffImageType(bytes);
  if (!type) throw new PlatformInputError('The image must be a JPEG, PNG or WebP.');

  const before = await getTenant(platform, tenantId);
  const path = `${tenantId}/${kind}-${randomUUID()}.${type.ext}`;
  const up = await platform.db.storage.from(BRAND_BUCKET).upload(path, bytes, { contentType: type.contentType, upsert: false, cacheControl: '31536000' });
  if (up.error) throw new Error(`Could not store the image: ${up.error.message}`);
  const url = platform.db.storage.from(BRAND_BUCKET).getPublicUrl(path).data.publicUrl;

  const field = FIELD[kind as BrandImageKind];
  let after: TenantDetail;
  try {
    after = await updateTenant(platform, tenantId, { [field]: url });
  } catch (error) {
    // The row refused it: the object would be an orphan.
    await platform.db.storage.from(BRAND_BUCKET).remove([path]);
    throw error;
  }
  await removeObject(platform, before[field]);
  console.log(`[brand] tenant ${tenantId}: ${kind} uploaded (${bytes.length} bytes, ${type.contentType})`);
  return after;
}

/**
 * After the form's ordinary save: remove our images the tenant no longer
 * points at (replaced by a pasted URL, or cleared). `before` is the tenant
 * as it was.
 */
export async function sweepBrandImages(platform: PlatformContext, before: TenantDetail, after: TenantDetail): Promise<void> {
  for (const field of Object.values(FIELD)) {
    if (before[field] && before[field] !== after[field]) await removeObject(platform, before[field]);
  }
}
