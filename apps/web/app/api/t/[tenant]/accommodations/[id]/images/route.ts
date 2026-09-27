import { NextResponse } from 'next/server';
import { addImage, listImages, MAX_IMAGE_BYTES } from '@rag/bookings';
import { requireAdmin } from '@/lib/admin-auth';
import { requireApplication } from '@/lib/applications';
import { badRequest, parseId } from '@/lib/route';
import { withTenantRoute } from '@/lib/tenant';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** A room's photos, in order. Another tenant's room gives `[]`. */
export const GET = withTenantRoute<{ id: string }>(async (request, { tenant, params }) => {
  tenant = await requireAdmin(request, tenant);
  await requireApplication(tenant, 'bookings');
  const id = parseId(params.id);
  if (id === null) return badRequest('Invalid room id');
  return NextResponse.json(await listImages(tenant, id));
});

/**
 * Upload one photo: `multipart/form-data` with a `file` field. 201 with it.
 *
 * The upload comes through HERE, not from the browser to Storage, because the
 * browser never holds a token (a TenantContext never reaches a Client
 * Component, CLAUDE.md), and service_role is never used (rule 2). This handler
 * passes the bytes to @rag/bookings, which uploads them on the staff token.
 *
 * What is checked where (plan/booking-types.md § 2.8):
 *   - here: the declared length, BEFORE the body is read, so an oversized
 *     request is refused without buffering it;
 *   - @rag/bookings: the real size, and the type by its first bytes (the
 *     file's name and Content-Type are only what the sender typed);
 *   - the bucket: size and type again; the database: 6 photos per room.
 */
export const POST = withTenantRoute<{ id: string }>(async (request, { tenant, params }) => {
  tenant = await requireAdmin(request, tenant);
  await requireApplication(tenant, 'bookings');
  const id = parseId(params.id);
  if (id === null) return badRequest('Invalid room id');

  // Multipart adds a boundary and headers around the file, a few hundred
  // bytes; 64 KiB of slack is far more than that and far less than a second
  // photo.
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (declared > MAX_IMAGE_BYTES + 64 * 1024) {
    return badRequest(`The photo is too large; the limit is ${MAX_IMAGE_BYTES / 1048576} MB.`);
  }

  const form = await request.formData().catch(() => null);
  const file = form?.get('file');
  if (!(file instanceof File)) return badRequest('Send the photo as a "file" field in multipart/form-data.');

  const image = await addImage(tenant, id, new Uint8Array(await file.arrayBuffer()));
  return image ? NextResponse.json(image, { status: 201 }) : NextResponse.json({ error: `No room with id ${id}` }, { status: 404 });
});
