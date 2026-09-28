import { notFound } from 'next/navigation';
import { HolidaysScreen } from '@/components/holidays-screen';
import { hasApplication } from '@/lib/applications';
import { loadBranding } from '@/lib/branding';
import { getTenant } from '@/lib/tenant';

// S-7 · Holidays (plan/customer-booking.md § 2.3). Like the other admin pages
// it holds no data: every call the screen makes is guarded by requireAdmin()
// on the server. A tenant without the bookings application gets the ordinary
// "No such workspace" 404, not a login form for a feature it does not have.

export const dynamic = 'force-dynamic';

export default async function TenantHolidaysPage({ params }: { params: Promise<{ tenant: string }> }) {
  const tenant = await getTenant((await params).tenant);
  if (!tenant) notFound();
  if (!(await hasApplication(tenant, 'bookings'))) notFound();

  const branding = await loadBranding(tenant);

  return (
    <HolidaysScreen slug={tenant.slug} businessName={branding.businessName} logoUrl={branding.logoUrl} bannerUrl={branding.bannerUrl} />
  );
}
