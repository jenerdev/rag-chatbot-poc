// tenant.mjs — create a tenant, or set what its chat says when it cannot answer.
//
//   pnpm --filter @rag/db tenant:add -- <slug> "<business name>" "<assistant name>"
//   pnpm --filter @rag/db tenant:fallback -- <slug> <english|taglish|tagalog> "<message>"   (D-047, D-048)
//   pnpm --filter @rag/db tenant:fallback -- <slug> <language> --clear    that language back to the default
//   pnpm --filter @rag/db tenant:fallback -- <slug> --clear               every language back to the default
//   pnpm --filter @rag/db tenant:fallback -- <slug>                       show what is set
//   pnpm --filter @rag/db tenant:booking-type -- <slug>                    show how it books (D-055)
//   pnpm --filter @rag/db tenant:booking-type -- <slug> <whole_resort|per_room>   switch it
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
} else if (command === 'booking-type') {
  // whole_resort or per_room (plan/booking-types.md § 2.4, D-055). An
  // OPERATOR command, not a staff screen: a whole-property booking would not
  // overlap a room booking, so switching a tenant that has live bookings could
  // sell the property twice.
  //
  // The database decides whether a switch is allowed. tenant_applications'
  // validate trigger refuses it while any booking has not ended, and refuses
  // whole_resort with more than one active unit, and its message carries the
  // count. This command does not re-implement either rule: it says what is
  // set, asks for the change, and reports Postgres's answer as it is.
  const TYPES = ['whole_resort', 'per_room'];
  const [, , wanted] = args;
  const { data: tenant, error: tenantError } = await supabase.from('tenants').select('id, slug').eq('slug', slug ?? '').maybeSingle();
  if (!slug || (wanted !== undefined && !TYPES.includes(wanted))) {
    fail(`usage: tenant:booking-type -- <slug> [${TYPES.join('|')}]`);
  } else if (tenantError || !tenant) {
    fail(tenantError ? `could not read "${slug}": ${tenantError.message}` : `no tenant "${slug}"`);
  } else {
    const { data: app, error: appError } = await supabase
      .from('tenant_applications')
      .select('config')
      .eq('tenant_id', tenant.id)
      .eq('application_key', 'bookings')
      .maybeSingle();
    const describe = async (config) => {
      const { data: units } = await supabase.from('units').select('active').eq('tenant_id', tenant.id);
      const active = (units ?? []).filter((u) => u.active).length;
      return (
        `"${slug}" books as ${config.booking_type ?? 'whole_resort'}` +
        `${config.booking_type ? '' : ' (the default: no booking_type in its config)'}; ` +
        `${active} active unit(s), ${(units ?? []).length - active} retired; timezone ${config.timezone}`
      );
    };
    if (appError) {
      fail(`could not read "${slug}"'s bookings: ${appError.message}`);
    } else if (!app) {
      fail(`"${slug}" does not have the bookings application, so it has no booking type`);
    } else if (wanted === undefined) {
      console.log(await describe(app.config));
    } else if ((app.config.booking_type ?? 'whole_resort') === wanted) {
      console.log(`${await describe(app.config)}. Nothing to change.`);
    } else {
      // whole_resort is the ABSENCE of the key, so every tenant that never
      // chose looks the same as one that chose whole_resort.
      const config = { ...app.config };
      if (wanted === 'whole_resort') delete config.booking_type;
      else config.booking_type = wanted;
      const { data, error } = await supabase
        .from('tenant_applications')
        .update({ config })
        .eq('tenant_id', tenant.id)
        .eq('application_key', 'bookings')
        .select('config')
        .single();
      if (error) {
        fail(`refused: ${error.message}`);
      } else {
        console.log(await describe(data.config));
        if (wanted === 'per_room') {
          console.log('Add rooms and give each a rate on its Rooms screen; a room with no rate cannot be booked.');
        }
      }
    }
  }
} else if (command !== 'add') {
  fail('the command is "add", "fallback" or "booking-type" (tenant:key was removed in auth-rls Phase 6; use member:add)');
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
