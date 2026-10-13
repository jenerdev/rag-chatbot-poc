import { notFound, redirect } from 'next/navigation';
import { hasApplication } from '@/lib/applications';
import { featureOn } from '@/lib/feature-flags';
import { getTenant } from '@/lib/tenant';

// /t/<slug>/admin is the staff side's front door: it sends a member to the
// dashboard (S-11), which shows the login form to anyone signed out. The
// knowledge base (S-2) lives at /admin/documents. The tenant is resolved
// first, so an unknown or archived one is still a 404, not a redirect. With
// the dashboard switched off (D-127) the door opens on Bookings, or on the
// knowledge base for a tenant without bookings.

export const dynamic = 'force-dynamic';

export default async function TenantAdminIndex({ params }: { params: Promise<{ tenant: string }> }) {
  const tenant = await getTenant((await params).tenant);
  if (!tenant) notFound();
  if (await featureOn(tenant, 'dashboard')) redirect(`/t/${tenant.slug}/admin/dashboard`);
  redirect(`/t/${tenant.slug}/admin/${(await hasApplication(tenant, 'bookings')) ? 'bookings' : 'documents'}`);
}
