import { notFound } from 'next/navigation';
import { ActivityScreen } from '@/components/activity-screen';
import { parseActivityFilters } from '@/lib/activity-words';
import { loadBranding } from '@/lib/branding';
import { loadNavFeatures } from '@/lib/nav';
import { getTenant } from '@/lib/tenant';

// S-18 · Activity (plan/audit-log.md, D-138): who did what in this
// workspace. The page holds no data; its one route is guarded by
// requireAdmin(…, 'activity:read') on the server, and the SQL function
// refuses the wrong caller again. Every tenant has it: the log is always
// written, and the screen is a permission, not a feature (plan § 7 q4).
// The filters arrive in the URL, so a view can be shared.

export const dynamic = 'force-dynamic';

export default async function TenantActivityPage({
  params,
  searchParams,
}: {
  params: Promise<{ tenant: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const tenant = await getTenant((await params).tenant);
  if (!tenant) notFound();

  const [branding, nav, query] = await Promise.all([loadBranding(tenant), loadNavFeatures(tenant), searchParams]);

  return <ActivityScreen slug={tenant.slug} businessName={branding.businessName} logoUrl={branding.logoUrl} nav={nav} initial={parseActivityFilters(query)} />;
}
