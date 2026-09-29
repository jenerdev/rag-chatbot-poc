import 'server-only';
import { bookingsConfig, hasBookingPage } from '@rag/bookings';
import type { TenantContext } from '@rag/pipeline';
import { hasApplication } from '@/lib/applications';
import type { NavFeatures } from '@/lib/nav-items';

/**
 * What this tenant has, for the header (lib/nav-items.ts). The same checks
 * the pages 404 on: bookings/ and holidays/ need the application, rooms/
 * needs per_room too, and book/ needs a priced unit.
 */
export async function loadNavFeatures(tenant: TenantContext): Promise<NavFeatures> {
  if (!(await hasApplication(tenant, 'bookings'))) return { bookings: false, rooms: false, book: false };
  const [config, book] = await Promise.all([bookingsConfig(tenant), hasBookingPage(tenant)]);
  return { bookings: true, rooms: config?.bookingType === 'per_room', book };
}
