// applications.ts — the registry of applications a tenant can have (D-033).
//
// An application is CODE: its tables, its package, and (from Phase 6 of
// plan/bookings.md) the tools it offers the chatbot and the executor that runs
// them. A database row cannot create one. `tenant_applications` only switches
// one on for a tenant, and having a row means "on". There is no `enabled`
// column.
//
// The keys here and the `check (application_key in (...))` in
// schema-bookings.sql list the same names. Adding an application means one
// entry here, one value in that check, and one package.

import { supabase } from '@rag/db';
import type { TenantContext } from './types.js';

export const APPLICATIONS = {
  bookings: {
    label: 'Bookings',
  },
} as const;

export type ApplicationKey = keyof typeof APPLICATIONS;

function isApplicationKey(key: string): key is ApplicationKey {
  return Object.hasOwn(APPLICATIONS, key);
}

/**
 * The applications this tenant has switched on.
 *
 * A key the database holds but this registry does not know is dropped. The
 * `check` constraint makes that impossible today, but code that does not know
 * an application must never offer it, whatever the database says.
 */
export async function enabledApplications(tenant: TenantContext): Promise<ApplicationKey[]> {
  const { data, error } = await supabase
    .from('tenant_applications')
    .select('application_key')
    .eq('tenant_id', tenant.id);
  if (error) throw new Error(`Could not load applications: ${error.message}`);
  return data.map((row) => row.application_key).filter(isApplicationKey);
}
