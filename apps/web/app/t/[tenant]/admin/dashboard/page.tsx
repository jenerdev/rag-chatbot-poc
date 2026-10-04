import { notFound } from 'next/navigation';
import { bookingsConfig } from '@rag/bookings';
import { DashboardScreen } from '@/components/dashboard-screen';
import { loadBranding } from '@/lib/branding';
import { loadNavFeatures } from '@/lib/nav';
import { getTenant } from '@/lib/tenant';

// S-11 · Dashboard (D-098). Every tenant has one (no application required).
// Like the other admin pages it holds no data: the screen calls the route
// after the session check, and the route asks requireAdmin().

export const dynamic = 'force-dynamic';

export default async function TenantDashboardPage({ params }: { params: Promise<{ tenant: string }> }) {
  const tenant = await getTenant((await params).tenant);
  if (!tenant) notFound();

  const [branding, nav, config] = await Promise.all([loadBranding(tenant), loadNavFeatures(tenant), bookingsConfig(tenant).catch(() => null)]);

  return (
    <DashboardScreen
      slug={tenant.slug}
      businessName={branding.businessName}
      logoUrl={branding.logoUrl}
      bannerUrl={branding.bannerUrl}
      nav={nav}
      currency={config?.currency ?? 'PHP'}
    />
  );
}
