import { NO_ANSWER } from './constants.js';
import type { TenantContext, UnansweredQuestion } from './types.js';

// The questions this tenant's documents could not answer, for staff: each one
// is a gap in the knowledge base.
//
// Nothing new is recorded for this. Every turn is already saved, refusals
// included (saveMessages in answer.ts), and a refusal is always the exact
// string NO_ANSWER: the empty-retrieval short-circuit (D-008), the tool-tenant
// fallback (D-035) and the grounding prompt all produce it verbatim. So "not
// answered" is "the assistant message after it is NO_ANSWER".
//
// What this does NOT catch: a partial answer ("the documents cover X but not
// Y"), and a failed request, which is saved as a marker, not a refusal.
//
// RESOLVED (D-045). Once staff have added the answer to the knowledge base,
// they mark the question resolved. That is a row in unanswered_resolutions
// pointing at the refusal, not a delete: the list is read out of the
// transcripts, and a transcript is never edited.

/** How many refusals one call reads. Newest first, so the recent gaps are always in it. */
export const UNANSWERED_LIMIT = 200;

/**
 * The open questions (`resolved: false`) or the resolved ones (`true`),
 * newest first.
 *
 * The filter runs in Postgres, so resolved questions never use up the open
 * list's UNANSWERED_LIMIT.
 */
export async function listUnanswered(
  tenant: TenantContext,
  { resolved = false }: { resolved?: boolean } = {},
): Promise<UnansweredQuestion[]> {
  // 1. The refusals, each with its resolution if it has one. tenant_id is
  //    filtered here as well as by RLS (rule 6: each wall must hold alone).
  //    The embedded resolution needs no filter of its own: it joins on the
  //    composite FK (message_id, tenant_id), so it can only be this
  //    message's, and this message is this tenant's.
  //
  //    Open = no resolution row (an anti-join, `is null`). Resolved = an
  //    inner join (`!inner`). Staff only: a chat token reads no resolutions,
  //    so to it every question would look open. The route is admin-only.
  const base = tenant.db.from('messages');
  const query = resolved
    ? base.select('id, conversation_id, created_at, unanswered_resolutions!inner(resolved_at)')
    : base.select('id, conversation_id, created_at, unanswered_resolutions(resolved_at)').is('unanswered_resolutions', null);
  const { data: refusals, error: refusalError } = await query
    .eq('tenant_id', tenant.id)
    .eq('role', 'assistant')
    .eq('content', NO_ANSWER)
    .order('id', { ascending: false })
    .limit(UNANSWERED_LIMIT);
  if (refusalError) throw new Error(`Could not load refusals: ${refusalError.message}`);
  if (refusals.length === 0) return [];

  // 2. The user messages in those conversations. The question a refusal
  //    answers is the latest user message before it in the same conversation.
  //    Not simply id - 1: identity values are handed out per row, so a
  //    concurrent insert could in principle land between the two rows of a turn.
  const conversationIds = [...new Set(refusals.map((r) => r.conversation_id))];
  const { data: questions, error: questionError } = await tenant.db
    .from('messages')
    .select('id, conversation_id, content')
    .eq('tenant_id', tenant.id)
    .eq('role', 'user')
    .in('conversation_id', conversationIds)
    .order('id', { ascending: false });
  if (questionError) throw new Error(`Could not load questions: ${questionError.message}`);

  const unanswered: UnansweredQuestion[] = [];
  for (const refusal of refusals) {
    const question = questions.find((q) => q.conversation_id === refusal.conversation_id && q.id < refusal.id);
    if (!question) continue;
    // Mapped field by field, never spread (CLAUDE.md rule 7's habit): the
    // conversation id stays on the server.
    unanswered.push({
      id: refusal.id,
      question: question.content,
      askedAt: refusal.created_at,
      // An array of at most one: PostgREST embeds it to-many (database.types.ts).
      resolvedAt: refusal.unanswered_resolutions[0]?.resolved_at ?? null,
    });
  }
  console.log(`[unanswered] tenant=${tenant.slug} ${resolved ? 'resolved' : 'open'}: ${unanswered.length} question(s)`);
  return unanswered;
}

/**
 * Mark one unanswered question resolved. `id` is the refusal's message id.
 *
 * `false` when that id is not one of this tenant's refusals: another tenant's
 * message, a message that answered, or nothing at all. Checked before the
 * insert, so a resolution can only ever point at a real refusal. Resolving
 * twice is not an error: the second is ignored.
 */
export async function resolveUnanswered(tenant: TenantContext, id: number): Promise<boolean> {
  const { data: refusal, error: findError } = await tenant.db
    .from('messages')
    .select('id')
    .eq('tenant_id', tenant.id)
    .eq('id', id)
    .eq('role', 'assistant')
    .eq('content', NO_ANSWER)
    .maybeSingle();
  if (findError) throw new Error(`Could not load the question: ${findError.message}`);
  if (!refusal) return false;

  // tenant_id is set here AND checked by the composite FK against the
  // message's own tenant_id (schema-unanswered.sql step 2).
  const { error } = await tenant.db
    .from('unanswered_resolutions')
    .upsert({ message_id: id, tenant_id: tenant.id }, { onConflict: 'message_id', ignoreDuplicates: true });
  if (error) throw new Error(`Could not mark the question resolved: ${error.message}`);
  console.log(`[unanswered] tenant=${tenant.slug} resolved ${id}`);
  return true;
}

/**
 * Undo a resolution: the question is open again. `false` when this tenant has
 * no resolution for that id, which also covers another tenant's.
 */
export async function reopenUnanswered(tenant: TenantContext, id: number): Promise<boolean> {
  const { error, count } = await tenant.db
    .from('unanswered_resolutions')
    .delete({ count: 'exact' })
    .eq('tenant_id', tenant.id)
    .eq('message_id', id);
  if (error) throw new Error(`Could not reopen the question: ${error.message}`);
  if ((count ?? 0) > 0) console.log(`[unanswered] tenant=${tenant.slug} reopened ${id}`);
  return (count ?? 0) > 0;
}
