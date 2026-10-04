// dashboard.ts — the tenant's page and the platform's strip, as typed shapes
// over the two SQL functions (plan/dashboard.md, D-098).
//
// Nothing is computed here (plan Rule 1): tenant_dashboard() returns ONE
// jsonb with every card's figures and every chart's buckets, cut in the
// tenant's day; this file names its keys for TypeScript, clamps `days`,
// normalises the bucket dates to YYYY-MM-DD (the function casts them, and
// a database that has not re-run the file sends timestamps), and maps the
// database's refusal to the status the route answers with. The function
// refuses a non-member itself (Rule 2); here the route has already asked
// requireAdmin(…, 'dashboard:read'), so a 42501 is a bug, not a visitor.

import type { PlatformContext } from './platform.js';
import { fromPostgrest } from './platform.js';
import type { TenantContext } from './types.js';

/** `days` as the function clamps it: 7 to 90, 30 by default. */
export const DASHBOARD_DAYS = { min: 7, max: 90, default: 30 } as const;

export interface DayBucket {
  day: string;
  conversations: number;
}
export interface WeekCount {
  weekOf: string;
  stays: number;
}
export interface WeekPercent {
  weekOf: string;
  percent: number;
}
export interface WeekMoney {
  weekOf: string;
  /** centavos */
  confirmed: number;
}

export interface TenantDashboard {
  timezone: string;
  today: string;
  days: number;
  chat: {
    conversations: number;
    visitorMessages: number;
    assistantMessages: number;
    refusals: number;
    /** percent, one decimal */
    refusalRate: number;
    openUnanswered: number;
    perDay: DayBucket[];
  };
  knowledge: {
    documents: number;
    chunks: number;
    newest: { title: string; createdAt: string } | null;
  };
  team: { owners: number; admins: number; staff: number };
  /** null for a tenant without the bookings application */
  bookings: {
    attention: { pendingRequests: number; pendingStaff: number; clashing: number };
    today: { checkIns: number; checkOuts: number; next7: { date: string; unit: string; slot: string; guest: string }[] };
    window: { days: number; confirmed: number; pending: number; cancelled: number; web: number; staff: number };
    stays: { weeks: number; perWeek: WeekCount[] };
    /** null unless per_room with an active unit */
    occupancy: { from: string; to: string; activeUnits: number; roomNights: number; percent: number; perWeek: WeekPercent[] } | null;
    promos: { id: number; name: string; uses: number; maxUses: number | null; discount: number }[];
    /** null for a staff member (plan § 7 q2); centavos */
    money: { confirmed: number; pending: number; discounts: number; perWeek: WeekMoney[] } | null;
  } | null;
}

export interface PlatformPulse {
  tenantId: number;
  slug: string;
  businessName: string;
  archivedAt: string | null;
  members: number;
  documents: number;
  conversations30d: number;
  refusals30d: number;
  openUnanswered: number;
  pendingRequests: number;
  confirmedStays30d: number;
}

/** "2026-09-06T00:00:00+00:00" or "2026-09-06" → "2026-09-06". */
function isoDay(value: unknown): string {
  return typeof value === 'string' ? value.slice(0, 10) : '';
}

function num(value: unknown): number {
  return typeof value === 'number' ? value : Number(value ?? 0) || 0;
}

/** `days` as a positive whole number inside the function's clamp; anything else is the default. */
export function dashboardDays(value: unknown): number {
  const n = typeof value === 'string' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isInteger(n)) return DASHBOARD_DAYS.default;
  return Math.min(Math.max(n, DASHBOARD_DAYS.min), DASHBOARD_DAYS.max);
}

type J = Record<string, unknown>;
const obj = (v: unknown): J => (v && typeof v === 'object' && !Array.isArray(v) ? (v as J) : {});
const arr = (v: unknown): J[] => (Array.isArray(v) ? v.map(obj) : []);

/**
 * The function's jsonb as a TenantDashboard. Exported for the test: the
 * shape is checked against a fixture, not against a live database.
 */
