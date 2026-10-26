import { notFound } from 'next/navigation';
import { UNANSWERED_LIMIT } from '@rag/pipeline';
import { UnansweredScreen } from '@/components/unanswered-screen';
import { loadBranding } from '@/lib/branding';
import { loadNavFeatures } from '@/lib/nav';
import { featureOn } from '@/lib/feature-flags';
import { getTenant } from '@/lib/tenant';

// S-4 for one tenant: the questions the documents could not answer. Like the
// knowledge-base page, the page holds no data. Its one call is guarded by
// requireAdmin() on the server. Every tenant has it; it is not an application.

export const dynamic = 'force-dynamic';

export default async function TenantUnansweredPage({ params }: { params: Promise<{ tenant: string }> }) {
  const tenant = await getTenant((await params).tenant);
  if (!tenant) notFound();
  // A switched-off feature (D-127) has no page: the same 404 as a page that never existed.
  // The 404 check beside the loads, not before them (2026-10-27, bookings/page.tsx).
  const [on, branding, nav] = await Promise.all([featureOn(tenant, 'unanswered'), loadBranding(tenant), loadNavFeatures(tenant)]);
  if (!on) notFound();

  return (
    <UnansweredScreen
      slug={tenant.slug}
      businessName={branding.businessName}
      logoUrl={branding.logoUrl}
      nav={nav}
      limit={UNANSWERED_LIMIT}
    />
  );
}
