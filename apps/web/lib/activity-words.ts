// activity-words.ts — the words of S-18 Activity and the platform's Activity
// tab (plan/audit-log.md, D-138). Pure, browser-safe, tested.
//
// A row of audit_log says WHAT happened in data (area, action, subject,
// label, the changed columns, before and after of a short allowlist); this
// file says it in a sentence: "deleted the document House rules", "changed
// Garden Room: weekend rate ₱12,000.00 → ₱15,000.00", "made maria@… an
// admin (was staff)". A booking_events row (the stay's log, read as a second
// source) gets a short line and a link to the stay, never its note.
//
// Who is a separate word: the member's email (a current member), "a former
// member", "Platform" (a super user, unnamed on a tenant's screen), "System"
// (a tool, the retention sweep, a trigger).

import { formatMoney } from './money';
import { PERMISSION_LABELS, ROLE_LABELS, isRole, type Permission } from './permissions';
import { FEATURES } from './features';

/** The shape activityWords() reads: @rag/pipeline's ActivityRow, as the route returns it. */
export interface ActivityLine {
  source: 'audit' | 'bookings';
  actorKind: string;
  actorUser: string | null;
  actorEmail: string | null;
  area: string;
  action: string;
  subject: string | null;
  label: string | null;
  changed: string[] | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
}

/** The windows the screen offers; the SQL function says 30 for anything else. */
export const ACTIVITY_WINDOWS = [7, 30, 90, 365] as const;
export type ActivityWindow = (typeof ACTIVITY_WINDOWS)[number];

/** What the area filter calls each area. */
export const AREA_LABELS: Readonly<Record<string, string>> = {
  bookings: 'Bookings',
  documents: 'Knowledge base',
  rooms: 'Rooms',
  rates: 'Rates',
  photos: 'Photos',
  holidays: 'Holidays',
  slots: 'Slots',
  promos: 'Promos',
  members: 'Members',
  permissions: 'Permissions',
  features: 'Features',
  applications: 'Applications',
  tenant: 'Workspace',
  unanswered: 'Unanswered',
  stay_notes: 'Staff notes',
  session: 'Sign-ins',
  proof: 'Proofs',
  platform: 'Platform',
};

export interface ActivityFilters {
  days: ActivityWindow;
  area: string;
  actor: string;
  q: string;
}

type Params = Record<string, string | string[] | undefined>;
const first = (v: string | string[] | undefined): string => (Array.isArray(v) ? (v[0] ?? '') : (v ?? ''));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The filters from a page's searchParams; anything odd is the default. */
export function parseActivityFilters(params: Params): ActivityFilters {
  const days = Number(first(params.days));
  const area = first(params.area);
  const actor = first(params.actor);
  return {
    days: (ACTIVITY_WINDOWS as readonly number[]).includes(days) ? (days as ActivityWindow) : 30,
    area: area in AREA_LABELS ? area : '',
    actor: UUID.test(actor) ? actor : '',
    q: first(params.q).slice(0, 200),
  };
}

/** The filters as a query string, defaults left out: '' or '?days=7&area=members'. */
export function activityQuery(f: ActivityFilters): string {
  const p = new URLSearchParams();
  if (f.days !== 30) p.set('days', String(f.days));
  if (f.area) p.set('area', f.area);
  if (f.actor) p.set('actor', f.actor);
  if (f.q.trim() !== '') p.set('q', f.q.trim());
  const s = p.toString();
  return s ? `?${s}` : '';
}

/** Who did it, as the screen says it. On the platform's own list a super user is "Super user". */
export function actorWords(row: Pick<ActivityLine, 'actorKind' | 'actorUser' | 'actorEmail'>, platformView = false): string {
  if (row.actorKind === 'super') return platformView ? 'Super user' : 'Platform';
  if (row.actorKind === 'system') return 'System';
  if (row.actorKind === 'guest') return 'The guest';
  if (row.actorEmail) return row.actorEmail;
  return row.actorUser ? 'A former member' : 'System';
}

const quote = (s: string | null | undefined): string => (s ? `“${s}”` : '');
const str = (v: unknown): string | null => (typeof v === 'string' ? v : v === null || v === undefined ? null : String(v));

/** A column's value as a person reads it: money for the price columns, on/off, a date, the text. */
function valueWords(column: string, value: unknown, currency: string): string {
  if (value === null || value === undefined) return 'none';
  if (/_price$|^value$|^surcharge$|^extra_person_rate$/.test(column) && typeof value === 'number') return formatMoney(value, currency);
  if (typeof value === 'boolean') return value ? 'on' : 'off';
  if (typeof value === 'object') return JSON.stringify(value).slice(0, 60);
  return String(value);
}

