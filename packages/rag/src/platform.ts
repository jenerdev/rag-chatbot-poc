// platform.ts — what a super user does to tenants (plan/tenant-management.md § 4.3).
//
// Every function takes a PlatformContext: a client on the PLATFORM token
// (app_super, no tenant_id), minted by the web app's requirePlatform(). Under
// RLS that client reads and writes `tenants`, `tenant_applications` and
// `memberships` through the *_super_* policies (sql/schema-roles.sql), each
// of which asks Postgres for the platform_admins row again, and reads NOTHING
// of any tenant's documents, chunks or bookings: there is no tenant claim for
// those policies to match. So a bug here can mismanage a tenant; it cannot
// read one.
//
// The tenant is an explicit argument everywhere (D-027's rule, applied to the
// one place that legitimately works across tenants), and every query names
// it in a filter as well (CLAUDE.md rule 6, wall 1), even though the super
// policy would let the row through without it: the filter is what turns
// "update every tenant" into "update this one".
//
// The RULES stay in Postgres. A bad slug, a theme that is not five colours,
// an unknown timezone, a booking type that cannot change while bookings are
// live, an application that cannot go while bookings are live: each is a
// constraint or a trigger, and this file turns its error into a status and
// passes its message through (fromPostgrest). No second copy of a rule here.

import type { Database, DbClient, Json } from '@rag/db';
import { APPLICATIONS, type ApplicationKey } from './applications.js';

/** What a platform route runs on. No tenant, by design. */
export interface PlatformContext {
  db: DbClient;
  userId: string;
}

/** 400: the request itself is wrong (a constraint, a check, a shape). */
export class PlatformInputError extends Error {
  readonly status = 400;
}
/** 409: the request is well-formed but the data says no (a duplicate slug, a live booking, the last owner). */
export class PlatformConflictError extends Error {
  readonly status = 409;
}
/** 404: no such tenant, application, member or account. */
export class PlatformNotFoundError extends Error {
  readonly status = 404;
}
/** 403: Postgres refused the token (42501), which means the row behind the session is gone or the tenant is not the token's. */
export class PlatformForbiddenError extends Error {
  readonly status = 403;
}

/**
 * The ONE place a PostgREST error becomes a status. The message is Postgres's
 * own, because the rule that refused is Postgres's own (the trigger text
 * names the count, the constraint names the shape).
 *
 *   23505 unique_violation            → 409  (a slug, a membership, an application that exists)
 *   23514 check_violation             → 400, or 409 for the two triggers that
 *                                        refuse a CHANGE rather than a shape
 *                                        ("live booking", "no owner")
 *   22023 invalid_parameter_value     → 400  (an unknown timezone, from `now() at time zone`)
 *   23503 foreign_key_violation       → 404  (a tenant or user that is not there)
 *   42501 insufficient_privilege      → 403
 */
export function fromPostgrest(error: { code?: string; message: string }, what: string): Error {
  switch (error.code) {
    case '23505':
      return new PlatformConflictError(`${what}: already exists.`);
    case '23514':
      return /live booking|no owner/.test(error.message)
        ? new PlatformConflictError(error.message)
        : new PlatformInputError(error.message);
    case '22023':
      return new PlatformInputError(error.message);
    case '23503':
      return new PlatformNotFoundError(`${what}: not found.`);
    case '42501':
      return new PlatformForbiddenError(`${what}: the database refused this token (${error.message}).`);
    default:
      return new Error(`${what}: ${error.message}`);
  }
}

/** The tenants columns a platform read selects. EXPLICIT, never `*` (CLAUDE.md § Conventions). */
const TENANT_COLUMNS = 'id, slug, business_name, assistant_name, logo_url, banner_url, assistant_avatar_url, theme, fallback_messages, suggested_questions, archived_at, created_at';

/** One row of the platform's tenant list. */
export interface TenantSummary {
  id: number;
  slug: string;
  businessName: string;
  assistantName: string;
  logoUrl: string | null;
  bannerUrl: string | null;
  /** the assistant's picture (D-124): beside its replies; null = its initial, or the logo */
  assistantAvatarUrl: string | null;
  theme: Json;
  fallbackMessages: Json | null;
  /** D-089: the questions a new chat offers as buttons, or null. */
  suggestedQuestions: Json | null;
  /** ISO timestamp, or null while live. An archived tenant is a 404 everywhere but here. */
  archivedAt: string | null;
  createdAt: string;
  /** The application keys switched on. */
  applications: ApplicationKey[];
  /** How many memberships, any role. */
  members: number;
}

