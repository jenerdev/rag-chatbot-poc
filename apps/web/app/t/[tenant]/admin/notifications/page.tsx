import { notFound } from 'next/navigation';
import { NotificationsScreen } from '@/components/notifications-screen';
import { hasApplication } from '@/lib/applications';
import { loadBranding } from '@/lib/branding';
import { loadNavFeatures } from '@/lib/nav';
import { getTenant } from '@/lib/tenant';

// S-17 · Notifications (plan/notifications.md § 8). Like the other admin
// pages it holds no data: the screen's calls are guarded by requireAdmin()
// on the server, and RLS decides which rows a role sees. A tenant without
// the bookings application has nothing to notify of: the ordinary 404.

export const dynamic = 'force-dynamic';

export default async function TenantNotificationsPage({ params }: { params: Promise<{ tenant: string }> }) {
  const tenant = await getTenant((await params).tenant);
  if (!tenant) notFound();
  if (!(await hasApplication(tenant, 'bookings'))) notFound();

  const [branding, nav] = await Promise.all([loadBranding(tenant), loadNavFeatures(tenant)]);

  return <NotificationsScreen slug={tenant.slug} businessName={branding.businessName} logoUrl={branding.logoUrl} bannerUrl={branding.bannerUrl} nav={nav} />;
}
