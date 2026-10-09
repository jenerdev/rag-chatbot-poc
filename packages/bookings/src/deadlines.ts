// deadlines.ts — the expiry sweep (plan/manage-booking.md Phase 5, § 2.5).
//
// expire_due_stays() writes 'expired' on every pending stay of the tenant
// that is past its payment deadline with nothing verified and no proof sent
// in time, as the SYSTEM (its events say so). Reads do not need it: the
// guest page says "expired" the moment a stay is due (stay_is_due()), and a
// lapsed hold blocks nothing (booking_takes()). The sweep only makes the
// staff lists say the word too, so it runs before each of them.
//
// pg_cron is available on the project but not enabled (Phase 0); nothing here
// depends on it.

import type { BookingTenant } from './types.js';

/** Expire the tenant's due stays; how many rows changed. A token that is not staff sweeps nothing (0). */
export async function expireDueStays(tenant: BookingTenant): Promise<number> {
  const { data, error } = await tenant.db.rpc('expire_due_stays', { p_tenant_id: tenant.id });
  // A chat token is refused (42501): it lists nothing either, so it has
  // nothing to sweep. Every other error is a fault.
  if (error?.code === '42501') return 0;
  if (error) throw new Error(`Could not expire due bookings: ${error.message}`);
  const rows = data ?? 0;
  if (rows > 0) console.log(`[bookings] ${tenant.slug} expired ${rows} row(s) past their payment deadline`);
  return rows;
}
