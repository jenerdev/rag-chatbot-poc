import { notFound } from 'next/navigation';
import { MAX_PAYER_REFERENCE, MAX_PROOF_BYTES, MAX_PROOF_EDGE, PROOF_RETENTION_DAYS } from '@rag/bookings';
import { ManageBookingScreen } from '@/components/manage-booking';
import { hasApplication } from '@/lib/applications';
import { loadBranding } from '@/lib/branding';
import { loadNavFeatures } from '@/lib/nav';
import { featureOn } from '@/lib/feature-flags';
import { referencePrefix } from '@/lib/reference';
import { getTenant } from '@/lib/tenant';

// S-13 · Manage booking (plan/manage-booking.md). PUBLIC, like the booking
// page: a guest finds their stay by its reference and the email or mobile
// number they booked with. Nothing is read here but the tenant: the stay is
// asked for by the Client Component, through POST /manage, so the contact
// never reaches a URL.
//
// 404 ("No such workspace") for a tenant without the bookings application.
// `?ref=` pre-fills the reference (the booking page's receipt links here); it
// grants nothing, and only a reference's shape is passed on.

export const dynamic = 'force-dynamic';

const REFERENCE = /^[A-Za-z]{3}-[A-Za-z0-9]{6}$/;

export default async function TenantManagePage({
  params,
  searchParams,
}: {
  params: Promise<{ tenant: string }>;
  searchParams: Promise<{ ref?: string | string[] }>;
}) {
  const tenant = await getTenant((await params).tenant);
  if (!tenant) notFound();
  if (!(await hasApplication(tenant, 'bookings'))) notFound();
  // A switched-off feature (D-127) has no page: the same 404 as a page that never existed.
  if (!(await featureOn(tenant, 'manage_booking'))) notFound();

  const ref = (await searchParams).ref;
  const initialReference = typeof ref === 'string' && REFERENCE.test(ref) ? ref.toUpperCase() : '';
  const [branding, nav] = await Promise.all([loadBranding(tenant), loadNavFeatures(tenant)]);

  return (
    <ManageBookingScreen
      slug={tenant.slug}
      businessName={branding.businessName}
      assistantName={branding.assistantName}
      logoUrl={branding.logoUrl}
      bannerUrl={branding.bannerUrl}
      nav={nav}
      initialReference={initialReference}
      // D-144: the tenant's fixed prefix ("ALT-"), shown, never typed; the same rule as booking_reference().
      referencePrefix={referencePrefix(tenant.slug)}
      limits={{ maxProofBytes: MAX_PROOF_BYTES, maxProofEdge: MAX_PROOF_EDGE, maxPayerReference: MAX_PAYER_REFERENCE, proofRetentionDays: PROOF_RETENTION_DAYS }}
    />
  );
}
