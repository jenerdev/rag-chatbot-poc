import { notFound } from 'next/navigation';
import { bookingsConfig, MAX_IMAGE_BYTES, MAX_IMAGE_EDGE, MAX_IMAGES_PER_UNIT } from '@rag/bookings';
import { AccommodationsScreen } from '@/components/accommodations-screen';
import { hasApplication } from '@/lib/applications';
import { loadBranding } from '@/lib/branding';
import { loadNavFeatures } from '@/lib/nav';
import { getTenant } from '@/lib/tenant';

// S-5 · Rooms, for a per_room tenant (plan/booking-types.md Phase 4). Like the
// other admin pages, it holds no data itself: every call the screen makes is
// guarded by requireAdmin() on the server.
//
// A tenant without the bookings application, or one that books its whole
// property, gets the ordinary "No such workspace" 404: not a login form for a
// feature it does not have.
//
// The photo limits come from @rag/bookings HERE, on the server, and reach the
// Client Component as props, so the browser's resize and the server's check
// use one number, not two copies (the reason lib/limits.ts exists).

export const dynamic = 'force-dynamic';

export default async function TenantAccommodationsPage({ params }: { params: Promise<{ tenant: string }> }) {
  const tenant = await getTenant((await params).tenant);
  if (!tenant) notFound();
  if (!(await hasApplication(tenant, 'bookings'))) notFound();
  if ((await bookingsConfig(tenant))?.bookingType !== 'per_room') notFound();

  const [branding, nav] = await Promise.all([loadBranding(tenant), loadNavFeatures(tenant)]);

  return (
    <AccommodationsScreen
      slug={tenant.slug}
      businessName={branding.businessName}
      logoUrl={branding.logoUrl}
      bannerUrl={branding.bannerUrl}
      nav={nav}
      maxImageBytes={MAX_IMAGE_BYTES}
      maxImageEdge={MAX_IMAGE_EDGE}
      maxImagesPerUnit={MAX_IMAGES_PER_UNIT}
    />
  );
}
