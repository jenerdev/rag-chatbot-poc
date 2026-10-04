import { notFound } from 'next/navigation';
import { bookingsConfig } from '@rag/bookings';
import { PromosScreen } from '@/components/promos-screen';
import { hasApplication } from '@/lib/applications';
import { loadBranding } from '@/lib/branding';
import { loadNavFeatures } from '@/lib/nav';
import { getTenant } from '@/lib/tenant';

// S-10 · Promos (D-097). Like the other admin pages it holds no data: every
// call the screen makes is guarded by requireAdmin() on the server. A tenant
// without the bookings application gets the ordinary "No such workspace" 404.

export const dynamic = 'force-dynamic';

export default async function TenantPromosPage({ params }: { params: Promise<{ tenant: string }> }) {
  const tenant = await getTenant((await params).tenant);
  if (!tenant) notFound();
  if (!(await hasApplication(tenant, 'bookings'))) notFound();

  const [branding, nav, config] = await Promise.all([loadBranding(tenant), loadNavFeatures(tenant), bookingsConfig(tenant)]);

  return (
    <PromosScreen
      slug={tenant.slug}
      businessName={branding.businessName}
      logoUrl={branding.logoUrl}
      bannerUrl={branding.bannerUrl}
      nav={nav}
      currency={config?.currency ?? 'PHP'}
    />
  );
}
