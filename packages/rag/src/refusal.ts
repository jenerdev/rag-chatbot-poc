// refusal.ts — what a visitor sees when the documents cannot answer (D-047).
//
// NO_ANSWER ("I don't know based on the documents I have.") stays the
// INTERNAL marker. The grounding prompt makes the model write it verbatim;
// the empty-retrieval short circuit (D-008) and the zero-match rule (D-035)
// produce it; it is what `messages` stores; the unanswered list finds
// refusals by it (D-045). Every one of those needs one fixed string.
//
// But it reads like a system message, not a person. So it is swapped for the
// tenant's own words at the last moment, where a reply leaves the server:
// the JSON answer, the stream, and a transcript being reloaded. Nothing
// upstream of that changes, so the measured grounding behaviour (Phase 5.5)
// does not either.

import { NO_ANSWER } from './constants.js';
import type { LanguagePreference } from './language.js';
import type { TenantContext } from './types.js';

/**
 * The built-in friendly refusal, for a tenant that has not written its own.
 * One per reply language (D-043), so a Taglish conversation does not end in
 * an English sentence. Each says the same three things: sorry, not something
 * I know yet, how to reach a person.
 */
export const DEFAULT_REFUSALS: Record<LanguagePreference, string> = {
  english: "Sorry, I don't have that information yet. Please message us directly and we'll be glad to help.",
  taglish:
    'Pasensya na po, wala pa akong info tungkol diyan. Pwede po kayong mag-message sa amin directly para matulungan namin kayo.',
  tagalog:
    'Paumanhin po, wala pa akong impormasyon tungkol diyan. Maaari po kayong magpadala ng mensahe sa amin para matulungan namin kayo.',
};

/**
 * The words this tenant shows for a refusal in this reply's language: its own
 * for that language if it wrote one, otherwise the built-in default in that
 * language (D-048). Never another language's custom text: a Taglish message
 * shown to an English question is exactly what D-048 fixed.
 */
export function refusalText(tenant: Pick<TenantContext, 'fallbackMessages'>, language: LanguagePreference = 'english'): string {
  return tenant.fallbackMessages[language] ?? DEFAULT_REFUSALS[language];
}

/** Is this reply the refusal marker? Exact, after trimming: a partial answer that mentions it is an answer. */
export function isRefusal(reply: string): boolean {
  return reply.trim() === NO_ANSWER;
}

/** The reply as the visitor should see it: the marker becomes the friendly text, anything else is untouched. */
export function displayReply(reply: string, friendly: string): string {
  return isRefusal(reply) ? friendly : reply;
}

/**
 * Wrap a stream's onDelta so the marker never reaches the screen.
 *
 * With chunks retrieved, the model's text streams as it is written (D-019),
 * so a refusal would appear word by word before anything could replace it.
 * This holds deltas back ONLY while everything so far is still a prefix of
 * NO_ANSWER. The moment the text diverges, the held part is sent and the
 * rest streams as normal, so a real answer is delayed by a few characters at
 * most. At the end, a text that turned out to be exactly the marker is sent
 * as the friendly message instead.
 */
export function refusalFilter(onDelta: (text: string) => void, friendly: string) {
  let held = '';
  let passing = false;

  return {
    push(delta: string): void {
      if (passing) return onDelta(delta);
      held += delta;
      // Leading whitespace is allowed, as isRefusal() trims.
      if (!NO_ANSWER.startsWith(held.trimStart())) {
        passing = true;
        onDelta(held);
        held = '';
      }
    },
    /** Call once the model is done. Sends whatever is still held, swapped if it was the refusal. */
    finish(): void {
      if (passing || held === '') return;
      onDelta(isRefusal(held) ? friendly : held);
      held = '';
    },
  };
}
