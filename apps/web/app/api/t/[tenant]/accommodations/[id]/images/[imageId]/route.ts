import { NextResponse } from 'next/server';
import { removeImage, setImageOrder } from '@rag/bookings';
import { requireAdmin } from '@/lib/admin-auth';
import { requireApplication } from '@/lib/applications';
import { badRequest, parseId } from '@/lib/route';
import { firstError, imageOrderSchema } from '@/lib/schemas';
import { withTenantRoute } from '@/lib/tenant';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// A photo is addressed through its room: a photo id under the wrong room is
// "not there", the same 404 as another tenant's photo or none at all.

type Params = { id: string; imageId: string };
const notFound = (imageId: number) => NextResponse.json({ error: `No photo with id ${imageId}` }, { status: 404 });

/** Remove a photo: its row, then its object in the bucket. */
export const DELETE = withTenantRoute<Params>(async (request, { tenant, params }) => {
  tenant = await requireAdmin(request, tenant);
  await requireApplication(tenant, 'bookings');
  const id = parseId(params.id);
  const imageId = parseId(params.imageId);
  if (id === null || imageId === null) return badRequest('Invalid room or photo id');

  return (await removeImage(tenant, id, imageId)) ? NextResponse.json({ removed: true }) : notFound(imageId);
});

/** Move a photo in the order: `{ sortOrder }`. Only the order can change; a photo is replaced, not edited. */
export const PATCH = withTenantRoute<Params>(async (request, { tenant, params }) => {
  tenant = await requireAdmin(request, tenant);
  await requireApplication(tenant, 'bookings');
  const id = parseId(params.id);
  const imageId = parseId(params.imageId);
  if (id === null || imageId === null) return badRequest('Invalid room or photo id');

  const parsed = imageOrderSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return badRequest(firstError(parsed.error));

  return (await setImageOrder(tenant, id, imageId, parsed.data.sortOrder)) ? NextResponse.json({ sortOrder: parsed.data.sortOrder }) : notFound(imageId);
});
