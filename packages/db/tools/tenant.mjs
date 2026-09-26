// tenant.mjs — create a tenant, or set what its chat says when it cannot answer.
//
//   pnpm --filter @rag/db tenant:add -- <slug> "<business name>" "<assistant name>"
//   pnpm --filter @rag/db tenant:fallback -- <slug> <english|taglish|tagalog> "<message>"   (D-047, D-048)
//   pnpm --filter @rag/db tenant:fallback -- <slug> <language> --clear    that language back to the default
//   pnpm --filter @rag/db tenant:fallback -- <slug> --clear               every language back to the default
//   pnpm --filter @rag/db tenant:fallback -- <slug>                       show what is set
//
// A new tenant has no members, so nobody can administer it yet. Add the first
// one with `pnpm --filter @rag/db member:add -- <slug> <email>`. Until auth-rls
// Phase 6 this also printed a shared admin key; staff accounts replaced it
// (D-040), and the key, its hash column and `tenant:key` are gone.
//
// Carries --conditions=react-server like every script that touches @rag/db
// (CLAUDE.md rule 4). The flag is in package.json.

import { supabase } from '../dist/service.js';

const args = process.argv.slice(2).filter((a) => a !== '--');
const [command, slug, businessName, assistantName] = args;

const fail = (message) => {
  console.error(`tenant.mjs: ${message}`);
  process.exitCode = 1;
};

if (command === 'fallback') {
  // The message a visitor sees instead of the internal refusal marker, one
  // per reply language. It is shown as plain text (React escapes it), so any
  // wording is safe; the shape and the 500-character cap are enforced by the
  // tenants_fallback_messages_shape constraint.
  const LANGUAGES = ['english', 'taglish', 'tagalog'];
  const [, , language, message] = args;
  const show = (m) =>
    LANGUAGES.map((l) => `  ${l.padEnd(8)} ${m?.[l] ?? '(built-in default)'}`).join('\n');

  const { data: rows, error: readError } = await supabase.from('tenants').select('fallback_messages').eq('slug', slug ?? '');
  if (!slug) {
    fail('usage: tenant:fallback -- <slug> [<english|taglish|tagalog> "<message>" | <language> --clear | --clear]');
  } else if (readError) {
    fail(`could not read "${slug}": ${readError.message}`);
  } else if (rows.length === 0) {
    fail(`no tenant "${slug}"`);
  } else if (language === undefined) {
    console.log(`"${slug}" fallback messages:\n${show(rows[0].fallback_messages)}`);
  } else if (language !== '--clear' && (!LANGUAGES.includes(language) || !message)) {
    fail(`the language is one of ${LANGUAGES.join(', ')}, followed by a message or --clear`);
  } else {
    const current = { ...(rows[0].fallback_messages ?? {}) };
    if (language === '--clear') for (const l of LANGUAGES) delete current[l];
    else if (message === '--clear') delete current[language];
    else current[language] = message.trim();
    const next = Object.keys(current).length === 0 ? null : current;
    const { data, error } = await supabase
      .from('tenants')
      .update({ fallback_messages: next })
      .eq('slug', slug)
      .select('fallback_messages');
    if (error) fail(`could not update "${slug}": ${error.message}`);
    else console.log(`"${slug}" fallback messages:\n${show(data[0].fallback_messages)}`);
  }
} else if (command !== 'add') {
  fail('the command is "add" or "fallback" (tenant:key was removed in auth-rls Phase 6; use member:add)');
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
