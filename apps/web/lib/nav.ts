import 'server-only';
import { bookingsConfig, hasBookingPage } from '@rag/bookings';
import type { TenantContext } from '@rag/pipeline';
import { hasApplication } from '@/lib/applications';
import { loadFeatures } from '@/lib/feature-flags';
import type { NavFeatures } from '@/lib/nav-items';

/**
 * What this tenant has, for the header (lib/nav-items.ts). The same checks
 * the pages 404 on: bookings/ and holidays/ need the application, rooms/
 * needs per_room too, book/ needs a priced unit, and a switched-off feature
 * (D-127) has no page at all.
 */
export async function loadNavFeatures(tenant: TenantContext): Promise<NavFeatures> {
  const [bookings, flags] = await Promise.all([hasApplication(tenant, 'bookings'), loadFeatures(tenant)]);
  if (!bookings) return { bookings: false, rooms: false, book: false, manage: false, flags };
  const [config, book] = await Promise.all([bookingsConfig(tenant), hasBookingPage(tenant)]);
  return { bookings: true, rooms: config?.bookingType === 'per_room', book: book && flags.booking_page, manage: flags.manage_booking, flags };
}
