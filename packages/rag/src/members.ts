// members.ts — who may administer a tenant, and as what (plan/tenant-management.md § 4.3).
//
// TWO callers, one code path. An OWNER manages its own tenant's members from
// the Members screen, on a staff token (memberships_owner_* policies); the
// PLATFORM manages any tenant's, on the platform token (memberships_super_all).
// Both hand in a client and a tenant id; RLS decides whether that client may
// touch that tenant's rows, and every query names the tenant too (wall 1).
//
// What this CANNOT do: invite a new account. That needs Supabase's admin API,
// which needs the service key, which no request holds (CLAUDE.md rule 2;
// plan § 8 q3). addMember() resolves an EXISTING account through
// user_id_by_email(), a definer function that answers only an owner or the
// platform (R-42), and says how to invite when there is none.
//
// The last owner stays: memberships_keep_an_owner refuses the change that
// would leave a tenant with no owner, and its message comes back as a 409.
// No pre-check here (CLAUDE.md trap 8's shape).

import type { DbClient, MemberRole } from '@rag/db';
import { fromPostgrest, PlatformConflictError, PlatformNotFoundError } from './platform.js';

/** One member as the Members screen shows it. The email comes from auth.users through member_emails(). */
export interface Member {
  userId: string;
  email: string;
  role: MemberRole;
  createdAt: string;
}

/** The members of one tenant, oldest first. Any member of that tenant may read this; the platform may read any tenant's. */
export async function listMembers(db: DbClient, tenantId: number): Promise<Member[]> {
  const { data, error } = await db.rpc('member_emails', { p_tenant_id: tenantId });
  if (error) throw fromPostgrest(error, 'Could not list members');
  return data.map((row) => ({ userId: row.user_id, email: row.email, role: row.role, createdAt: row.created_at }));
}

/**
 * Add an EXISTING account to a tenant with a role. 404 when the email has no
 * account (with the CLI command that invites one), 409 when already a member.
 */
export async function addMember(
  db: DbClient,
  tenantId: number,
  slug: string,
  who: { email?: string; userId?: string },
  role: MemberRole,
): Promise<Member[]> {
  let userId = who.userId ?? null;
  if (!userId) {
    // By email: the definer lookup, owner or platform only (R-42).
    const lookup = await db.rpc('user_id_by_email', { p_email: who.email ?? '' });
    if (lookup.error) throw fromPostgrest(lookup.error, 'Could not look the account up');
    if (!lookup.data) {
      throw new PlatformNotFoundError(
        `No account for ${who.email}. Invite one from the command line: pnpm --filter @rag/db member:add -- ${slug} ${who.email} ${role}`,
      );
    }
    userId = lookup.data;
  }
  // By id: the platform adding ITSELF (plan § 8 q5), the one id a browser
  // legitimately knows. A wrong id is a 23503 from the FK, so a 404.
  const { error } = await db.from('memberships').insert({ user_id: userId, tenant_id: tenantId, role });
  if (error?.code === '23505') throw new PlatformConflictError(`${who.email ?? 'That account'} is already a member. Change the role instead.`);
  if (error) throw fromPostgrest(error, 'Could not add the member');
  console.log(`[members] tenant ${tenantId}: added ${userId} as ${role}`);
  return listMembers(db, tenantId);
}

/** Change a member's role. 404 when the user is not a member; 409 when they are the last owner. Effective on their next request (plan Rule 4). */
export async function setMemberRole(db: DbClient, tenantId: number, userId: string, role: MemberRole): Promise<Member[]> {
  const { data, error } = await db.from('memberships').update({ role }).eq('tenant_id', tenantId).eq('user_id', userId).select('role');
  if (error) throw fromPostgrest(error, 'Could not change the role');
  if (data.length === 0) throw new PlatformNotFoundError('That account is not a member here.');
  console.log(`[members] tenant ${tenantId}: ${userId} is now ${role}`);
  return listMembers(db, tenantId);
}

/** Remove a member. 404 when not a member; 409 when they are the last owner. Their next request is refused. */
export async function removeMember(db: DbClient, tenantId: number, userId: string): Promise<Member[]> {
  const { data, error } = await db.from('memberships').delete().eq('tenant_id', tenantId).eq('user_id', userId).select('user_id');
  if (error) throw fromPostgrest(error, 'Could not remove the member');
  if (data.length === 0) throw new PlatformNotFoundError('That account is not a member here.');
  console.log(`[members] tenant ${tenantId}: removed ${userId}`);
  return listMembers(db, tenantId);
}
