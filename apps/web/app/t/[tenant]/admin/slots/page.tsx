import { notFound } from 'next/navigation';
import { SlotsScreen } from '@/components/slots-screen';
import { hasApplication } from '@/lib/applications';
import { loadBranding } from '@/lib/branding';
import { loadNavFeatures } from '@/lib/nav';
import { getTenant } from '@/lib/tenant';

// S-9 · Slots (D-090). Like the other admin pages it holds no data: every call
// the screen makes is guarded by requireAdmin() on the server. A tenant
// without the bookings application gets the ordinary "No such workspace" 404.

export const dynamic = 'force-dynamic';

export default async function TenantSlotsPage({ params }: { params: Promise<{ tenant: string }> }) {
  const tenant = await getTenant((await params).tenant);
  if (!tenant) notFound();

  // The 404 check beside the loads, not before them (2026-10-27, bookings/page.tsx).
  const [bookings, branding, nav] = await Promise.all([hasApplication(tenant, 'bookings'), loadBranding(tenant), loadNavFeatures(tenant)]);
  if (!bookings) notFound();

  return <SlotsScreen slug={tenant.slug} businessName={branding.businessName} logoUrl={branding.logoUrl} nav={nav} />;
}
