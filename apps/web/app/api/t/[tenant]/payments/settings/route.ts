import { NextResponse } from 'next/server';
import { paymentSettings, setPaymentSettings } from '@rag/bookings';
import { requireAdmin } from '@/lib/admin-auth';
import { requireApplication } from '@/lib/applications';
import { badRequest } from '@/lib/route';
import { firstError, paymentSettingsSchema } from '@/lib/schemas';
import { withTenantRoute } from '@/lib/tenant';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** The payment settings (any member reads: staff tell guests how to pay). `null` = no payment on the page. */
export const GET = withTenantRoute(async (request, { tenant }) => {
  tenant = await requireAdmin(request, tenant, 'payments:read');
  await requireApplication(tenant, 'bookings');
  return NextResponse.json({ settings: await paymentSettings(tenant) });
});

/**
 * Save them, or `{ settings: null }` to stop taking payment on the page.
 * Owners and admins (payments:settings); set_payment_settings() asks the
 * role again and writes the `payments` key alone; the SQL validator's words
 * come back as a 400. Stays already made keep their required amount.
 */
export const PUT = withTenantRoute(async (request, { tenant }) => {
  tenant = await requireAdmin(request, tenant, 'payments:settings');
  await requireApplication(tenant, 'bookings');
  const parsed = paymentSettingsSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return badRequest(firstError(parsed.error));
  const s = parsed.data.settings;
  const settings = s && {
    ...s,
    methods: s.methods.map((m) => ({
      kind: m.kind,
      label: m.label,
      accountName: m.accountName ?? null,
      accountNumber: m.accountNumber ?? null,
      instructions: m.instructions ?? null,
    })),
  };
  return NextResponse.json({ settings: await setPaymentSettings(tenant, settings) });
});
