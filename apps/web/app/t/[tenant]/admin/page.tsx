import { notFound, redirect } from 'next/navigation';
import { getTenant } from '@/lib/tenant';

// /t/<slug>/admin is the staff side's front door: it sends a member to the
// dashboard (S-11), which shows the login form to anyone signed out. The
// knowledge base (S-2) lives at /admin/documents. The tenant is resolved
// first, so an unknown or archived one is still a 404, not a redirect.

export const dynamic = 'force-dynamic';

export default async function TenantAdminIndex({ params }: { params: Promise<{ tenant: string }> }) {
  const tenant = await getTenant((await params).tenant);
  if (!tenant) notFound();
  redirect(`/t/${tenant.slug}/admin/dashboard`);
}
