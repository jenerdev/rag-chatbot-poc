// tenant.mjs — create a tenant, or issue a new admin key for one.
//
//   pnpm --filter @rag/db tenant:add -- <slug> "<business name>" "<assistant name>"
//   pnpm --filter @rag/db tenant:key -- <slug>
//
// Both print a freshly generated admin key EXACTLY ONCE and store only its
// scrypt hash. There is no "show me the key again": a recover-the-key feature
// is a read-the-key feature. A lost key is replaced with `tenant:key`, which
// invalidates the old one, since the hash is overwritten.
//
// Carries --conditions=react-server like every script that touches @rag/db
// (CLAUDE.md rule 4). The flag is in package.json.

import { generateAdminKey, hashAdminKey, supabase } from '../dist/index.js';

const [command, slug, businessName, assistantName] = process.argv.slice(2).filter((a) => a !== '--');

const fail = (message) => {
  console.error(`tenant.mjs: ${message}`);
  process.exit(1);
};

if (!slug) fail('a slug is required');

const key = generateAdminKey();
const admin_key_hash = await hashAdminKey(key);

if (command === 'add') {
  if (!businessName || !assistantName) fail('usage: tenant:add -- <slug> "<business name>" "<assistant name>"');
  // The slug's shape and reserved words are checked by the database (the
  // tenants_slug_shape / tenants_slug_reserved constraints), so a bad slug
  // fails here with Postgres's own reason, not a second copy of the rules.
  const { data, error } = await supabase
    .from('tenants')
    .insert({ slug, business_name: businessName, assistant_name: assistantName, admin_key_hash })
    .select('id, slug')
    .single();
  if (error) fail(`could not create "${slug}": ${error.message}`);
  console.log(`Created tenant "${data.slug}" (id ${data.id}).`);
} else if (command === 'key') {
  const { data, error } = await supabase
    .from('tenants')
    .update({ admin_key_hash })
    .eq('slug', slug)
    .select('id, slug');
  if (error) fail(`could not set the key for "${slug}": ${error.message}`);
  if (data.length === 0) fail(`no tenant "${slug}"`);
  console.log(`New admin key for "${slug}" (id ${data[0].id}). Any previous key no longer works.`);
} else {
  fail('the command is "add" or "key"');
}

console.log('');
console.log(`  ${key}`);
console.log('');
console.log('This is the only time it is shown. Store it now. Only its hash is kept.');
