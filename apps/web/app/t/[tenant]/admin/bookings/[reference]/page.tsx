import { notFound } from 'next/navigation';
import { MAX_STAY_NOTE } from '@rag/bookings';
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

  // The 404 check beside the loads, not before them (2026-10-27, bookings/page.tsx).
  const [bookings, branding, nav] = await Promise.all([hasApplication(tenant, 'bookings'), loadBranding(tenant), loadNavFeatures(tenant)]);
  if (!bookings) notFound();

  return (
    <StayDetailScreen
      slug={tenant.slug}
      reference={decodeURIComponent(reference).toUpperCase()}
      businessName={branding.businessName}
      logoUrl={branding.logoUrl}
      nav={nav}
      maxNote={MAX_STAY_NOTE}
    />
  );
}
