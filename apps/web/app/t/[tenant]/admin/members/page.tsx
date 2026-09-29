import { notFound } from 'next/navigation';
import { MembersScreen } from '@/components/members-screen';
import { loadBranding } from '@/lib/branding';
import { getTenant } from '@/lib/tenant';

// S-8 for one tenant: its members, for its owners (tenant management Phase 5).
// Like every admin page, the page itself holds no data; the browser proves
// its session, and the members route asks `members:manage` on every call.

export const dynamic = 'force-dynamic';

export default async function TenantMembersPage({ params }: { params: Promise<{ tenant: string }> }) {
  const tenant = await getTenant((await params).tenant);
  if (!tenant) notFound();
  const branding = await loadBranding(tenant);

  return <MembersScreen slug={tenant.slug} businessName={branding.businessName} logoUrl={branding.logoUrl} bannerUrl={branding.bannerUrl} />;
}
