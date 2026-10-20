// activity.ts — who did what, for a tenant's owners and for the platform
// (plan/audit-log.md, D-138).
//
// ONE read, listActivity(), over activity_list() in SQL: a page of
// audit_log rows (written by the audit_row() trigger and audit_note(),
// never by a route: plan Rule 1) and, for a tenant, its booking_events
// rows (a stay's log, never its note: Rule 2), newest first, keyset-paged.
// Nothing here writes.
//
// Two callers, two contexts:
//   - a STAFF context (requireAdmin(…, 'activity:read')) for S-18, the
//     tenant's own log;
//   - the PLATFORM context (withPlatformRoute) for a tenant's Activity tab
//     and for the platform-wide rows (tenantId null).
// The function refuses any other caller itself (Rule 4), so a chat token
// gets a 403 here, not an empty page.

import { fromPostgrest } from './platform.js';
import type { DbClient } from '@rag/db';

/** The windows the list offers, in days; the function says 30 for anything else. */
export const ACTIVITY_DAYS = [7, 30, 90, 365] as const;
export type ActivityDays = (typeof ACTIVITY_DAYS)[number];

/** One page. The function caps it at 200. */
export const ACTIVITY_PAGE_SIZE = 50;

/** The areas a row can be in: audit_row()'s case, audit_note()'s two, and the stay log. */
export const ACTIVITY_AREAS = [
  'bookings', 'documents', 'rooms', 'rates', 'photos', 'holidays', 'slots', 'promos', 'members',
  'permissions', 'features', 'applications', 'tenant', 'unanswered', 'stay_notes', 'session', 'proof', 'platform',
] as const;
export type ActivityArea = (typeof ACTIVITY_AREAS)[number];

/** `days` as one of the windows; anything else is 30. */
export function activityDays(value: unknown): ActivityDays {
  const n = typeof value === 'string' ? Number(value) : value;
  return (ACTIVITY_DAYS as readonly unknown[]).includes(n) ? (n as ActivityDays) : 30;
}

/** `area` as one of the areas, or null for "every area". */
export function activityArea(value: unknown): ActivityArea | null {
  return typeof value === 'string' && (ACTIVITY_AREAS as readonly string[]).includes(value) ? (value as ActivityArea) : null;
}

export interface ActivityRow {
  /** `<source>:<id>`, unique across the two sources; the keyset cursor with `at` */
  key: string;
  source: 'audit' | 'bookings';
  at: string;
  /** staff, super, system (audit_log); guest, staff, system (booking_events) */
  actorKind: string;
  actorUser: string | null;
  /** a CURRENT member's email; null for a removed member, a super user, the system */
  actorEmail: string | null;
  area: string;
  /** insert, update, delete, login, logout, proof_opened, tenant_removed; a booking event's kind */
  action: string;
  subject: string | null;
  label: string | null;
  /** an update's changed columns, by name */
  changed: string[] | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
}

export interface ActivityPage {
  timezone: string;
  days: ActivityDays;
  /** every row matching the filters; 0 on a page past the end (the screen keeps the first page's) */
  total: number;
  more: boolean;
  rows: ActivityRow[];
}

export interface ActivityQuery {
  days?: unknown;
  area?: unknown;
  /** one member's user id */
  actor?: string | null;
  q?: string | null;
  /** the previous page's last row: its at and key */
  before?: { at: string; key: string } | null;
}

type J = Record<string, unknown>;
const obj = (v: unknown): J | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as J) : null);
const num = (v: unknown): number => (typeof v === 'number' ? v : Number(v ?? 0) || 0);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY = /^(audit|bookings):\d+$/;

/** The function's jsonb as an ActivityPage. Field by field, never spread. Exported for the test. */
export function parseActivityPage(raw: unknown): ActivityPage {
  const r = obj(raw) ?? {};
  const rows = Array.isArray(r.rows) ? r.rows.map((x) => obj(x) ?? {}) : [];
  return {
    timezone: String(r.timezone ?? 'Asia/Manila'),
    days: activityDays(num(r.days)),
    total: num(r.total),
    more: r.more === true,
    rows: rows.map((x) => ({
      key: String(x.key ?? ''),
      source: x.source === 'bookings' ? 'bookings' : 'audit',
      at: String(x.at ?? ''),
      actorKind: String(x.actorKind ?? 'system'),
      actorUser: str(x.actorUser),
      actorEmail: str(x.actorEmail),
      area: String(x.area ?? ''),
      action: String(x.action ?? ''),
      subject: str(x.subject),
      label: str(x.label),
      changed: Array.isArray(x.changed) ? x.changed.filter((c): c is string => typeof c === 'string') : null,
      before: obj(x.before),
      after: obj(x.after),
    })),
  };
}

/**
 * One page of a tenant's activity (`tenantId`), or of the platform's own
 * rows (`tenantId` null: super users only). `db` is the caller's client:
 * the staff token or the platform token; the function decides.
 */
export async function listActivity(db: DbClient, tenantId: number | null, q: ActivityQuery = {}): Promise<ActivityPage> {
  const query = q.q?.trim() ? q.q.trim().slice(0, 200) : null;
  const actor = q.actor && UUID.test(q.actor) ? q.actor : null;
  const before = q.before && KEY.test(q.before.key) && !Number.isNaN(Date.parse(q.before.at)) ? q.before : null;
  const { data, error } = await db.rpc('activity_list', {
    p_tenant_id: tenantId,
    p_days: activityDays(q.days),
    p_area: activityArea(q.area),
    p_actor: actor,
    p_q: query,
    p_before_at: before?.at ?? null,
    p_before_key: before?.key ?? null,
    p_limit: ACTIVITY_PAGE_SIZE,
  });
  if (error) throw fromPostgrest(error, 'Could not load the activity');
  const page = parseActivityPage(data);
  console.log(`[activity] tenant=${tenantId ?? 'platform'} days=${page.days}${q.area ? ` area=${String(q.area)}` : ''}${actor ? ' actor' : ''}${query ? ' query' : ''}: ${page.rows.length} of ${page.total}`);
  return page;
}