const COLUMN_WORDS: Readonly<Record<string, string>> = {
  weekday_price: 'weekday rate',
  weekend_price: 'weekend rate',
  holiday_price: 'holiday rate',
  extra_person_rate: 'extra-guest fee',
  standard_capacity: 'standard capacity',
  capacity: 'maximum guests',
  sort_order: 'order',
  start_time: 'start time',
  duration: 'length',
  nightly: 'overnight',
  active: 'active',
  valid_from: 'valid from',
  valid_to: 'valid to',
  max_uses: 'usage limit',
  business_name: 'business name',
  assistant_name: 'assistant name',
  logo_url: 'logo',
  banner_url: 'banner',
  assistant_avatar_url: 'assistant avatar',
  archived_at: 'archived',
  dpa_signed_on: 'DPA signed on',
  privacy_contact_name: 'privacy contact',
  privacy_contact_email: 'privacy contact email',
  policy_version: 'policy version',
  chat_retention_days: 'chat retention (days)',
  guest_retention_days: 'guest retention (days)',
  audit_retention_days: 'activity retention (days)',
  fallback_messages: 'fallback messages',
  suggested_questions: 'suggested questions',
  config: 'settings',
};

/** "weekend rate ₱12,000.00 → ₱15,000.00, active on → off"; a column outside the allowlist by name alone. */
export function changeWords(row: Pick<ActivityLine, 'changed' | 'before' | 'after'>, currency = 'PHP'): string {
  const changed = row.changed ?? [];
  return changed
    .map((c) => {
      const name = COLUMN_WORDS[c] ?? c.replaceAll('_', ' ');
      const had = row.before && c in row.before;
      const has = row.after && c in row.after;
      if (!had && !has) return name;
      if (c === 'archived_at') return row.after?.archived_at ? 'archived' : 'unarchived';
      return `${name} ${valueWords(c, row.before?.[c], currency)} → ${valueWords(c, row.after?.[c], currency)}`;
    })
    .join(', ');
}

const featureLabel = (key: string | null): string => FEATURES.find((f) => f.key === key)?.label ?? key ?? 'a feature';
const permissionLabel = (p: string | null): string => (p && p in PERMISSION_LABELS ? PERMISSION_LABELS[p as Permission].label : (p ?? 'a permission'));
const roleLabel = (r: unknown): string => (isRole(r) ? ROLE_LABELS[r].toLowerCase() : String(r ?? '?'));

/**
 * What happened, in a sentence without the actor: "deleted the document
 * “House rules”". The screen puts the actor before it and the time after.
 */
export function activityWords(row: ActivityLine, currency = 'PHP'): string {
  const label = quote(row.label);
  if (row.source === 'bookings') return bookingWords(row);
  switch (row.area) {
    case 'session':
      return row.action === 'login' ? 'signed in' : 'signed out';
    case 'proof':
      return `opened the proof of payment #${row.subject ?? '?'}`;
    case 'documents':
      return row.action === 'insert' ? `added the document ${label}` : `deleted the document ${label}`;
    case 'rooms':
      return row.action === 'insert' ? `added the room ${label}` : row.action === 'delete' ? `deleted the room ${label}` : `changed ${label}: ${changeWords(row, currency)}`;
    case 'rates':
      return row.action === 'insert' ? `set the rates for ${label}` : row.action === 'delete' ? `removed the rates for ${label}` : `changed the rates for ${label}: ${changeWords(row, currency)}`;
    case 'photos':
      return row.action === 'insert' ? `added a photo to ${label}` : row.action === 'delete' ? `removed a photo from ${label}` : `reordered the photos of ${label}`;
    case 'holidays': {
      const kind = str(row.after?.kind ?? row.before?.kind);
      const what = kind === 'closed' ? 'closed date' : 'holiday';
      const named = row.label && row.label !== row.subject ? ` ${label}` : '';
      return row.action === 'insert' ? `set ${row.subject ?? '?'} as a ${what}${named}` : row.action === 'delete' ? `removed the ${what}${named} on ${row.subject ?? '?'}` : `changed the ${what}${named} on ${row.subject ?? '?'}: ${changeWords(row, currency)}`;
    }
    case 'slots':
      if (row.action === 'update' && row.changed?.includes('active') && row.after?.active === false) return `retired the slot ${label}`;
      return row.action === 'insert' ? `added the slot ${label}` : row.action === 'delete' ? `deleted the slot ${label}` : `changed the slot ${label}: ${changeWords(row, currency)}`;
    case 'promos':
      if (row.action === 'update' && row.changed?.includes('active') && row.after?.active === false) return `retired the promo ${label}`;
      return row.action === 'insert' ? `added the promo ${label}` : row.action === 'delete' ? `deleted the promo ${label}` : `changed the promo ${label}: ${changeWords(row, currency)}`;
    case 'members': {
      const role = roleLabel(row.after?.role);
      if (row.action === 'insert') return `added a member as ${role}`;
      if (row.action === 'delete') return 'removed a member';
      return `made a member ${role} (was ${roleLabel(row.before?.role)})`;
    }
    case 'permissions': {
      const role = roleLabel(row.after?.role ?? row.before?.role);
      const perm = permissionLabel(str(row.after?.permission ?? row.before?.permission));
      if (row.action === 'delete') return `restored the default for ${role}: ${perm}`;
      return row.after?.allowed === true ? `let ${role} ${perm.charAt(0).toLowerCase()}${perm.slice(1)}` : `stopped ${role} from: ${perm}`;
    }
    case 'features': {
      const name = featureLabel(row.subject);
      if (row.action === 'delete') return `set ${name} back to its default`;
      return `switched ${name} ${row.after?.enabled === false ? 'off' : 'on'}`;
    }
    case 'applications': {
      const changed = row.changed ?? [];
      const config = row.after?.config;
      const paymentsTouched = row.action === 'update' && changed.includes('config') && config && typeof config === 'object' && 'payments' in (config as object);
      if (row.action === 'insert') return `switched on ${row.subject ?? 'an application'}`;
      if (row.action === 'delete') return `switched off ${row.subject ?? 'an application'}`;
      return paymentsTouched ? 'changed the payment settings or bookings settings' : 'changed the bookings settings';
    }
    case 'tenant':
      if (row.action === 'insert') return `created the workspace ${label}`;
      if (row.changed?.length === 1 && row.changed[0] === 'archived_at') return row.after?.archived_at ? 'archived the workspace' : 'unarchived the workspace';
      return `changed the workspace: ${changeWords(row, currency)}`;
    case 'unanswered':
      return row.action === 'insert' ? 'marked an unanswered question resolved' : 'reopened an unanswered question';
    case 'stay_notes':
      return row.action === 'insert' ? 'added a staff note to a stay' : 'deleted a staff note';
    case 'platform':
      if (row.action === 'tenant_removed') return `removed the workspace ${label} and everything in it`;
      return row.action === 'insert' ? 'added a super user' : 'removed a super user';
    default:
      return `${row.action} ${row.area}${label ? ` ${label}` : ''}`;
  }
}

