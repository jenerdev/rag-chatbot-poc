// stay-notes.ts — staff notes on a stay, many per stay (D-132).
//
// Written on the stay's page (S-15) by staff, for staff; never shown to the
// guest, never in a prompt. Append and delete-your-own only: a correction is
// a new note (sql/schema-stay-notes.sql, rule 1). The policies are the guard:
// bookings:read to read, bookings:write and authorship to add or delete. The
// author is the token's user, set by the column default and demanded by the
// insert policy, so nothing here passes a user id to the database.
//
// Every query filters on tenant_id (CLAUDE.md rule 6). A stay or a note that
// is not this tenant's is "not there", the same as one that does not exist.

import { BookingInputError } from './errors.js';
import type { BookingTenant } from './types.js';

/** What a note may hold, the SQL check's own bounds (stay_notes_body). */
export const MAX_STAY_NOTE = 2000;

export interface StayNote {
  id: number;
  body: string;
  createdAt: string;
  /** the author's email, from member_emails(); null for an account that is no longer a member */
  author: string | null;
  /** written by the member asking: only its author may delete a note */
  mine: boolean;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A stay's notes, oldest first, with each author's email. `userId` is the member asking. */
export async function listStayNotes(tenant: BookingTenant, groupId: string, userId: string | null): Promise<StayNote[]> {
  if (!UUID.test(groupId)) throw new BookingInputError('That is not a booking id.');
  const { data, error } = await tenant.db
    .from('stay_notes')
    .select('id, author, body, created_at')
    .eq('tenant_id', tenant.id)
    .eq('group_id', groupId)
    .order('created_at')
    .order('id');
  if (error) throw new Error(`Could not load the notes: ${error.message}`);
  if (data.length === 0) return [];

  // Emails, not ids: a colleague's address is not a secret from a colleague
  // (member_emails(), schema-roles.sql). A removed member's notes stay, unnamed.
  const { data: members, error: membersError } = await tenant.db.rpc('member_emails', { p_tenant_id: tenant.id });
  if (membersError) throw new Error(`Could not load the notes' authors: ${membersError.message}`);
  const email = new Map(members.map((m) => [m.user_id, m.email]));

  return data.map((n) => ({
    id: n.id,
    body: n.body,
    createdAt: n.created_at,
    author: n.author ? (email.get(n.author) ?? null) : null,
    mine: n.author !== null && n.author === userId,
  }));
}

/** The stay's group id by its reference, or null (not this tenant's, or not there). */
async function groupOf(tenant: BookingTenant, reference: string): Promise<string | null> {
  const ref = reference.trim().toUpperCase();
  if (!/^[A-Z0-9-]{3,20}$/.test(ref)) return null;
  const { data, error } = await tenant.db.from('stays').select('group_id').eq('tenant_id', tenant.id).eq('reference', ref).maybeSingle();
  if (error) throw new Error(`Could not load the stay: ${error.message}`);
  return data?.group_id ?? null;
}

/** Add a note to the stay with this reference. Null when there is no such stay here. */
export async function addStayNote(tenant: BookingTenant, reference: string, body: string): Promise<{ id: number } | null> {
  const text = body.trim();
  if (text.length === 0) throw new BookingInputError('Write the note first.');
  if (text.length > MAX_STAY_NOTE) throw new BookingInputError(`The note is too long (${MAX_STAY_NOTE} characters at most).`);
  const groupId = await groupOf(tenant, reference);
  if (!groupId) return null;

  const { data, error } = await tenant.db
    .from('stay_notes')
    .insert({ tenant_id: tenant.id, group_id: groupId, body: text })
    .select('id')
    .single();
  if (error) throw new Error(`Could not save the note: ${error.message}`);
  console.log(`[bookings] ${tenant.slug} note ${data.id} added to ${reference}`);
  return data;
}

/**
 * Delete one of your own notes. False when there is nothing to delete: not
 * this stay's, not this tenant's, already gone, or someone else's (the
 * policy reaches only the author's own rows, so all four look the same).
 */
export async function deleteStayNote(tenant: BookingTenant, reference: string, id: number): Promise<boolean> {
  const groupId = await groupOf(tenant, reference);
  if (!groupId) return false;
  // A refused delete is silent under RLS (trap 17): count what went.
  const { data, error } = await tenant.db
    .from('stay_notes')
    .delete()
    .eq('tenant_id', tenant.id)
    .eq('group_id', groupId)
    .eq('id', id)
    .select('id');
  if (error) throw new Error(`Could not delete the note: ${error.message}`);
  if (data.length === 0) return false;
  console.log(`[bookings] ${tenant.slug} note ${id} deleted from ${reference}`);
  return true;
}
