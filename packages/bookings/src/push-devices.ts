// push-devices.ts — a member's devices for push notifications
// (plan/notifications.md Phase 4). ONE row per (tenant, member, device),
// read and written on the member's own STAFF token: the RLS policies let a
// member see, add and remove only their own, and the database fills in
// whose device it is (user_id defaults to auth.uid()). No route ever names
// a user.
//
// An endpoint is a URL the drain will POST to, so it is accepted only on a
// known push service (isPushEndpoint, @rag/push): no SSRF to an internal host.

import { isPushEndpoint } from '@rag/push';
import { BookingConflictError, BookingInputError } from './errors.js';
import type { NotifyKind } from './notify.js';
import type { BookingTenant } from './types.js';

export interface DeviceInput {
  endpoint: string;
  p256dh: string;
  auth: string;
  /** what this device wants to hear; at least one */
  kinds: NotifyKind[];
  userAgent: string | null;
}

/** This device's row for the signed-in member, or null: what the sidebar shows. */
export async function deviceOf(tenant: BookingTenant, endpoint: string): Promise<{ kinds: NotifyKind[] } | null> {
  const { data, error } = await tenant.db.from('push_subscriptions').select('kinds').eq('tenant_id', tenant.id).eq('endpoint', endpoint).maybeSingle();
  if (error) throw new Error(`Could not read this device: ${error.message}`);
  return data ? { kinds: data.kinds } : null;
}

/**
 * Store (or re-store, with new kinds) this device for the signed-in member.
 * Delete + insert: there is no update policy, so a row never changes owner.
 */
export async function saveDevice(tenant: BookingTenant, input: DeviceInput): Promise<{ kinds: NotifyKind[] }> {
  if (!isPushEndpoint(input.endpoint)) throw new BookingInputError('That is not a push subscription this server accepts.');
  const gone = await tenant.db.from('push_subscriptions').delete().eq('tenant_id', tenant.id).eq('endpoint', input.endpoint);
  if (gone.error) throw new Error(`Could not replace this device: ${gone.error.message}`);
  const { data, error } = await tenant.db
    .from('push_subscriptions')
    .insert({ tenant_id: tenant.id, endpoint: input.endpoint, p256dh: input.p256dh, auth: input.auth, kinds: input.kinds, user_agent: input.userAgent?.slice(0, 200) ?? null })
    .select('kinds')
    .single();
  // 23505: the endpoint is another member's row (one browser profile, two logins).
  if (error?.code === '23505') throw new BookingConflictError('This device already gets another member’s notifications. They turn them off first, on this device.');
  if (error?.code === '23514') throw new BookingInputError('That is not a push subscription this server accepts.');
  if (error) throw new Error(`Could not save this device: ${error.message}`);
  console.log(`[notify] ${tenant.slug}: a device subscribed (${data.kinds.join(', ')})`);
  return { kinds: data.kinds };
}

/** Forget this device for the signed-in member. true when a row went. */
export async function removeDevice(tenant: BookingTenant, endpoint: string): Promise<boolean> {
  const { data, error } = await tenant.db.from('push_subscriptions').delete().eq('tenant_id', tenant.id).eq('endpoint', endpoint).select('id');
  if (error) throw new Error(`Could not remove this device: ${error.message}`);
  return (data ?? []).length > 0;
}
