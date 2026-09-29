import { NextResponse } from 'next/server';
import { addMember, getTenant, listMembers, removeMember, setMemberRole } from '@rag/pipeline';
import { withPlatformRoute } from '@/lib/platform-auth';
import { badRequest, parseId } from '@/lib/route';
import { addMemberSchema, firstError, memberRoleSchema, removeMemberSchema } from '@/lib/schemas';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Any tenant's members, for the platform: the same four verbs as the
 * tenant's own members route, on the platform token (memberships_super_all).
 * This is also how a new tenant gets its first owner, and how the platform
 * makes ITSELF an owner when it needs a tenant's screens (plan § 8 q5). The
 * pipeline functions are shared with the owner route; only the token differs.
 */
async function tenantOf(platform: Parameters<typeof getTenant>[0], raw: string) {
  const id = parseId(raw);
  if (id === null) return null;
  return getTenant(platform, id); // a 404 if it is not there, archived or not
}

export const GET = withPlatformRoute<{ id: string }>(async (_request, { platform, params }) => {
  const tenant = await tenantOf(platform, params.id);
  if (!tenant) return badRequest('Invalid tenant id');
  return NextResponse.json(await listMembers(platform.db, tenant.id));
});

export const POST = withPlatformRoute<{ id: string }>(async (request, { platform, params }) => {
  const tenant = await tenantOf(platform, params.id);
  if (!tenant) return badRequest('Invalid tenant id');
  const parsed = addMemberSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return badRequest(firstError(parsed.error));
  return NextResponse.json(await addMember(platform.db, tenant.id, tenant.slug, parsed.data, parsed.data.role), { status: 201 });
});

export const PATCH = withPlatformRoute<{ id: string }>(async (request, { platform, params }) => {
  const tenant = await tenantOf(platform, params.id);
  if (!tenant) return badRequest('Invalid tenant id');
  const parsed = memberRoleSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return badRequest(firstError(parsed.error));
  return NextResponse.json(await setMemberRole(platform.db, tenant.id, parsed.data.userId, parsed.data.role));
});

export const DELETE = withPlatformRoute<{ id: string }>(async (request, { platform, params }) => {
  const tenant = await tenantOf(platform, params.id);
  if (!tenant) return badRequest('Invalid tenant id');
  const parsed = removeMemberSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return badRequest(firstError(parsed.error));
  return NextResponse.json(await removeMember(platform.db, tenant.id, parsed.data.userId));
});
