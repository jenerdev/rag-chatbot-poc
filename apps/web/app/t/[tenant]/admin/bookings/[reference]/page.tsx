import { notFound } from 'next/navigation';
import { StayDetailScreen } from '@/components/stay-detail-screen';
import { hasApplication } from '@/lib/applications';
import { loadBranding } from '@/lib/branding';
import { loadNavFeatures } from '@/lib/nav';
import { getTenant } from '@/lib/tenant';

// S-15 · one booking, by its reference (D-114): where every action on a
// stay is taken. Like the Bookings page, the page holds no data; the screen
// asks GET /api/t/<slug>/bookings/stay/<reference>, guarded by requireAdmin().
// A tenant without the bookings application gets the ordinary 404.

export const dynamic = 'force-dynamic';

export default async function StayDetailPage({ params }: { params: Promise<{ tenant: string; reference: string }> }) {
  const { tenant: slug, reference } = await params;
  const tenant = await getTenant(slug);
  if (!tenant) notFound();
  if (!(await hasApplication(tenant, 'bookings'))) notFound();

  const [branding, nav] = await Promise.all([loadBranding(tenant), loadNavFeatures(tenant)]);

  return (
    <StayDetailScreen
      slug={tenant.slug}
      reference={decodeURIComponent(reference).toUpperCase()}
      businessName={branding.businessName}
      logoUrl={branding.logoUrl}
      nav={nav}
    />
  );
}
