// tenant.mjs — create a tenant.
//
//   pnpm --filter @rag/db tenant:add -- <slug> "<business name>" "<assistant name>"
//
// A new tenant has no members, so nobody can administer it yet. Add the first
// one with `pnpm --filter @rag/db member:add -- <slug> <email>`. Until auth-rls
// Phase 6 this also printed a shared admin key; staff accounts replaced it
// (D-040), and the key, its hash column and `tenant:key` are gone.
//
// Carries --conditions=react-server like every script that touches @rag/db
// (CLAUDE.md rule 4). The flag is in package.json.

import { supabase } from '../dist/service.js';

const [command, slug, businessName, assistantName] = process.argv.slice(2).filter((a) => a !== '--');

const fail = (message) => {
  console.error(`tenant.mjs: ${message}`);
  process.exitCode = 1;
};

if (command !== 'add') {
  fail('the command is "add" (tenant:key was removed in auth-rls Phase 6; use member:add)');
} else if (!slug || !businessName || !assistantName) {
  fail('usage: tenant:add -- <slug> "<business name>" "<assistant name>"');
} else {
  // The slug's shape and reserved words are checked by the database (the
  // tenants_slug_shape / tenants_slug_reserved constraints), so a bad slug
  // fails here with Postgres's own reason, not a second copy of the rules.
  const { data, error } = await supabase
    .from('tenants')
    .insert({ slug, business_name: businessName, assistant_name: assistantName })
    .select('id, slug')
    .single();
  if (error) {
    fail(`could not create "${slug}": ${error.message}`);
  } else {
    console.log(`Created tenant "${data.slug}" (id ${data.id}).`);
    console.log(`Nobody can administer it yet. Add the first member with:`);
    console.log(`  pnpm --filter @rag/db member:add -- ${data.slug} <email>`);
  }
}
