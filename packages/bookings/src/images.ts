// images.ts — room photos, in the `unit-images` bucket (plan/booking-types.md § 2.8).
//
// The first file this project stores. Uploads arrive at OUR route and are
// passed on here, on the staff token (tenant.db); the browser never holds a
// token, and service_role is never used (CLAUDE.md rule 2). The Phase 1 spike
// proved Storage accepts our tokens and that its policies see our claims.
//
// Two walls on every path, as for every query (CLAUDE.md rule 6):
//   - wall 1: the object name is built HERE from tenant.id and the room id,
//     never taken from the request;
//   - wall 2: the bucket's policies compare the first folder with the token's
//     tenant, and unit_images has a check that says the same.
//
// What is checked, and where:
//   - type, by the first bytes (sniffImageType), here AND by the bucket;
//   - size, here (MAX_IMAGE_BYTES) AND by the bucket (file_size_limit);
//   - photos per room, by a trigger (a count in TypeScript would race).
//
// Order of writes, so a failure leaves nothing visibly broken (the same move
// as trap 5): upload, then insert the row, and if the insert fails remove the
// object. Deleting runs the other way: row, then object. A leftover object
// with no row is invisible (R-30); a row with no object would be a broken
// image on the screen.

import { randomUUID } from 'node:crypto';
import { IMAGE_BUCKET, MAX_IMAGE_BYTES, MAX_IMAGES_PER_UNIT } from './constants.js';
import { requirePerRoom } from './bookings.js';
import { BookingInputError } from './errors.js';
import type { BookingTenant, ImageSummary } from './types.js';
import { positiveInt, sniffImageType } from './validate.js';

function toSummary(tenant: BookingTenant, row: { id: number; unit_id: number; path: string; sort_order: number }): ImageSummary {
  return {
    id: row.id,
    unitId: row.unit_id,
    path: row.path,
    url: tenant.db.storage.from(IMAGE_BUCKET).getPublicUrl(row.path).data.publicUrl,
    sortOrder: row.sort_order,
  };
}

/** Photos of one room, or of every room (unitId null), in display order. Internal: callers check per_room first. */
export async function listImagesFor(tenant: BookingTenant, unitId: number | null): Promise<ImageSummary[]> {
  let query = tenant.db.from('unit_images').select('id, unit_id, path, sort_order').eq('tenant_id', tenant.id);
  if (unitId !== null) query = query.eq('unit_id', unitId);
  const { data, error } = await query.order('sort_order').order('id');
  if (error) throw new Error(`Could not load photos: ${error.message}`);
  return data.map((row) => toSummary(tenant, row));
}

/** One room's photos. Another tenant's room id gives `[]`, the same as a room with none. */
export async function listImages(tenant: BookingTenant, unitId: unknown): Promise<ImageSummary[]> {
  await requirePerRoom(tenant);
  return listImagesFor(tenant, positiveInt(unitId, 'Room'));
}

/**
 * Store one photo for a room. `null` means the room is not this tenant's or
 * not there. Staff only.
 *
 * The bytes are expected already resized and re-encoded by the browser
 * (§ 2.8), which also strips EXIF/GPS. A direct POST can skip that: it is
 * still bounded by the size and type checks, and it is staff only (R-29).
 */
