import { NextResponse } from 'next/server';
import { MAX_PROOF_BYTES, submitProof } from '@rag/bookings';
import { requireApplication } from '@/lib/applications';
import { MANAGE_NOT_FOUND } from '@/lib/manage';
import { notifyAfter } from '@/lib/notify';
import { parseMoneyInput } from '@/lib/money';
import { allow, clientIp } from '@/lib/rate-limit';
import { badRequest } from '@/lib/route';
import { withTenantRoute } from '@/lib/tenant';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * A guest's proof of payment (plan/manage-booking.md Phase 3):
 * `multipart/form-data` with `reference`, `contact`, `method`, `amount`
 * (pesos, as typed), `paidOn` (YYYY-MM-DD), `payerReference` (optional),
 * `idempotencyKey` (made when the page loaded) and `file`. 201 with the
 * payment's id; the same 404 sentence as a lookup for a miss.
 *
 * OPEN, on the CHAT token, like the lookup. What is checked where:
 *   - here: the declared length, BEFORE the body is read, and the per-IP
 *     window (the lookup's own key: a guest who looked up then pays spends
 *     from one allowance);
 *   - @rag/bookings: the match (before any upload: a stranger stores
 *     nothing), the real size, the type by the first bytes;
 *   - the bucket: size and type again, insert-only for the chat token;
 *   - submit_payment(): the match again, the method, amount, date and the
 *     object, one open proof per stay, a repeated key is the same row.
 */
export const POST = withTenantRoute(async (request, { tenant }) => {
  await requireApplication(tenant, 'bookings');

  const declared = Number(request.headers.get('content-length') ?? '0');
  if (declared > MAX_PROOF_BYTES + 64 * 1024) {
    return badRequest(`The file is too large; the limit is ${MAX_PROOF_BYTES / 1048576} MB.`);
  }
  if (!allow(`manage|${tenant.id}|${clientIp(request)}`)) {
    return NextResponse.json({ error: 'Too many attempts from here. Please try again in a few minutes.' }, { status: 429 });
  }

  const form = await request.formData().catch(() => null);
  if (!form) return badRequest('Send the proof as multipart/form-data.');
  const field = (name: string) => {
    const value = form.get(name);
    return typeof value === 'string' ? value : '';
  };
  const file = form.get('file');
  if (!(file instanceof File)) return badRequest('Attach a photo or PDF of your receipt.');
  const amount = parseMoneyInput(field('amount'));
  if (amount === null || amount < 1) return badRequest('Enter the amount you paid, like 1500 or 1,500.00.');

  const result = await submitProof(tenant, {
    reference: field('reference'),
    contact: field('contact'),
    method: field('method'),
    claimedAmount: amount,
    paidOn: field('paidOn'),
    payerReference: field('payerReference').trim() || null,
    idempotencyKey: field('idempotencyKey'),
    file: new Uint8Array(await file.arrayBuffer()),
  });
  if (!result) return NextResponse.json({ error: MANAGE_NOT_FOUND }, { status: 404 });
  // The owners and admins hear of a proof to verify (plan/notifications.md).
  notifyAfter(tenant);
  return NextResponse.json(result, { status: 201 });
});