export function parseTenantDashboard(raw: unknown): TenantDashboard {
  const r = obj(raw);
  const chat = obj(r.chat);
  const know = obj(r.knowledge);
  const team = obj(r.team);
  const b = r.bookings === null || r.bookings === undefined ? null : obj(r.bookings);
  const newest = obj(know.newest);
  const occ = b && b.occupancy !== null && b.occupancy !== undefined ? obj(b.occupancy) : null;
  const money = b && b.money !== null && b.money !== undefined ? obj(b.money) : null;
  return {
    timezone: String(r.timezone ?? 'Asia/Manila'),
    today: isoDay(r.today),
    days: num(r.days),
    chat: {
      conversations: num(chat.conversations),
      visitorMessages: num(chat.visitorMessages),
      assistantMessages: num(chat.assistantMessages),
      refusals: num(chat.refusals),
      refusalRate: num(chat.refusalRate),
      openUnanswered: num(chat.openUnanswered),
      perDay: arr(chat.perDay).map((d) => ({ day: isoDay(d.day), conversations: num(d.conversations) })),
    },
    knowledge: {
      documents: num(know.documents),
      chunks: num(know.chunks),
      newest: know.newest ? { title: String(newest.title ?? ''), createdAt: String(newest.createdAt ?? '') } : null,
    },
    team: { owners: num(team.owners), admins: num(team.admins), staff: num(team.staff) },
    bookings: b
      ? {
          attention: { pendingRequests: num(obj(b.attention).pendingRequests), pendingStaff: num(obj(b.attention).pendingStaff), clashing: num(obj(b.attention).clashing) },
          today: {
            checkIns: num(obj(b.today).checkIns),
            checkOuts: num(obj(b.today).checkOuts),
            next7: arr(obj(b.today).next7).map((n) => ({ date: isoDay(n.date), unit: String(n.unit ?? ''), slot: String(n.slot ?? ''), guest: String(n.guest ?? '') })),
          },
          window: {
            days: num(obj(b.window).days),
            confirmed: num(obj(b.window).confirmed),
            pending: num(obj(b.window).pending),
            cancelled: num(obj(b.window).cancelled),
            web: num(obj(b.window).web),
            staff: num(obj(b.window).staff),
          },
          stays: { weeks: num(obj(b.stays).weeks), perWeek: arr(obj(b.stays).perWeek).map((w) => ({ weekOf: isoDay(w.weekOf), stays: num(w.stays) })) },
          occupancy: occ
            ? {
                from: isoDay(occ.from),
                to: isoDay(occ.to),
                activeUnits: num(occ.activeUnits),
                roomNights: num(occ.roomNights),
                percent: num(occ.percent),
                perWeek: arr(occ.perWeek).map((w) => ({ weekOf: isoDay(w.weekOf), percent: num(w.percent) })),
              }
            : null,
          promos: arr(b.promos).map((p) => ({ id: num(p.id), name: String(p.name ?? ''), uses: num(p.uses), maxUses: p.maxUses === null || p.maxUses === undefined ? null : num(p.maxUses), discount: num(p.discount) })),
          money: money
            ? {
                confirmed: num(money.confirmed),
                pending: num(money.pending),
                discounts: num(money.discounts),
                perWeek: arr(money.perWeek).map((w) => ({ weekOf: isoDay(w.weekOf), confirmed: num(w.confirmed) })),
              }
            : null,
        }
      : null,
  };
}

/**
 * The tenant's dashboard, on a STAFF context (requireAdmin's). The
 * function checks membership again and withholds money from a staff role;
 * a chat context gets its 42501, mapped like the platform's (403).
 */
export async function tenantDashboard(tenant: TenantContext, days: unknown = DASHBOARD_DAYS.default): Promise<TenantDashboard> {
  const { data, error } = await tenant.db.rpc('tenant_dashboard', { p_tenant_id: tenant.id, p_days: dashboardDays(days) });
  if (error) throw fromPostgrest(error, 'Could not load the dashboard');
  const parsed = parseTenantDashboard(data);
  console.log(`[dashboard] ${tenant.slug} ${parsed.days}d: ${parsed.chat.conversations} conversations, ${parsed.chat.openUnanswered} open, bookings ${parsed.bookings ? 'yes' : 'no'}, money ${parsed.bookings?.money ? 'yes' : 'no'}`);
  return parsed;
}

/** The platform's strip: one row per tenant, counts only, super users only (the function refuses anyone else). */
export async function platformDashboard(platform: PlatformContext): Promise<PlatformPulse[]> {
  const { data, error } = await platform.db.rpc('platform_dashboard');
  if (error) throw fromPostgrest(error, 'Could not load the platform dashboard');
  return (data ?? []).map((r) => ({
    tenantId: r.tenant_id,
    slug: r.slug,
    businessName: r.business_name,
    archivedAt: r.archived_at,
    members: r.members,
    documents: r.documents,
    conversations30d: r.conversations_30d,
    refusals30d: r.refusals_30d,
    openUnanswered: r.open_unanswered,
    pendingRequests: r.pending_requests,
    confirmedStays30d: r.confirmed_stays_30d,
  }));
}
