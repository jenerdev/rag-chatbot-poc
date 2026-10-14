import { NextResponse } from 'next/server';
import { setRolePermissions } from '@rag/pipeline';
import { withPlatformRoute } from '@/lib/platform-auth';
import { badRequest, parseId } from '@/lib/route';
import { firstError, rolePermissionsSchema } from '@/lib/schemas';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Replace a tenant's role permissions (D-128): `{ rows: [{ role, permission,
 * allowed }] }`, the rows that differ from lib/permissions.ts's default;
 * `[]` puts the tenant back on the default. A super user only
 * (withPlatformRoute; set_role_permissions() asks app_is_super() again).
 * The tenant as it now is comes back.
 */
export const PUT = withPlatformRoute<{ id: string }>(async (request, { platform, params }) => {
  const id = parseId(params.id);
  if (id === null) return badRequest('Invalid tenant id');
  const parsed = rolePermissionsSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return badRequest(firstError(parsed.error));
  return NextResponse.json(await setRolePermissions(platform, id, parsed.data.rows));
});
