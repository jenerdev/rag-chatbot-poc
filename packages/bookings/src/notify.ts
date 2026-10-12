// notify.ts — the drain (plan/notifications.md Phase 5): send what the
// outbox holds for ONE tenant to the devices of the members who may hear it.
//
//   notify_claim()  the rows, claimed, joined to their recipients NOW (Rule 3)
//   sendPush()      one encrypted POST per device (@rag/push)
//   notify_done()   what each push service said: ok, gone (deleted), retry
//
// Called after a guest's write succeeds (book/request, a proof, a change
// request: next/server's after(), so the guest's answer is not delayed), and
// by the attention poll on a staff token, which sweeps what a failed drain
// left. Either token works: notify_claim() is a definer that checks the
// tenant is the token's.
//
// With no VAPID key configured, push is off and nothing is claimed: the rows
// wait (and expire after 24 h in the claim), so configuring push later does
// not lose today's news.

import { sendPush, vapidKeys, type PushResult } from '@rag/push';
import type { BookingTenant } from './types.js';

export type NotifyKind = 'request' | 'proof' | 'change';

/** One claimed row, as notify_claim() returns it. */
interface ClaimRow {
  outbox_id: number;
  kind: string;
  reference: string;
  first_night: string | null;
  nights: number | null;
  subscription_id: number;
  endpoint: string;
  p256dh: string;
  auth: string;
}

/** What a device shows. Named fields only (Rule 2): no guest name, phone, email or amount. */
export interface PushMessage {
  kind: NotifyKind;
  reference: string;
  title: string;
  body: string;
  /** where a tap opens: the stay's page, or Payments for a proof */
  path: string;
}

/** "Fri 16 Oct" for a YYYY-MM-DD date: a calendar date, formatted as UTC. */
function shortDate(date: string): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
}

/** The words and the link for one outbox row. Pure, tested. */
export function pushMessage(slug: string, row: { kind: string; reference: string; first_night: string | null; nights: number | null }): PushMessage {
  const kind = (['request', 'proof', 'change'].includes(row.kind) ? row.kind : 'request') as NotifyKind;
  const when = row.first_night ? `${row.nights && row.nights > 1 ? `${row.nights} nights from ` : ''}${shortDate(row.first_night)}` : '';
  const stay = `/t/${slug}/admin/bookings/${encodeURIComponent(row.reference)}`;
  if (kind === 'proof') return { kind, reference: row.reference, title: 'A proof of payment to verify', body: `${row.reference}${when ? ` · ${when}` : ''}`, path: `/t/${slug}/admin/payments` };
  if (kind === 'change') return { kind, reference: row.reference, title: 'A guest asks to change a stay', body: `${row.reference}${when ? ` · ${when}` : ''}`, path: stay };
  return { kind, reference: row.reference, title: 'New booking request', body: `${row.reference}${when ? ` · ${when}` : ''}`, path: stay };
}

/** How many devices are sent to at once: a drain is small, but not one by one. */
const SEND_CONCURRENCY = 8;

export interface DrainResult {
  messages: number;
  ok: number;
  gone: number;
  retry: number;
}

/** Drain this tenant's outbox. null: push is not configured here. Never throws for a send that failed; that is a `retry`. */
export async function drainNotifications(tenant: BookingTenant): Promise<DrainResult | null> {
  const keys = vapidKeys();
  if (!keys) return null;
  const { data, error } = await tenant.db.rpc('notify_claim', { p_tenant_id: tenant.id });
  if (error) throw new Error(`Could not claim notifications: ${error.message}`);
  const rows = (data ?? []) as ClaimRow[];
  if (rows.length === 0) return { messages: 0, ok: 0, gone: 0, retry: 0 };

  const results: { outbox: number; subscription: number; result: PushResult }[] = [];
  let next = 0;
  const worker = async () => {
    while (next < rows.length) {
      const row = rows[next++]!;
      const message = pushMessage(tenant.slug, row);
      const result = await sendPush({ endpoint: row.endpoint, p256dh: row.p256dh, auth: row.auth }, message, keys, row.reference);
      results.push({ outbox: row.outbox_id, subscription: row.subscription_id, result });
    }
  };
  await Promise.all(Array.from({ length: Math.min(SEND_CONCURRENCY, rows.length) }, worker));

  const done = await tenant.db.rpc('notify_done', { p_results: results });
  if (done.error) throw new Error(`Could not record the notifications: ${done.error.message}`);
  const count = (r: PushResult) => results.filter((x) => x.result === r).length;
  const summary = { messages: new Set(rows.map((r) => r.outbox_id)).size, ok: count('ok'), gone: count('gone'), retry: count('retry') };
  console.log(`[notify] ${tenant.slug}: ${summary.messages} message(s) to ${results.length} device(s): ${summary.ok} ok, ${summary.gone} gone, ${summary.retry} retry`);
  return summary;
}
