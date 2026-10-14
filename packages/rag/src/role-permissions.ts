// role-permissions.ts — a tenant's role permissions, where they differ from
// the default (D-128, sql/schema-role-permissions.sql).
//
// What the rows MEAN is apps/web/lib/permissions.ts (can(), with the same
// rules as SQL's app_can()); this file only reads and writes them.
//
// Read on the tenant's own token: any token of the tenant reads its rows
// (role_permissions_read), so requireAdmin() and the pages can both ask.
// Written by a super user only, through set_role_permissions(), which
// replaces the tenant's rows in one statement.

import type { PlatformContext, TenantDetail } from './platform.js';
import { fromPostgrest, getTenant } from './platform.js';
import type { TenantContext } from './types.js';

export interface RolePermissionRow {
  role: string;
  permission: string;
  allowed: boolean;
}

/** This tenant's rows. Filtered on the tenant too (CLAUDE.md rule 6, wall 1). */
export async function rolePermissionRows(tenant: TenantContext): Promise<RolePermissionRow[]> {
  const { data, error } = await tenant.db.from('role_permissions').select('role, permission, allowed').eq('tenant_id', tenant.id);
  if (error) throw new Error(`Could not load the role permissions: ${error.message}`);
  return data;
}

/**
 * Replace a tenant's rows (the platform's Permissions tab, one Save). Only
 * the rows that differ from the default need sending; an empty list puts
 * the tenant back on the default. Postgres refuses a fixed permission or an
 * unknown role (role_permissions_configurable, role_permissions_role: 400).
 */
export async function setRolePermissions(platform: PlatformContext, tenantId: number, rows: RolePermissionRow[]): Promise<TenantDetail> {
  // Copied field by field into plain JSON: an interface is not Json to the compiler, and nothing else rides along.
  const json = rows.map((r) => ({ role: r.role, permission: r.permission, allowed: r.allowed }));
  const { error } = await platform.db.rpc('set_role_permissions', { p_tenant_id: tenantId, p_rows: json });
  if (error) throw fromPostgrest(error, 'Could not save the role permissions');
  console.log(`[platform] ${platform.userId} set ${rows.length} role permission row(s) for tenant ${tenantId}`);
  return getTenant(platform, tenantId);
}
