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

/** How many refusals one call reads. Newest first, so the recent gaps are always in it. */
export const UNANSWERED_LIMIT = 200;

export async function listUnanswered(tenant: TenantContext): Promise<UnansweredQuestion[]> {
  // 1. The refusals. tenant_id is filtered here as well as by RLS (rule 6:
  //    each wall must hold alone).
  const { data: refusals, error: refusalError } = await tenant.db
    .from('messages')
    .select('id, conversation_id, created_at')
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
    unanswered.push({ id: refusal.id, question: question.content, askedAt: refusal.created_at });
  }
  console.log(`[unanswered] tenant=${tenant.slug} ${unanswered.length} question(s)`);
  return unanswered;
}
