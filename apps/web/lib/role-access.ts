import 'server-only';
import { cache } from 'react';
import { rolePermissionRows } from '@rag/pipeline';
import type { TenantContext } from '@rag/pipeline';
import { overridesFrom, type RoleOverrides } from './permissions';

/**
 * The tenant's role permission rows (D-128), as overrides for can(), once
 * per request (getTenant() hands every caller the same TenantContext, which
 * is what cache() compares). Read on the tenant's own token; the rows say
 * what a ROLE may do, which is no secret from that tenant's pages.
 */
export const loadRoleOverrides = cache(async (tenant: TenantContext): Promise<RoleOverrides> => overridesFrom(await rolePermissionRows(tenant)));
