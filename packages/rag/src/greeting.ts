// greeting.ts — the one thing the bot answers without reading a document.
//
// WHY THIS IS CODE AND NOT A DOCUMENT
// -----------------------------------
// The obvious fix for "hi" returning the refusal is to paste a greetings
// document into the knowledge base. It works, and it quietly taxes every other
// question: that document competes for the MATCH_COUNT slots on every search,
// and a chunk of small talk occupying one of five slots is a chunk of the
// actual answer that did not make it into the prompt.
//
// Retrieval is also the wrong tool for the job. A greeting has no facts to look
// up, so vector search returns whatever is nearest in a corpus that has nothing
// to say about it — which is exactly the case MIN_SIMILARITY exists to reject
// (D-008). Recognising the greeting before any of that happens costs nothing,
// returns instantly, and cannot be wrong about a document it never read.
//
// So: a pure function, no I/O, no model call. Same discipline as the chunker,
// for the same reason — it can be read and tested on its own.

import type { TenantContext } from './types.js';

/**
 * What the bot says back.
 *
 * Deliberately says what it is FOR. A bare "Hello!" is friendly and useless;
 * the greeting is the one moment a first-time user is definitely reading, and
 * the useful thing to tell them is what kind of question this thing can answer.
 *
 * Per tenant (plan.md Phase 4): it names the assistant and the business, so a
 * visitor to one tenant's page never sees another tenant's name. Still a pure
 * function of its arguments, with no I/O.
 */
export function greetingText(tenant: Pick<TenantContext, 'assistantName' | 'businessName'>): string {
  return (
    `Hello! I'm ${tenant.assistantName}, the assistant for ${tenant.businessName}. ` +
    `Ask me anything about ${tenant.businessName}'s documents, and I will answer ` +
    'from them and show you the exact passages I used.'
  );
}

/**
 * Greetings recognised as a WHOLE message.
 *
 * Anchored at both ends on purpose. A substring match would swallow real
 * questions that happen to open politely — "hi, what is the Wi-Fi password?" is
 * a question, not a greeting, and answering it with a canned hello would be a
 * worse bug than the one this fixes.
 *
 * `hey+` and `hello+` absorb "heyyy" and "hellooo".
 *
 * Only English. If this corpus's users greet in another language — "kumusta",
 * "magandang umaga" — add them here; that is the whole change.
 */
const GREETING =
  /^(hi|hey+|hello+|yo|hiya|howdy|sup|greetings|good (morning|afternoon|evening|day))( there| everyone| all| team| guys)?$/;

/** Longer than any greeting in the list, with room for a suffix. */
const MAX_GREETING_LENGTH = 24;

/**
 * The reply for a message that is nothing but a greeting, or null.
 *
 * Null means "carry on with retrieval" — the caller decides what to do, and the
 * normal pipeline is unchanged for every message this does not claim.
 */
export function greetingReply(
  message: string,
  tenant: Pick<TenantContext, 'assistantName' | 'businessName'>,
): string | null {
  // A question mark means the user wants something, however they opened. This
  // catches the whole "hi, can you tell me X?" family before normalising
  // strips the punctuation that reveals it.
  if (message.includes('?')) return null;

  // Strip punctuation and emoji rather than listing their variants: "hi!",
  // "Hello 👋" and "good morning," all normalise to the bare phrase.
  const normalized = message
    .toLowerCase()
    .replace(/[^a-z\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // A cheap guard before the regex, and a second line of defence against a
  // long message that happens to begin with a greeting word.
  if (normalized.length > MAX_GREETING_LENGTH) return null;

  return GREETING.test(normalized) ? greetingText(tenant) : null;
}
