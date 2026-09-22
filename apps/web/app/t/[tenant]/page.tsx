import { notFound } from 'next/navigation';
import { countDocuments } from '@rag/pipeline';
import { ChatScreen } from '@/components/chat-screen';
import { loadBranding } from '@/lib/branding';
import { getTenant } from '@/lib/tenant';

// S-1 for one tenant. The Server Component resolves the tenant and hands the
// Client Component plain props. Nothing tenant-shaped is worked out in the
// browser, and nothing here can fall back to another tenant.

export const dynamic = 'force-dynamic';

export default async function TenantChatPage({ params }: { params: Promise<{ tenant: string }> }) {
  // getTenant() is cache()d, so this is the same lookup the layout made.
  const tenant = await getTenant((await params).tenant);
  if (!tenant) notFound();

  const [branding, documentCount] = await Promise.all([loadBranding(tenant), countDocuments(tenant)]);

  return (
    <ChatScreen
      slug={tenant.slug}
      businessName={branding.businessName}
      assistantName={branding.assistantName}
      logoUrl={branding.logoUrl}
      bannerUrl={branding.bannerUrl}
      documentCount={documentCount}
    />
  );
}