/** A stay's event in a line, from booking_events' kind and statuses alone (never its note). */
function bookingWords(row: ActivityLine): string {
  const ref = row.label ? `booking ${row.label}` : 'a booking';
  const to = str(row.after?.status);
  const from = str(row.before?.status);
  switch (row.action) {
    case 'created':
      return `${row.actorKind === 'guest' ? 'requested' : 'booked'} ${ref}${to === 'confirmed' ? ', confirmed' : ''}`;
    case 'status':
      if (to === 'confirmed') return `confirmed ${ref}`;
      if (to === 'cancelled') return `${from === 'pending' ? 'declined' : 'cancelled'} ${ref}`;
      if (to === 'expired') return `${ref} expired`;
      return `changed ${ref} to ${to ?? '?'}`;
    case 'room':
      return `moved ${ref} to another room`;
    case 'change': {
      const [kind, status] = (to ?? '').split(':');
      return status === 'pending' ? `asked to ${kind === 'cancel' ? 'cancel' : 'move'} ${ref}` : `${status ?? 'decided'} the request to ${kind === 'cancel' ? 'cancel' : 'move'} ${ref}`;
    }
    case 'payment': {
      const [kind, status] = (to ?? '').split(':');
      if (kind === 'refund') return `recorded a refund on ${ref}`;
      if (status === 'submitted') return `sent a proof of payment for ${ref}`;
      if (status === 'verified') return `verified a payment on ${ref}`;
      if (status === 'rejected') return `rejected a proof on ${ref}`;
      return `payment on ${ref}: ${to ?? '?'}`;
    }
    default:
      return `${row.action} on ${ref}`;
  }
}

/** Where the subject lives, or null: a document on S-2, a room on S-5, a member on S-8, a stay on S-15. */
export function activityHref(slug: string, row: Pick<ActivityLine, 'source' | 'area' | 'label' | 'subject' | 'action'>): string | null {
  const base = `/t/${slug}/admin`;
  if (row.source === 'bookings') return row.label ? `${base}/bookings/${encodeURIComponent(row.label)}` : null;
  if (row.action === 'delete') return null;
  switch (row.area) {
    case 'documents':
      return `${base}/documents`;
    case 'rooms':
    case 'rates':
    case 'photos':
      return `${base}/accommodations`;
    case 'holidays':
      return `${base}/holidays`;
    case 'slots':
      return `${base}/slots`;
    case 'promos':
      return `${base}/promos`;
    case 'members':
      return `${base}/members`;
    case 'unanswered':
      return `${base}/unanswered`;
    default:
      return null;
  }
}
