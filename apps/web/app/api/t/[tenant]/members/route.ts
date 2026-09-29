import { NextResponse } from 'next/server';
import { addMember, listMembers, removeMember, setMemberRole } from '@rag/pipeline';
import { requireAdmin } from '@/lib/admin-auth';
import { badRequest } from '@/lib/route';
import { addMemberSchema, firstError, memberRoleSchema, removeMemberSchema } from '@/lib/schemas';
import { withTenantRoute } from '@/lib/tenant';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * A tenant's members, for its OWNERS (plan/tenant-management.md § 4.3):
 * list with emails, add an existing account, change a role, remove.
 * `members:manage` is the owner's alone (lib/permissions.ts), and behind the
 * route the memberships_owner_* policies ask app_role() = 'owner' again.
 * The last owner cannot leave or step down: memberships_keep_an_owner says
 * so, as a 409. Inviting a NEW account stays the CLI's (plan § 8 q3); the
 * 404 for an unknown email carries that command.
 */
export const GET = withTenantRoute(async (request, { tenant }) => {
  tenant = await requireAdmin(request, tenant, 'members:manage');
  return NextResponse.json(await listMembers(tenant.db, tenant.id));
});

export const POST = withTenantRoute(async (request, { tenant }) => {
  tenant = await requireAdmin(request, tenant, 'members:manage');
  const parsed = addMemberSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return badRequest(firstError(parsed.error));
  return NextResponse.json(await addMember(tenant.db, tenant.id, tenant.slug, parsed.data.email, parsed.data.role), { status: 201 });
});

export const PATCH = withTenantRoute(async (request, { tenant }) => {
  tenant = await requireAdmin(request, tenant, 'members:manage');
  const parsed = memberRoleSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return badRequest(firstError(parsed.error));
  return NextResponse.json(await setMemberRole(tenant.db, tenant.id, parsed.data.userId, parsed.data.role));
});

export const DELETE = withTenantRoute(async (request, { tenant }) => {
  tenant = await requireAdmin(request, tenant, 'members:manage');
  const parsed = removeMemberSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return badRequest(firstError(parsed.error));
  return NextResponse.json(await removeMember(tenant.db, tenant.id, parsed.data.userId));
});
