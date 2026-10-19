// voice.ts — the one read the speak route makes (plan/voice.md Rule 2, D-134).
//
// The chat route is open, so the speak route is too, and a route that spoke
// ANY text would be free text-to-speech on the tenant's OpenAI key. So it
// takes a conversation, never text, and speaks that conversation's latest
// reply, read here on the chat token.
//
// Both walls (CLAUDE.md rule 6): every query filters on `tenant_id` (wall 1),
// and RLS compares every row with the token's tenant (wall 2). Another
// tenant's conversation and a missing one are the same `null`, so a
// conversation id cannot be probed across tenants.

import { displayReply, refusalText } from './refusal.js';
import { replyLanguage, type LanguagePreference } from './language.js';
import type { TenantContext } from './types.js';

/** How far back the read looks for the reply and the questions that decide its language. */
const RECENT_MESSAGES = 12;

/**
 * The conversation's latest assistant reply as the visitor SAW it: a stored
 * refusal (the marker, D-047) becomes the tenant's own words in the reply's
 * language, decided from the questions as the answer was (D-043, D-048).
 * null: no such conversation for this tenant, or no reply in it yet.
 */
export async function latestReply(
  tenant: TenantContext,
  conversationId: string,
): Promise<{ text: string; language: LanguagePreference } | null> {
  const { data: owned, error: ownError } = await tenant.db
    .from('conversations')
    .select('id')
    .eq('tenant_id', tenant.id)
    .eq('id', conversationId)
    .maybeSingle();
  if (ownError) throw new Error(`Could not load the conversation: ${ownError.message}`);
  if (!owned) return null;

  const { data, error } = await tenant.db
    .from('messages')
    .select('role, content')
    .eq('tenant_id', tenant.id)
    .eq('conversation_id', conversationId)
    .order('id', { ascending: false })
    .limit(RECENT_MESSAGES);
  if (error) throw new Error(`Could not load messages: ${error.message}`);

  const reply = data.find((m) => m.role === 'assistant');
  if (!reply) return null;
  // Newest first, as replyLanguage() wants them.
  const { language } = replyLanguage(data.filter((m) => m.role === 'user').map((m) => m.content));
  console.log(`[voice] ${tenant.slug} latest reply of ${conversationId}: ${reply.content.length} chars, ${language}`);
  return { text: displayReply(reply.content, refusalText(tenant, language)), language };
}
