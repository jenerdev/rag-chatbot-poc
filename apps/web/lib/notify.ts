import 'server-only';
import { after } from 'next/server';
import { drainNotifications, type BookingTenant } from '@rag/bookings';
import { notifierClient } from '@rag/db';

/**
 * Drain this tenant's notification outbox AFTER the response is sent
 * (plan/notifications.md Phase 5, § 7 q5): the guest's answer never waits on
 * a push service, and a push service that is down never fails their request
 * (Rule 1: the event, and so the outbox row, is already committed).
 *
 * Called by the three guest writes that make news (a web request, a proof, a
 * change request), and by the staff attention poll, which sweeps whatever a
 * failed drain left. A failure is logged and left for that sweep.
 *
 * D-166 (audit S-10): whoever calls it, the drain runs on its OWN token
 * (notifierClient(): this tenant, no user, `app_notifier`), the only one
 * notify_claim() and notify_done() accept. Never on the guest's chat token
 * or a member's staff token, so neither can drain the queue if it leaks.
 */
export function notifyAfter(tenant: BookingTenant): void {
  after(async () => {
    try {
      await drainNotifications({ ...tenant, db: notifierClient(tenant.id) });
    } catch (error) {
      console.error(`[notify] ${tenant.slug}: the drain failed, the next poll retries: ${(error as Error).message}`);
    }
  });
}
