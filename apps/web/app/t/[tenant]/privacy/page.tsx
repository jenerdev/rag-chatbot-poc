import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { PROOF_RETENTION_DAYS } from '@rag/bookings';
import { BrandHeader } from '@/components/brand-header';
import { LegalBody } from '@/components/legal-page';
import { PublicFooter } from '@/components/public-footer';
import { TenantNav } from '@/components/tenant-nav';
import { loadBranding } from '@/lib/branding';
import { tenantPrivacy } from '@/lib/legal';
import { loadNavFeatures } from '@/lib/nav';
import { getTenant } from '@/lib/tenant';

// The resort's own privacy policy (D-129, plan/legal.md § 3): PUBLIC,
// branded, a 404 for an unknown or archived tenant like every tenant page.
// The text is lib/legal.ts's placeholder, filled with what tenant_public()
// states: the resort's privacy contact, its retention periods, its version.

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Privacy' };

export default async function TenantPrivacyPage({ params }: { params: Promise<{ tenant: string }> }) {
  const tenant = await getTenant((await params).tenant);
  if (!tenant) notFound();
  const [branding, nav] = await Promise.all([loadBranding(tenant), loadNavFeatures(tenant)]);
  const doc = tenantPrivacy({
    businessName: branding.businessName,
    assistantName: branding.assistantName,
    contactName: branding.legal.contactName,
    contactEmail: branding.legal.contactEmail,
    policyVersion: branding.legal.policyVersion,
    chatRetentionDays: branding.legal.chatRetentionDays,
    guestRetentionDays: branding.legal.guestRetentionDays,
    proofRetentionDays: PROOF_RETENTION_DAYS,
    bookings: nav.bookings,
  });
  return (
    <>
      <BrandHeader businessName={branding.businessName} logoUrl={branding.logoUrl} bannerUrl={null} subtitle="Privacy">
        <TenantNav slug={tenant.slug} features={nav} current="legal" />
      </BrandHeader>
      <main className="legal-main">
        <LegalBody doc={doc} />
      </main>
      <PublicFooter slug={tenant.slug} businessName={branding.businessName} manage={nav.manage} book={nav.book} />
    </>
  );
}
