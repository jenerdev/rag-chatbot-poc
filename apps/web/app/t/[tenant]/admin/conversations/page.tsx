import { notFound } from 'next/navigation';
import { ConversationsScreen } from '@/components/conversations-screen';
import { loadBranding } from '@/lib/branding';
import { parseListFilters } from '@/lib/conversation-words';
import { loadNavFeatures } from '@/lib/nav';
import { getTenant } from '@/lib/tenant';

// S-16 · Conversations (D-115): every chat visitors had with the assistant.
// Like Unanswered, the page holds no data; its one call is guarded by
// requireAdmin() on the server. Every tenant has it; it is not an
// application. The filters arrive in the URL (a transcript's Back link).

export const dynamic = 'force-dynamic';

export default async function TenantConversationsPage({
  params,
  searchParams,
}: {
  params: Promise<{ tenant: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const tenant = await getTenant((await params).tenant);
  if (!tenant) notFound();

  const [branding, nav, query] = await Promise.all([loadBranding(tenant), loadNavFeatures(tenant), searchParams]);

  return (
    <ConversationsScreen
      slug={tenant.slug}
      businessName={branding.businessName}
      logoUrl={branding.logoUrl}
      bannerUrl={branding.bannerUrl}
      nav={nav}
      initial={parseListFilters(query)}
    />
  );
}
