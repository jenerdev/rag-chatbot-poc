// attention.ts — what waits on staff right now, as three numbers
// (plan/notifications.md Phase 1). Read every 30 s by each open staff tab,
// so it is three cheap reads and nothing else.
//
// No new SQL (the plan's layer 1): the proofs and the change requests are
// manage_attention()'s (invoker, refuses a non-member), and the requests are
// counted here from the rows, by the same rule as tenant_dashboard()'s
// `pendingRequests`: a web stay, pending, whose last night has not ended.
// Pending web rows are few (a request expires, D-105), so reading their
// group and span is cheaper than the whole dashboard.

import { parseSpan } from './requests.js';
import type { BookingTenant } from './types.js';

export interface AttentionCounts {
  /** pending web stays not yet over: a guest waits for a Confirm */
  requests: number;
  /** proofs of payment sent, not yet verified or rejected */
  proofs: number;
  /** a guest asked to cancel or move, not yet decided */
  changes: number;
}

/** On a STAFF context (requireAdmin's): a chat token reads no booking row, and manage_attention() refuses it. */
export async function attentionCounts(tenant: BookingTenant, now = Date.now()): Promise<AttentionCounts> {
  const [rows, extra] = await Promise.all([
    tenant.db.from('bookings').select('group_id, during').eq('tenant_id', tenant.id).eq('source', 'web').eq('status', 'pending'),
    tenant.db.rpc('manage_attention', { p_tenant_id: tenant.id }),
  ]);
  if (rows.error) throw new Error(`Could not count the requests: ${rows.error.message}`);
  if (extra.error) throw new Error(`Could not count what waits: ${extra.error.message}`);
  // One stay is one request, however many nights and rooms (D-100's group).
  const open = new Set(rows.data.filter((r) => (parseSpan(r.during)?.[1] ?? 0) > now).map((r) => r.group_id));
  const counts = (extra.data ?? {}) as { proofsToVerify?: number; changeRequests?: number };
  return { requests: open.size, proofs: counts.proofsToVerify ?? 0, changes: counts.changeRequests ?? 0 };
}