export async function addImage(tenant: BookingTenant, unitId: unknown, bytes: Uint8Array): Promise<ImageSummary | null> {
  await requirePerRoom(tenant);
  const room = positiveInt(unitId, 'Room');
  if (bytes.length === 0) throw new BookingInputError('The photo is empty.');
  if (bytes.length > MAX_IMAGE_BYTES) {
    throw new BookingInputError(`The photo is ${(bytes.length / 1048576).toFixed(1)} MB; the limit is ${MAX_IMAGE_BYTES / 1048576} MB.`);
  }
  const type = sniffImageType(bytes);
  if (!type) throw new BookingInputError('A photo must be a JPEG, PNG or WebP image.');

  const { data: unit, error: unitError } = await tenant.db.from('units').select('id').eq('tenant_id', tenant.id).eq('id', room).maybeSingle();
  if (unitError) throw new Error(`Could not load the room: ${unitError.message}`);
  if (!unit) return null;

  // A new photo goes AFTER the room's last one. Every upload used to get 0,
  // so the order was "0, then id", and the screen's move (which assumed order
  // = position) could send a photo to the end (code review, 2026-09-28). Two
  // uploads at the same instant can share a number; the order then falls
  // back to id, and the next move renumbers the room (moveImage).
  const { data: last, error: lastError } = await tenant.db
    .from('unit_images')
    .select('sort_order')
    .eq('tenant_id', tenant.id)
    .eq('unit_id', room)
    .order('sort_order', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (lastError) throw new Error(`Could not read the photo order: ${lastError.message}`);
  const sortOrder = last ? last.sort_order + 1 : 0;

  // Wall 1: the path comes from the server's tenant and the checked room id.
  const path = `${tenant.id}/${room}/${randomUUID()}.${type.ext}`;
  const bucket = tenant.db.storage.from(IMAGE_BUCKET);
  const uploaded = await bucket.upload(path, bytes, { contentType: type.contentType, upsert: false });
  if (uploaded.error) throw new Error(`Could not store the photo: ${uploaded.error.message}`);

  const { data, error } = await tenant.db
    .from('unit_images')
    .insert({ tenant_id: tenant.id, unit_id: room, path, sort_order: sortOrder })
    .select('id, unit_id, path, sort_order')
    .single();
  if (error) {
    // The object is there and the row is not: remove the object now, or it is
    // an orphan (R-30). A refused cleanup is logged, not thrown over the
    // error the caller needs to see.
    const removed = await bucket.remove([path]);
    if (removed.error || removed.data?.length !== 1) console.log(`[bookings] ${tenant.slug} WARN orphaned photo ${path}`);
    if (error.code === '23514' && /limit is/.test(error.message)) {
      throw new BookingInputError(`A room has at most ${MAX_IMAGES_PER_UNIT} photos.`);
    }
    throw new Error(`Could not save the photo: ${error.message}`);
  }
  console.log(`[bookings] ${tenant.slug} photo #${data.id} for room #${room}: ${path}, ${bytes.length} bytes`);
  return toSummary(tenant, data);
}

/**
 * Remove a photo. `false` means "not yours or not there".
 *
 * The COUNT is what is checked, never the absence of an error: in the Phase 1
 * spike a refused Storage delete returned no error and removed 0 objects. So
 * an object that did not go is logged as an orphan, and the row is gone
 * either way (the screen no longer shows the photo).
 */
export async function removeImage(tenant: BookingTenant, unitId: unknown, imageId: unknown): Promise<boolean> {
  await requirePerRoom(tenant);
  const room = positiveInt(unitId, 'Room');
  const id = positiveInt(imageId, 'Photo');
  // Scoped to the room in the URL as well as the tenant: another room's photo
  // is "not there", like another tenant's.
  const { data, error } = await tenant.db
    .from('unit_images')
    .delete()
    .eq('tenant_id', tenant.id)
    .eq('unit_id', room)
    .eq('id', id)
    .select('path');
  if (error) throw new Error(`Could not remove the photo: ${error.message}`);
  const [row] = data;
  if (!row) return false;

  const removed = await tenant.db.storage.from(IMAGE_BUCKET).remove([row.path]);
  if (removed.error || removed.data?.length !== 1) {
    console.log(`[bookings] ${tenant.slug} WARN photo #${id} row removed, object not: ${row.path} (${removed.error?.message ?? '0 removed'})`);
  } else {
    console.log(`[bookings] ${tenant.slug} removed photo #${id}: ${row.path}`);
  }
  return true;
}

/**
 * Move a photo one place left (-1) or right (+1) in the order staff see.
 * `false`: not yours, not there, or already at that end.
 *
 * It swaps POSITIONS in the displayed order, then writes 0, 1, 2… to the
 * room's photos, so a stored order and a position can never disagree again.
 * Swapping the two photos' stored numbers instead was the bug: with every
 * photo at 0, "move right" sent the first photo to the end.
 */
export async function moveImage(tenant: BookingTenant, unitId: unknown, imageId: unknown, direction: unknown): Promise<boolean> {
  await requirePerRoom(tenant);
  const room = positiveInt(unitId, 'Room');
  const id = positiveInt(imageId, 'Photo');
  if (direction !== -1 && direction !== 1) throw new BookingInputError('Move a photo by -1 (left) or 1 (right).');

  const photos = await listImagesFor(tenant, room);
  const from = photos.findIndex((p) => p.id === id);
  const to = from + direction;
  if (from === -1 || to < 0 || to >= photos.length) return false;
  [photos[from], photos[to]] = [photos[to]!, photos[from]!];

  for (const [index, photo] of photos.entries()) {
    if (photo.sortOrder === index) continue;
    const { error } = await tenant.db
      .from('unit_images')
      .update({ sort_order: index })
      .eq('tenant_id', tenant.id)
      .eq('unit_id', room)
      .eq('id', photo.id);
    if (error) throw new Error(`Could not reorder the photos: ${error.message}`);
  }
  return true;
}

/** Move a photo in the order. Only sort_order can change (a column grant says so). `false`: not yours or not there. */
export async function setImageOrder(tenant: BookingTenant, unitId: unknown, imageId: unknown, sortOrder: unknown): Promise<boolean> {
  await requirePerRoom(tenant);
  const room = positiveInt(unitId, 'Room');
  const id = positiveInt(imageId, 'Photo');
  if (typeof sortOrder !== 'number' || !Number.isInteger(sortOrder) || sortOrder < 0) {
    throw new BookingInputError('Order must be a whole number, 0 or more.');
  }
  const { data, error } = await tenant.db
    .from('unit_images')
    .update({ sort_order: sortOrder })
    .eq('tenant_id', tenant.id)
    .eq('unit_id', room)
    .eq('id', id)
    .select('id');
  if (error) throw new Error(`Could not reorder the photo: ${error.message}`);
  return data.length > 0;
}
