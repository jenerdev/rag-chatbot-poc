import { notFound } from 'next/navigation';
import { AdminScreen } from '@/components/admin-screen';
import { loadBranding } from '@/lib/branding';
import { loadNavFeatures } from '@/lib/nav';
import { getTenant } from '@/lib/tenant';

// S-2 for one tenant, at /admin/documents since 2026-10-09 (/admin is the
// dashboard now). The page itself is public: it holds no data until the
// browser proves it has this tenant's admin session. Every document call it
// makes is guarded by requireAdmin() on the server (Phase 6).

export const dynamic = 'force-dynamic';

export default async function TenantAdminPage({ params }: { params: Promise<{ tenant: string }> }) {
  const tenant = await getTenant((await params).tenant);
  if (!tenant) notFound();

  const [branding, nav] = await Promise.all([loadBranding(tenant), loadNavFeatures(tenant)]);

  return (
    <AdminScreen
      slug={tenant.slug}
      businessName={branding.businessName}
      logoUrl={branding.logoUrl}
      nav={nav}
    />
  );
}
