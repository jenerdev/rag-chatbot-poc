import 'server-only';
import { after } from 'next/server';
import { drainNotifications, type BookingTenant } from '@rag/bookings';

/**
 * Drain this tenant's notification outbox AFTER the response is sent
 * (plan/notifications.md Phase 5, § 7 q5): the guest's answer never waits on
 * a push service, and a push service that is down never fails their request
 * (Rule 1: the event, and so the outbox row, is already committed).
 *
 * Called by the three guest writes that make news (a web request, a proof, a
 * change request) on the guest's chat token, and by the staff attention poll
 * on a staff token, which sweeps whatever a failed drain left. A failure is
 * logged and left for that sweep.
 */
export function notifyAfter(tenant: BookingTenant): void {
  after(async () => {
    try {
      await drainNotifications(tenant);
    } catch (error) {
      console.error(`[notify] ${tenant.slug}: the drain failed, the next poll retries: ${(error as Error).message}`);
    }
  });
}
