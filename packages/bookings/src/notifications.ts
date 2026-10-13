// notifications.ts — the Notifications item (plan/notifications.md § 8): what
// arrived for this member, and which of it they have read.
//
// The number in the sidebar used to be what WAITS (attention.ts), so opening
// a notification could never clear it. This is what is UNREAD: one mark per
// member and notification, on every device at once. Both reads run on the
// member's STAFF token through two security-invoker functions
// (schema-notification-reads.sql), so RLS decides what a role may see (a
// proof only for owners and admins, as the push does) and the functions
// refuse anyone who is not staff of the tenant on top.
//
// The words and the link are pushMessage()'s: the list says exactly what the
// phone said.

import { pushMessage, type NotifyKind } from './notify.js';
import type { BookingTenant } from './types.js';

/** One row of the list, as a screen shows it. */
export interface NotificationItem {
  id: number;
  kind: NotifyKind;
  reference: string;
  title: string;
  body: string;
  /** where opening it goes: the stay's page, or Payments for a proof */
  path: string;
  /** when it arrived (an instant) */
  at: string;
  read: boolean;
}

export interface NotificationFeed {
  /** unread in the last 30 days, not only in `items` */
  unread: number;
  items: NotificationItem[];
}

/** How many rows the poll asks for (its toasts) and the page shows. */
export const NOTIFICATION_POLL_ITEMS = 5;
export const NOTIFICATION_PAGE_ITEMS = 100;

interface FeedRow {
  id: number;
  kind: string;
  reference: string;
  firstNight: string | null;
  nights: number | null;
  at: string;
  read: boolean;
}

/** The feed's JSON into typed rows, field by field. Pure, tested. */
export function parseFeed(slug: string, raw: unknown): NotificationFeed {
  const body = (raw ?? {}) as { unread?: unknown; items?: unknown };
  const rows = Array.isArray(body.items) ? (body.items as FeedRow[]) : [];
  return {
    unread: typeof body.unread === 'number' ? body.unread : 0,
    items: rows.map((row) => {
      const message = pushMessage(slug, { id: row.id, kind: row.kind, reference: row.reference, first_night: row.firstNight, nights: row.nights });
      return { id: row.id, kind: message.kind, reference: message.reference, title: message.title, body: message.body, path: message.path, at: row.at, read: row.read === true };
    }),
  };
}

/** This member's notifications, newest first, and how many are unread. */
export async function notificationFeed(tenant: BookingTenant, limit = NOTIFICATION_PAGE_ITEMS): Promise<NotificationFeed> {
  const { data, error } = await tenant.db.rpc('notification_feed', { p_tenant_id: tenant.id, p_limit: limit });
  if (error) throw new Error(`Could not read the notifications: ${error.message}`);
  return parseFeed(tenant.slug, data);
}

/**
 * Mark these notifications read for this member, or every one (ids null:
 * "Mark all read"). An id that is not theirs marks nothing, like one that
 * does not exist. How many were newly marked.
 */
export async function markNotificationsRead(tenant: BookingTenant, ids: number[] | null): Promise<number> {
  const { data, error } = await tenant.db.rpc('notification_read', { p_tenant_id: tenant.id, p_ids: ids });
  if (error) throw new Error(`Could not mark the notifications read: ${error.message}`);
  return typeof data === 'number' ? data : 0;
}
