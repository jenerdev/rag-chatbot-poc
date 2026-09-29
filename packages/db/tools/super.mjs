// super.mjs — who runs the platform (tenant management Phase 2, plan § 4.1).
//
//   pnpm --filter @rag/db super:add    -- <email>
//   pnpm --filter @rag/db super:remove -- <email>
//   pnpm --filter @rag/db super:list
//
// A super user is a `platform_admins` row, not a membership: it has no tenant
// (plan § 2.1). It logs in at /platform and manages tenants, applications and
// any tenant's members; it does NOT see a tenant's documents or bookings
// unless it makes itself an owner there (plan § 8 q5).
//
// THE BOOTSTRAP. The first super user is, by definition, something no super
// user can create, so this runs with service_role (allowed under tools/,
// CLAUDE.md rule 2). super:add for an email with no account sends Supabase's
// invite; its link lands on /platform/reset (Phase 5), where the new super
// user sets a password. That page must be in Auth → URL Configuration →
// Redirect URLs, and the built-in sender is capped (R-21). Set APP_URL for
// anything but http://localhost:3000.
//
// Removing a super user takes effect on their NEXT request: requirePlatform()
// re-reads the row every time (plan Rule 4). Prints no password, ever.

import { supabase, userIdByEmail } from '../dist/service.js';

const [command, email] = process.argv.slice(2).filter((a) => a !== '--');
const APP_URL = process.env.APP_URL ?? 'http://localhost:3000';

// Throws rather than process.exit(1): see member.mjs (a libuv assertion on
// Windows buries the real message when exiting with an open socket).
class Usage extends Error {}
const fail = (message) => {
  throw new Usage(message);
};
process.on('uncaughtException', (error) => {
  console.error(`super.mjs: ${error instanceof Usage ? error.message : error.stack}`);
  process.exitCode = 1;
});

if (command === 'add') {
  if (!email) fail('usage: super:add -- <email>');
  let userId = await userIdByEmail(email);
  if (userId) {
    console.log(`${email} already has an account.`);
  } else {
    const { data, error } = await supabase.auth.admin.inviteUserByEmail(email, { redirectTo: `${APP_URL}/platform/reset` });
    if (error) fail(`could not invite ${email}: ${error.message}`);
    userId = data.user.id;
    console.log(`Invited ${email}. Their link sets a password at ${APP_URL}/platform/reset.`);
  }
  const { data, error } = await supabase
    .from('platform_admins')
    .upsert({ user_id: userId }, { onConflict: 'user_id', ignoreDuplicates: true })
    .select('user_id');
  if (error) fail(`could not add the platform admin: ${error.message}`);
  console.log(data.length ? `${email} runs the platform: log in at ${APP_URL}/platform.` : `${email} already ran the platform.`);
} else if (command === 'remove') {
  if (!email) fail('usage: super:remove -- <email>');
  const userId = await userIdByEmail(email);
  if (!userId) fail(`no account for ${email}`);
  const { data, error } = await supabase.from('platform_admins').delete().eq('user_id', userId).select('user_id');
  if (error) fail(error.message);
  console.log(data.length ? `${email} no longer runs the platform. Their next request is refused.` : `${email} did not run the platform.`);
} else if (command === 'list') {
  const { data, error } = await supabase.from('platform_admins').select('user_id, created_at').order('created_at');
  if (error) fail(error.message);
  if (data.length === 0) console.log('Nobody runs the platform yet. Add the first super user with super:add.');
  for (const row of data) {
    const { data: user } = await supabase.auth.admin.getUserById(row.user_id);
    console.log(`${row.created_at.slice(0, 10)}  ${user?.user?.email ?? `(no account: ${row.user_id})`}`);
  }
} else {
  fail('the command is add, remove or list');
}