/** One tenant in full: the summary plus each application's config. */
export interface TenantDetail extends TenantSummary {
  applicationConfigs: Partial<Record<ApplicationKey, Json>>;
}

type TenantRow = {
  id: number;
  slug: string;
  business_name: string;
  assistant_name: string;
  logo_url: string | null;
  banner_url: string | null;
  assistant_avatar_url: string | null;
  theme: Json;
  fallback_messages: Json | null;
  suggested_questions: Json | null;
  archived_at: string | null;
  created_at: string;
};

const isApplicationKey = (key: string): key is ApplicationKey => Object.hasOwn(APPLICATIONS, key);

function summary(row: TenantRow, applications: ApplicationKey[], members: number): TenantSummary {
  return {
    id: row.id,
    slug: row.slug,
    businessName: row.business_name,
    assistantName: row.assistant_name,
    logoUrl: row.logo_url,
    bannerUrl: row.banner_url,
    assistantAvatarUrl: row.assistant_avatar_url,
    theme: row.theme,
    fallbackMessages: row.fallback_messages,
    suggestedQuestions: row.suggested_questions,
    archivedAt: row.archived_at,
    createdAt: row.created_at,
    applications,
    members,
  };
}

/** Every tenant, archived included, oldest first, with its applications and member count. */
export async function listTenants(platform: PlatformContext): Promise<TenantSummary[]> {
  const [tenants, apps, members] = await Promise.all([
    platform.db.from('tenants').select(TENANT_COLUMNS).order('created_at'),
    platform.db.from('tenant_applications').select('tenant_id, application_key'),
    platform.db.from('memberships').select('tenant_id'),
  ]);
  if (tenants.error) throw fromPostgrest(tenants.error, 'Could not list tenants');
  if (apps.error) throw fromPostgrest(apps.error, 'Could not list applications');
  if (members.error) throw fromPostgrest(members.error, 'Could not count members');

  const appsOf = new Map<number, ApplicationKey[]>();
  for (const a of apps.data) {
    if (!isApplicationKey(a.application_key)) continue; // a key the registry does not know is not offered (D-033)
    appsOf.set(a.tenant_id, [...(appsOf.get(a.tenant_id) ?? []), a.application_key]);
  }
  const membersOf = new Map<number, number>();
  for (const m of members.data) membersOf.set(m.tenant_id, (membersOf.get(m.tenant_id) ?? 0) + 1);

  return tenants.data.map((row) => summary(row, appsOf.get(row.id) ?? [], membersOf.get(row.id) ?? 0));
}

/** One tenant with each application's config, or a 404. By id, not slug: an archived tenant still has to be reachable to unarchive. */
export async function getTenant(platform: PlatformContext, tenantId: number): Promise<TenantDetail> {
  const [tenant, apps, members] = await Promise.all([
    platform.db.from('tenants').select(TENANT_COLUMNS).eq('id', tenantId).maybeSingle(),
    platform.db.from('tenant_applications').select('application_key, config').eq('tenant_id', tenantId),
    platform.db.from('memberships').select('user_id', { count: 'exact', head: true }).eq('tenant_id', tenantId),
  ]);
  if (tenant.error) throw fromPostgrest(tenant.error, 'Could not load the tenant');
  if (!tenant.data) throw new PlatformNotFoundError(`No tenant ${tenantId}.`);
  if (apps.error) throw fromPostgrest(apps.error, 'Could not load the applications');
  if (members.error) throw fromPostgrest(members.error, 'Could not count members');

  const keys: ApplicationKey[] = [];
  const configs: Partial<Record<ApplicationKey, Json>> = {};
  for (const a of apps.data) {
    if (!isApplicationKey(a.application_key)) continue;
    keys.push(a.application_key);
    configs[a.application_key] = a.config;
  }
  return { ...summary(tenant.data, keys, members.count ?? 0), applicationConfigs: configs };
}

/** The fields a tenant is born with. The slug's shape and reserved words are Postgres's to refuse. */
export interface NewTenant {
  slug: string;
  businessName: string;
  assistantName: string;
}

export async function createTenant(platform: PlatformContext, input: NewTenant): Promise<TenantDetail> {
  const { data, error } = await platform.db
    .from('tenants')
    .insert({ slug: input.slug, business_name: input.businessName, assistant_name: input.assistantName })
    .select('id')
    .single();
  if (error) throw fromPostgrest(error, `A workspace with the slug "${input.slug}"`);
  console.log(`[platform] ${platform.userId} created tenant ${data.id} "${input.slug}"`);
  return getTenant(platform, data.id);
}

