import 'server-only';
import { cache } from 'react';
import { enabledApplications } from '@rag/pipeline';
import type { ApplicationKey, TenantContext } from '@rag/pipeline';

/**
 * The tenant's enabled applications, memoised per request with React `cache()`,
 * the same as getTenant(). cache() compares arguments by identity, and
 * getTenant() hands every caller in a request the same TenantContext object,
 * so this costs one query per request.
 */
const applicationsOf = cache(async (tenant: TenantContext) => enabledApplications(tenant));

class ApplicationNotEnabledError extends Error {
  // 404, not 403. "This tenant has no bookings" must look like "no such route",
  // not like a feature that exists and is locked (plan/bookings.md Phase 3).
  readonly status = 404;
}

/** Does this tenant have the application? For pages, which call notFound() rather than throw. */
export async function hasApplication(tenant: TenantContext, key: ApplicationKey): Promise<boolean> {
  return (await applicationsOf(tenant)).includes(key);
}

/**
 * Guard a handler that belongs to an application. Throws a 404 unless the
 * tenant has it switched on.
 *
 * Call it AFTER requireAdmin(). Then only this tenant's own admin ever sees
 * the message, and a stranger gets the 401 whether or not the application
 * exists.
 *
 * @rag/bookings refuses a tenant without the application too
 * (BookingsNotEnabledError, also a 404). This is the same check made once, at
 * the boundary, for every application, and before any of that package's work
 * starts.
 */
export async function requireApplication(tenant: TenantContext, key: ApplicationKey): Promise<void> {
  if (!(await hasApplication(tenant, key))) {
    throw new ApplicationNotEnabledError(`"${tenant.slug}" does not have the ${key} application`);
  }
}
