import { notFound } from 'next/navigation';
import { bookingsConfig, DEFAULT_EXTRA_PERSON_RATE, DEFAULT_MAX_CAPACITY, DEFAULT_STANDARD_CAPACITY, MAX_IMAGE_BYTES, MAX_IMAGE_EDGE, MAX_IMAGES_PER_UNIT } from '@rag/bookings';
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

  // Both 404 checks beside the loads, not before them (2026-10-27,
  // bookings/page.tsx): two serial round trips became none. bookingsConfig()
  // is null, not a throw, for a tenant without the application.
  const [bookings, config, branding, nav] = await Promise.all([hasApplication(tenant, 'bookings'), bookingsConfig(tenant), loadBranding(tenant), loadNavFeatures(tenant)]);
  if (!bookings || config?.bookingType !== 'per_room') notFound();

  return (
    <AccommodationsScreen
      slug={tenant.slug}
      businessName={branding.businessName}
      logoUrl={branding.logoUrl}
      nav={nav}
      maxImageBytes={MAX_IMAGE_BYTES}
      maxImageEdge={MAX_IMAGE_EDGE}
      maxImagesPerUnit={MAX_IMAGES_PER_UNIT}
      roomDefaults={{ standard: DEFAULT_STANDARD_CAPACITY, max: DEFAULT_MAX_CAPACITY, extraFee: DEFAULT_EXTRA_PERSON_RATE }}
    />
  );
}
