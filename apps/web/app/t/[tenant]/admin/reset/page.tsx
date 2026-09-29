import { notFound } from 'next/navigation';
import { BrandHeader } from '@/components/brand-header';
import { ResetPassword } from '@/components/reset-password';
import { TenantNav } from '@/components/tenant-nav';
import { loadBranding } from '@/lib/branding';
import { loadNavFeatures } from '@/lib/nav';
import { getTenant } from '@/lib/tenant';

// Where a password-reset (or invite) email lands (auth-rls Phase 5). The page
// holds nothing: the proof is in the link's #fragment, which never reaches
// the server, so a Client Component reads it.

export const dynamic = 'force-dynamic';

export default async function TenantResetPage({ params }: { params: Promise<{ tenant: string }> }) {
  const tenant = await getTenant((await params).tenant);
  if (!tenant) notFound();
  const [branding, nav] = await Promise.all([loadBranding(tenant), loadNavFeatures(tenant)]);

  return (
    <>
      <BrandHeader businessName={branding.businessName} logoUrl={branding.logoUrl} bannerUrl={branding.bannerUrl} subtitle="Set a password">
        <TenantNav slug={tenant.slug} features={nav} current="reset" />
      </BrandHeader>
      <main>
        <ResetPassword api={`/api/t/${tenant.slug}/admin/password`} loginHref={`/t/${tenant.slug}/admin`} />
      </main>
    </>
  );
}
