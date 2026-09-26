// member.mjs — who may administer a tenant (auth-rls Phase 5, D-040, D-041).
//
//   pnpm --filter @rag/db member:add      -- <slug> <email>
//   pnpm --filter @rag/db member:remove   -- <slug> <email>
//   pnpm --filter @rag/db member:list     -- <slug>
//   pnpm --filter @rag/db member:operator -- <slug>
//
// One role: a membership row IS admin. There is no invite UI (out of scope);
// this CLI is it, and it runs with service_role because adding the first
// member of a tenant is, by definition, something no member can do yet.
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

const [command, slug, email] = process.argv.slice(2).filter((a) => a !== '--');
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

if (!slug) fail('usage: member:<add|remove|list|operator> -- <slug> [email]');

const { data: tenant, error: tenantError } = await supabase.from('tenants').select('id, slug').eq('slug', slug).maybeSingle();
if (tenantError) fail(tenantError.message);
if (!tenant) fail(`no tenant "${slug}"`);

async function addMembership(userId, label) {
  const { error } = await supabase
    .from('memberships')
    .upsert({ user_id: userId, tenant_id: tenant.id }, { onConflict: 'user_id,tenant_id', ignoreDuplicates: true });
  if (error) fail(`could not add the membership: ${error.message}`);
  console.log(`${label} is a member of "${slug}" (tenant ${tenant.id}).`);
}

if (command === 'add') {
  if (!email) fail('usage: member:add -- <slug> <email>');
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
  await addMembership(userId, email);
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
  if (error) fail(error.message);
  console.log(
    data.length
      ? `${email} is no longer a member of "${slug}". Their next request is refused.`
      : `${email} was not a member of "${slug}".`,
  );
} else if (command === 'list') {
  const { data, error } = await supabase
    .from('memberships')
    .select('user_id, created_at')
    .eq('tenant_id', tenant.id)
    .order('created_at');
  if (error) fail(error.message);
  if (data.length === 0) console.log(`"${slug}" has no members. Add one with member:add.`);
  for (const row of data) {
    const { data: user } = await supabase.auth.admin.getUserById(row.user_id);
    console.log(`${row.created_at.slice(0, 10)}  ${user?.user?.email ?? `(no account: ${row.user_id})`}`);
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
  await addMembership(userId, address);
} else {
  fail('the command is add, remove, list or operator');
}
