// retention.mjs — keep personal data no longer than each tenant says (D-131,
// plan/legal.md § 6). For every tenant:
//   - chats whose newest message is older than tenants.chat_retention_days
//     are DELETED; their messages go with them, and so does a refused
//     question's resolution row (the cascade), so Unanswered loses old
//     entries too;
//   - stays whose last night is older than tenants.guest_retention_days
//     lose the guest's name, phone, email and notes, and change requests
//     lose the guest's reason (remove_guest_details()). The booking rows,
//     dates, amounts and references stay, for the resort's books;
//   - audit_log rows older than tenants.audit_retention_days are DELETED
//     (D-138); the platform's own rows (no tenant) after PLATFORM_AUDIT_DAYS.
//     A counted delete on service_role: no token may delete one (rule 1).
// Receipts are storage-orphans' job (`-- --expired`, 180 days), unchanged.
//
// A DRY RUN by default: it lists what is due and removes nothing.
//   pnpm --filter @rag/db retention                 what is due, per tenant
//   pnpm --filter @rag/db retention -- --remove     remove it, and count
//   pnpm --filter @rag/db retention -- --tenant villa   one tenant only
//
// service_role, like every tools/ script (CLAUDE.md rule 2): the two SQL
// functions it calls refuse every other caller. Every delete is COUNTED, and
// a count that differs from the list is reported, because a refused delete
// is silent (trap 17). Nothing schedules this yet: on deployment, a daily job.

import { supabase } from '../dist/service.js';

const remove = process.argv.includes('--remove');
const only = process.argv.includes('--tenant') ? process.argv[process.argv.indexOf('--tenant') + 1] : null;
const DAY = 86_400_000;
/** How long the platform-wide audit rows (tenant_id null) are kept: two years, like a tenant's default. */
const PLATFORM_AUDIT_DAYS = 730;

let query = supabase.from('tenants').select('id, slug, chat_retention_days, guest_retention_days, audit_retention_days').order('id');
if (only) query = query.eq('slug', only);
const { data: tenants, error } = await query;
if (error) throw new Error(`Could not list tenants: ${error.message}`);
if (only && tenants.length === 0) throw new Error(`No tenant "${only}"`);

let failures = 0;
for (const t of tenants) {
  const chatBefore = new Date(Date.now() - t.chat_retention_days * DAY);
  const guestBefore = new Date(Date.now() - t.guest_retention_days * DAY).toISOString().slice(0, 10);

  // Chats.
  const { data: chats, error: chatError } = await supabase.rpc('chats_older_than', { p_tenant_id: t.id, p_before: chatBefore.toISOString() });
  if (chatError) throw new Error(`${t.slug}: could not list old chats: ${chatError.message}`);
  let chatLine = `${chats.length} chat(s) older than ${t.chat_retention_days} days`;
  if (remove && chats.length > 0) {
    let gone = 0;
    // In pages, so a long list stays within a URL.
    for (let i = 0; i < chats.length; i += 100) {
      const ids = chats.slice(i, i + 100).map((c) => c.id);
      const { count, error: delError } = await supabase.from('conversations').delete({ count: 'exact' }).eq('tenant_id', t.id).in('id', ids);
      if (delError) throw new Error(`${t.slug}: could not delete chats: ${delError.message}`);
      gone += count ?? 0;
    }
    chatLine += ` → deleted ${gone}`;
    if (gone !== chats.length) {
      failures++;
      chatLine += `  ✗ expected ${chats.length}`;
    }
  }

  // Guest details: the dry run counts the rows remove_guest_details() would clear.
  let guestLine;
  if (remove) {
    const { data: cleared, error: gError } = await supabase.rpc('remove_guest_details', { p_tenant_id: t.id, p_before: guestBefore });
    if (gError) throw new Error(`${t.slug}: could not remove guest details: ${gError.message}`);
    guestLine = `guest details removed from ${cleared} booking row(s) of stays ended before ${guestBefore}`;
  } else {
    const { data: rows, error: rError } = await supabase
      .from('bookings')
      .select('group_id, booked_date')
      .eq('tenant_id', t.id)
      .is('guest_removed_at', null)
      .not('group_id', 'is', null);
    if (rError) throw new Error(`${t.slug}: could not read bookings: ${rError.message}`);
    const lastNight = new Map();
    for (const r of rows) if (!lastNight.has(r.group_id) || r.booked_date > lastNight.get(r.group_id)) lastNight.set(r.group_id, r.booked_date);
    const due = new Set([...lastNight].filter(([, d]) => d < guestBefore).map(([g]) => g));
    guestLine = `${rows.filter((r) => due.has(r.group_id)).length} booking row(s) in ${due.size} stay(s) ended before ${guestBefore} would lose the guest's details`;
  }
  // The audit log (D-138): counted either way; deleted with --remove.
  const auditBefore = new Date(Date.now() - t.audit_retention_days * DAY).toISOString();
  let auditLine;
  if (remove) {
    const { count, error: aError } = await supabase.from('audit_log').delete({ count: 'exact' }).eq('tenant_id', t.id).lt('at', auditBefore);
    if (aError) throw new Error(`${t.slug}: could not delete old activity: ${aError.message}`);
    auditLine = `deleted ${count ?? 0} activity row(s) older than ${t.audit_retention_days} days`;
  } else {
    const { count, error: aError } = await supabase.from('audit_log').select('id', { count: 'exact', head: true }).eq('tenant_id', t.id).lt('at', auditBefore);
    if (aError) throw new Error(`${t.slug}: could not count old activity: ${aError.message}`);
    auditLine = `${count ?? 0} activity row(s) older than ${t.audit_retention_days} days`;
  }
  console.log(`${t.slug.padEnd(16)} ${chatLine} · ${guestLine} · ${auditLine}`);
}

// The platform's own rows, once, unless one tenant was asked for.
if (!only) {
  const before = new Date(Date.now() - PLATFORM_AUDIT_DAYS * DAY).toISOString();
  const q = remove
    ? supabase.from('audit_log').delete({ count: 'exact' }).is('tenant_id', null).lt('at', before)
    : supabase.from('audit_log').select('id', { count: 'exact', head: true }).is('tenant_id', null).lt('at', before);
  const { count, error: pError } = await q;
  if (pError) throw new Error(`platform: could not ${remove ? 'delete' : 'count'} old activity: ${pError.message}`);
  console.log(`${'platform'.padEnd(16)} ${remove ? 'deleted ' : ''}${count ?? 0} activity row(s) older than ${PLATFORM_AUDIT_DAYS} days`);
}

console.log(remove ? (failures ? `\n${failures} COUNT(S) DID NOT MATCH` : '\nDone: every removal counted.') : '\nDRY RUN: nothing removed. Re-run with -- --remove to act.');
if (failures) process.exit(1);
