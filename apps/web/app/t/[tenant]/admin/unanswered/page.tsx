import { notFound } from 'next/navigation';
import { UNANSWERED_LIMIT } from '@rag/pipeline';
import { UnansweredScreen } from '@/components/unanswered-screen';
import { loadBranding } from '@/lib/branding';
import { loadNavFeatures } from '@/lib/nav';
import { getTenant } from '@/lib/tenant';

// S-4 for one tenant: the questions the documents could not answer. Like the
// knowledge-base page, the page holds no data. Its one call is guarded by
// requireAdmin() on the server. Every tenant has it; it is not an application.

export const dynamic = 'force-dynamic';

export default async function TenantUnansweredPage({ params }: { params: Promise<{ tenant: string }> }) {
  const tenant = await getTenant((await params).tenant);
  if (!tenant) notFound();

  const [branding, nav] = await Promise.all([loadBranding(tenant), loadNavFeatures(tenant)]);

  return (
    <UnansweredScreen
      slug={tenant.slug}
      businessName={branding.businessName}
      logoUrl={branding.logoUrl}
      bannerUrl={branding.bannerUrl}
      nav={nav}
      limit={UNANSWERED_LIMIT}
    />
  );
}
