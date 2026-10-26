import { notFound } from 'next/navigation';
import { NotificationsScreen } from '@/components/notifications-screen';
import { hasApplication } from '@/lib/applications';
import { loadBranding } from '@/lib/branding';
import { loadNavFeatures } from '@/lib/nav';
import { featureOn } from '@/lib/feature-flags';
import { getTenant } from '@/lib/tenant';

// S-17 · Notifications (plan/notifications.md § 8). Like the other admin
// pages it holds no data: the screen's calls are guarded by requireAdmin()
// on the server, and RLS decides which rows a role sees. A tenant without
// the bookings application has nothing to notify of: the ordinary 404.

export const dynamic = 'force-dynamic';

export default async function TenantNotificationsPage({ params }: { params: Promise<{ tenant: string }> }) {
  const tenant = await getTenant((await params).tenant);
  if (!tenant) notFound();
  // A switched-off feature (D-127) has no page: the same 404 as a page that never existed.
  // Both 404 checks beside the loads, not before them (2026-10-27, bookings/page.tsx).
  const [bookings, on, branding, nav] = await Promise.all([hasApplication(tenant, 'bookings'), featureOn(tenant, 'notifications'), loadBranding(tenant), loadNavFeatures(tenant)]);
  if (!bookings || !on) notFound();

  return <NotificationsScreen slug={tenant.slug} businessName={branding.businessName} logoUrl={branding.logoUrl} nav={nav} />;
}
