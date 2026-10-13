import { notFound } from 'next/navigation';
import { countDocuments } from '@rag/pipeline';
import { ChatScreen } from '@/components/chat-screen';
import { loadBranding } from '@/lib/branding';
import { loadNavFeatures } from '@/lib/nav';
import { getTenant } from '@/lib/tenant';

// S-1 for one tenant. The Server Component resolves the tenant and hands the
// Client Component plain props. Nothing tenant-shaped is worked out in the
// browser, and nothing here can fall back to another tenant.

export const dynamic = 'force-dynamic';

export default async function TenantChatPage({ params }: { params: Promise<{ tenant: string }> }) {
  // getTenant() is cache()d, so this is the same lookup the layout made.
  const tenant = await getTenant((await params).tenant);
  if (!tenant) notFound();

  // The "Book" button appears only when the booking page would render: the
  // bookings application, and something with a price (plan § 2.8). That, and
  // the staff pages, is in `nav` (lib/nav.ts).
  const [branding, documentCount, nav] = await Promise.all([loadBranding(tenant), countDocuments(tenant), loadNavFeatures(tenant)]);

  return (
    <ChatScreen
      slug={tenant.slug}
      businessName={branding.businessName}
      assistantName={branding.assistantName}
      logoUrl={branding.logoUrl}
      bannerUrl={branding.bannerUrl}
      assistantAvatarUrl={branding.assistantAvatarUrl}
      documentCount={documentCount}
      nav={nav}
      suggestedQuestions={nav.flags.suggested_questions ? tenant.suggestedQuestions : []}
    />
  );
}
