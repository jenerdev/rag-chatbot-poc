import { notFound } from 'next/navigation';
import { bookingPage, BookingsNotEnabledError, unitPhotos } from '@rag/bookings';
import { BookingPageScreen } from '@/components/booking-page';
import { hasApplication } from '@/lib/applications';
import { loadBranding } from '@/lib/branding';
import { loadNavFeatures } from '@/lib/nav';
import { getTenant } from '@/lib/tenant';

// S-6 · the customer booking page (plan/customer-booking.md § 2.8). PUBLIC,
// like the chat: no login. The Server Component resolves the tenant and reads
// what may be booked on the CHAT token; the Client Component gets plain props,
// never the TenantContext (it carries a live token).
//
// 404 ("No such workspace") for a tenant without the bookings application, and
// for one with nothing priced yet: a page with no price is what this plan
// exists to avoid, and "no page" must look like "no such route".

export const dynamic = 'force-dynamic';

export default async function TenantBookPage({ params }: { params: Promise<{ tenant: string }> }) {
  const tenant = await getTenant((await params).tenant);
  if (!tenant) notFound();
  if (!(await hasApplication(tenant, 'bookings'))) notFound();

  let page;
  try {
    page = await bookingPage(tenant);
  } catch (error) {
    if (error instanceof BookingsNotEnabledError) notFound();
    throw error;
  }
  // Each room's photos for the room step (per_room only); a whole-resort page has no room to show.
  const [branding, nav, photos] = await Promise.all([loadBranding(tenant), loadNavFeatures(tenant), page.bookingType === 'per_room' ? unitPhotos(tenant) : {}]);

  return (
    <BookingPageScreen
      slug={tenant.slug}
      businessName={branding.businessName}
      logoUrl={branding.logoUrl}
      bannerUrl={branding.bannerUrl}
      nav={nav}
      page={page}
      photos={photos}
    />
  );
}
