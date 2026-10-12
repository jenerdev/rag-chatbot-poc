import { notFound } from 'next/navigation';
import { TranscriptScreen } from '@/components/transcript-screen';
import { loadBranding } from '@/lib/branding';
import { listQuery, parseListFilters } from '@/lib/conversation-words';
import { loadNavFeatures } from '@/lib/nav';
import { getTenant } from '@/lib/tenant';

// S-16a · one conversation's transcript (D-115). The page holds no data; the
// screen asks GET /api/t/<slug>/admin/conversations/<id>, guarded by
// requireAdmin(), which answers 404 for an id that is not this tenant's.
// The list's filters ride along in the query string, for Back; `?m=` names
// the message to scroll to.

export const dynamic = 'force-dynamic';

export default async function ConversationPage({
  params,
  searchParams,
}: {
  params: Promise<{ tenant: string; id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { tenant: slug, id } = await params;
  const tenant = await getTenant(slug);
  if (!tenant) notFound();

  const [branding, nav, query] = await Promise.all([loadBranding(tenant), loadNavFeatures(tenant), searchParams]);
  const m = Number(Array.isArray(query.m) ? query.m[0] : query.m);

  return (
    <TranscriptScreen
      slug={tenant.slug}
      id={id}
      businessName={branding.businessName}
      assistantName={branding.assistantName}
      logoUrl={branding.logoUrl}
      bannerUrl={branding.bannerUrl}
      nav={nav}
      backQuery={listQuery(parseListFilters(query))}
      focus={Number.isInteger(m) && m > 0 ? m : null}
    />
  );
}
