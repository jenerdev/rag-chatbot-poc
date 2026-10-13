import { notFound } from 'next/navigation';
import { bookingsConfig } from '@rag/bookings';
import { PaymentsScreen } from '@/components/payments-screen';
import { hasApplication } from '@/lib/applications';
import { loadBranding } from '@/lib/branding';
import { loadNavFeatures } from '@/lib/nav';
import { getTenant } from '@/lib/tenant';

// S-14 · Payments (plan/manage-booking.md Phase 4). Like the other admin
// pages it holds no data: every call the screen makes is guarded by
// requireAdmin() on the server, and every write is a SQL function that asks
// the role again. A tenant without the bookings application gets the
// ordinary "No such workspace" 404.

export const dynamic = 'force-dynamic';

export default async function TenantPaymentsPage({ params }: { params: Promise<{ tenant: string }> }) {
  const tenant = await getTenant((await params).tenant);
  if (!tenant) notFound();
  if (!(await hasApplication(tenant, 'bookings'))) notFound();

  const [branding, nav, config] = await Promise.all([loadBranding(tenant), loadNavFeatures(tenant), bookingsConfig(tenant)]);

  return (
    <PaymentsScreen
      slug={tenant.slug}
      businessName={branding.businessName}
      logoUrl={branding.logoUrl}
      nav={nav}
      currency={config?.currency ?? 'PHP'}
      timezone={config?.timezone ?? 'Asia/Manila'}
    />
  );
}
