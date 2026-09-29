// member.mjs — who may administer a tenant (auth-rls Phase 5, D-040, D-041).
//
//   pnpm --filter @rag/db member:add      -- <slug> <email> [owner|admin|staff]   (default admin)
//   pnpm --filter @rag/db member:role     -- <slug> <email> <owner|admin|staff>
//   pnpm --filter @rag/db member:remove   -- <slug> <email>
//   pnpm --filter @rag/db member:list     -- <slug>
//   pnpm --filter @rag/db member:operator -- <slug>
//
// Three roles since tenant management Phase 1 (plan/tenant-management.md
// § 3.1): owner (everything, plus members), admin (documents, rooms, rates,
// holidays, bookings), staff (bookings and unanswered; documents read-only).
// The database decides what each may do (app_role() in every policy) and
// keeps one owner per tenant (memberships_keep_an_owner); this CLI asks and
// reports Postgres's answer as it is. Owners manage members from the Members
// screen; this runs with service_role because adding the FIRST member of a
// tenant is, by definition, something no member can do yet.
//
// member:add for an email with no account sends Supabase's invite email. Its
// link lands on /t/<slug>/admin/reset, where the new member sets a password.
// That page must be in Auth → URL Configuration → Redirect URLs, and the
// built-in sender is for testing only (plan/auth-rls.md § 2.6). Set APP_URL
// for anything but http://localhost:3000.
//
// member:operator creates the tools' own member (§ 2.7): an account at a
// reserved example.com address, with a random password nobody ever sees.
//
// Removing a member takes effect on their NEXT request, not when their cookie
// runs out: requireAdmin() re-checks the membership every time.
//
// Prints no password and no token, ever.

import { randomBytes } from 'node:crypto';
import { operatorEmail, supabase, userIdByEmail } from '../dist/service.js';

const [command, slug, email, roleArg] = process.argv.slice(2).filter((a) => a !== '--');
const ROLES = ['owner', 'admin', 'staff'];
const APP_URL = process.env.APP_URL ?? 'http://localhost:3000';

// Throws rather than process.exit(1). On Windows, exiting while supabase-js
// still holds a keep-alive socket crashes Node with a libuv assertion
// (`!(handle->flags & UV_HANDLE_CLOSING)`), which buries the real message.
// The handler below prints the message alone and lets Node exit on its own.
class Usage extends Error {}
const fail = (message) => {
  throw new Usage(message);
};
process.on('uncaughtException', (error) => {
  console.error(`member.mjs: ${error instanceof Usage ? error.message : error.stack}`);
  process.exitCode = 1;
});

if (!slug) fail('usage: member:<add|role|remove|list|operator> -- <slug> [email] [role]');

const { data: tenant, error: tenantError } = await supabase.from('tenants').select('id, slug').eq('slug', slug).maybeSingle();
if (tenantError) fail(tenantError.message);
if (!tenant) fail(`no tenant "${slug}"`);

async function addMembership(userId, label, role) {
  // ignoreDuplicates: an existing member keeps its role. member:role changes one.
  const { data, error } = await supabase
    .from('memberships')
    .upsert({ user_id: userId, tenant_id: tenant.id, role }, { onConflict: 'user_id,tenant_id', ignoreDuplicates: true })
    .select('role');
  if (error) fail(`could not add the membership: ${error.message}`);
  if (data.length === 0) console.log(`${label} was already a member of "${slug}"; the role is unchanged. Use member:role to change it.`);
  else console.log(`${label} is a member of "${slug}" (tenant ${tenant.id}) as ${role}.`);
}

if (command === 'add') {
  if (!email) fail('usage: member:add -- <slug> <email> [owner|admin|staff]');
  const role = roleArg ?? 'admin';
  if (!ROLES.includes(role)) fail(`the role is one of ${ROLES.join(', ')}, not "${roleArg}"`);
  let userId = await userIdByEmail(email);
  if (userId) {
    console.log(`${email} already has an account.`);
  } else {
    const { data, error } = await supabase.auth.admin.inviteUserByEmail(email, {
      redirectTo: `${APP_URL}/t/${slug}/admin/reset`,
    });
    if (error) fail(`could not invite ${email}: ${error.message}`);
    userId = data.user.id;
    console.log(`Invited ${email}. Their link sets a password at ${APP_URL}/t/${slug}/admin/reset.`);
  }
  await addMembership(userId, email, role);
} else if (command === 'role') {
  if (!email || !ROLES.includes(roleArg)) fail(`usage: member:role -- <slug> <email> <${ROLES.join('|')}>`);
  const userId = await userIdByEmail(email);
  if (!userId) fail(`no account for ${email}`);
  // The last-owner trigger may refuse this (23514); its message is printed as is.
  const { data, error } = await supabase
    .from('memberships')
    .update({ role: roleArg })
    .eq('tenant_id', tenant.id)
    .eq('user_id', userId)
    .select('role');
  if (error) fail(`refused: ${error.message}`);
  console.log(data.length ? `${email} is now ${roleArg} of "${slug}". Their next request runs as that.` : `${email} is not a member of "${slug}". Add them with member:add.`);
} else if (command === 'remove') {
  if (!email) fail('usage: member:remove -- <slug> <email>');
  const userId = await userIdByEmail(email);
  if (!userId) fail(`no account for ${email}`);
  const { data, error } = await supabase
    .from('memberships')
    .delete()
    .eq('tenant_id', tenant.id)
    .eq('user_id', userId)
    .select('user_id');
  if (error) fail(`refused: ${error.message}`);
  console.log(
    data.length
      ? `${email} is no longer a member of "${slug}". Their next request is refused.`
      : `${email} was not a member of "${slug}".`,
  );
} else if (command === 'list') {
  const { data, error } = await supabase
    .from('memberships')
    .select('user_id, role, created_at')
    .eq('tenant_id', tenant.id)
    .order('created_at');
  if (error) fail(error.message);
  if (data.length === 0) console.log(`"${slug}" has no members. Add one with member:add.`);
  for (const row of data) {
    const { data: user } = await supabase.auth.admin.getUserById(row.user_id);
    console.log(`${row.created_at.slice(0, 10)}  ${row.role.padEnd(5)}  ${user?.user?.email ?? `(no account: ${row.user_id})`}`);
  }
} else if (command === 'operator') {
  const address = operatorEmail(slug);
  let userId = await userIdByEmail(address);
  if (!userId) {
    const { data, error } = await supabase.auth.admin.createUser({
      email: address,
      // Never printed, never stored, never used: the tools mint this member's
      // staff token directly. It exists because Supabase requires one.
      password: randomBytes(32).toString('base64url'),
      email_confirm: true,
    });
    if (error) fail(`could not create ${address}: ${error.message}`);
    userId = data.user.id;
    console.log(`Created the operator account ${address}.`);
  }
  // admin: the operator ingests documents and seeds bookings, which is admin
  // work, and never manages members (plan/tenant-management.md § 8 q8).
  await addMembership(userId, address, 'admin');
} else {
  fail('the command is add, role, remove, list or operator');
}