/** What the form may change after birth. The slug is not here (plan § 2.6): it is in URLs, cookies and Storage paths. */
export interface TenantPatch {
  businessName?: string;
  assistantName?: string;
  logoUrl?: string | null;
  bannerUrl?: string | null;
  assistantAvatarUrl?: string | null;
  theme?: Json;
  fallbackMessages?: Json | null;
  suggestedQuestions?: Json | null;
}

export async function updateTenant(platform: PlatformContext, tenantId: number, patch: TenantPatch): Promise<TenantDetail> {
  // The table's own Update type, so a typo'd column is a compile error, not a PostgREST 400.
  const row: Database['public']['Tables']['tenants']['Update'] = {};
  if (patch.businessName !== undefined) row.business_name = patch.businessName;
  if (patch.assistantName !== undefined) row.assistant_name = patch.assistantName;
  if (patch.logoUrl !== undefined) row.logo_url = patch.logoUrl;
  if (patch.bannerUrl !== undefined) row.banner_url = patch.bannerUrl;
  if (patch.assistantAvatarUrl !== undefined) row.assistant_avatar_url = patch.assistantAvatarUrl;
  if (patch.theme !== undefined) row.theme = patch.theme;
  if (patch.fallbackMessages !== undefined) row.fallback_messages = patch.fallbackMessages;
  if (patch.suggestedQuestions !== undefined) row.suggested_questions = patch.suggestedQuestions;
  if (Object.keys(row).length === 0) throw new PlatformInputError('Nothing to change.');

  const { data, error } = await platform.db.from('tenants').update(row).eq('id', tenantId).select('id');
  if (error) throw fromPostgrest(error, 'Could not update the tenant');
  if (data.length === 0) throw new PlatformNotFoundError(`No tenant ${tenantId}.`);
  console.log(`[platform] ${platform.userId} updated tenant ${tenantId}: ${Object.keys(row).join(', ')}`);
  return getTenant(platform, tenantId);
}

/**
 * Archive (a 404 everywhere: tenant_public() stops returning the row) or
 * unarchive. Reversible, and the data stays. Hard delete is the CLI's
 * (tenant:remove), on purpose (plan § 2.3).
 */
export async function archiveTenant(platform: PlatformContext, tenantId: number, archived: boolean): Promise<TenantDetail> {
  const { data, error } = await platform.db
    .from('tenants')
    .update({ archived_at: archived ? new Date().toISOString() : null })
    .eq('id', tenantId)
    .select('id');
  if (error) throw fromPostgrest(error, 'Could not archive the tenant');
  if (data.length === 0) throw new PlatformNotFoundError(`No tenant ${tenantId}.`);
  console.log(`[platform] ${platform.userId} ${archived ? 'archived' : 'unarchived'} tenant ${tenantId}`);
  return getTenant(platform, tenantId);
}

/**
 * Switch an application on with a config, or replace the config of one that
 * is on. The triggers decide what a config may say (timezone, booking_type,
 * weekend_days, currency, max_stay_nights, max_advance_days, booking_page)
 * and whether the booking type may change now; their messages come back.
 */
export async function setApplication(platform: PlatformContext, tenantId: number, key: ApplicationKey, config: Json): Promise<TenantDetail> {
  const { error } = await platform.db
    .from('tenant_applications')
    .upsert({ tenant_id: tenantId, application_key: key, config }, { onConflict: 'tenant_id,application_key' });
  if (error) throw fromPostgrest(error, `Could not set the ${key} application`);
  console.log(`[platform] ${platform.userId} set ${key} on tenant ${tenantId}`);
  return getTenant(platform, tenantId);
}

/** Switch an application off. Refused (409) while a booking has not ended; the units, slots and bookings stay for when it comes back (plan § 8 q7). */
export async function removeApplication(platform: PlatformContext, tenantId: number, key: ApplicationKey): Promise<TenantDetail> {
  const { data, error } = await platform.db
    .from('tenant_applications')
    .delete()
    .eq('tenant_id', tenantId)
    .eq('application_key', key)
    .select('application_key');
  if (error) throw fromPostgrest(error, `Could not switch off ${key}`);
  if (data.length === 0) throw new PlatformNotFoundError(`Tenant ${tenantId} does not have the ${key} application.`);
  console.log(`[platform] ${platform.userId} switched ${key} off for tenant ${tenantId}`);
  return getTenant(platform, tenantId);
}
