import { notFound } from 'next/navigation';
import { BookingsScreen } from '@/components/bookings-screen';
import { hasApplication } from '@/lib/applications';
import { loadBranding } from '@/lib/branding';
import { loadNavFeatures } from '@/lib/nav';
import { getTenant } from '@/lib/tenant';

// S-3 for one tenant. Like the knowledge-base page, the page itself holds no
// data. Every call it makes is guarded by requireAdmin() on the server.
//
// A tenant without the bookings application gets the ordinary "No such
// workspace" 404, the same page as a slug that does not exist. It does not
// get a login form for a feature it does not have (plan/bookings.md Phase 3).

export const dynamic = 'force-dynamic';

export default async function TenantBookingsPage({ params }: { params: Promise<{ tenant: string }> }) {
  const tenant = await getTenant((await params).tenant);
  if (!tenant) notFound();
  if (!(await hasApplication(tenant, 'bookings'))) notFound();

  const [branding, nav] = await Promise.all([loadBranding(tenant), loadNavFeatures(tenant)]);

  return (
    <BookingsScreen
      slug={tenant.slug}
      businessName={branding.businessName}
      logoUrl={branding.logoUrl}
      nav={nav}
    />
  );
}
