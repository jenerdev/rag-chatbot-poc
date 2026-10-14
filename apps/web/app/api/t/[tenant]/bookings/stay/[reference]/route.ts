import { NextResponse } from 'next/server';
import { stayDetail } from '@rag/bookings';
import { requireAdmin } from '@/lib/admin-auth';
import { requireApplication } from '@/lib/applications';
import { withTenantRoute } from '@/lib/tenant';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * One stay by its reference, for its detail page (D-114): the nights with
 * their stored prices, the guest, the payment and its proofs, the change
 * requests and the history. `GET /api/t/<slug>/bookings/stay/HAR-G3ZQYF`.
 * STAFF ONLY (every member reads, bookings:read). 404 for a reference that
 * is not this tenant's, the same as one that does not exist.
 *
 * Read-only. The actions go to the routes that already make them:
 * PATCH /bookings/requests/[groupId] (confirm, decline, cancel),
 * PATCH /payments/[id] (verify, reject), PATCH /payments/changes/[id],
 * POST /payments/refund, and the staff notes: POST and DELETE .../notes.
 */
export const GET = withTenantRoute<{ reference: string }>(async (request, { tenant, params }) => {
  const staff = await requireAdmin(request, tenant, 'bookings:read');
  await requireApplication(staff, 'bookings');

  const stay = await stayDetail(staff, params.reference, staff.userId);
  if (!stay) return NextResponse.json({ error: 'No such booking' }, { status: 404 });
  return NextResponse.json(stay);
});
