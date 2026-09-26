// greeting.ts — small talk: the messages the bot answers without reading a
// document or calling a tool (D-049; greetings alone since plan.md Phase 4).
//
// WHY THIS IS CODE AND NOT A DOCUMENT
// -----------------------------------
// The obvious fix for "hi" returning the refusal is to paste a greetings
// document into the knowledge base. It works, and it quietly taxes every other
// question: that document competes for the MATCH_COUNT slots on every search,
// and a chunk of small talk occupying one of five slots is a chunk of the
// actual answer that did not make it into the prompt.
//
// Retrieval is also the wrong tool for the job. "Salamat po" has no facts to
// look up, so vector search returns whatever is nearest in a corpus that has
// nothing to say about it, and the visitor got the refusal (measured
// 2026-09-27: "Salamat po" and "okay" both did). Recognising small talk
// before any of that costs nothing, returns instantly, and cannot be wrong
// about a document it never read.
//
// So: pure functions, no I/O, no model call. Same discipline as the chunker.
//
// THE ONE RULE: the WHOLE message must be small talk. "Hi, what time is
// check-in?" is a question that opens politely, and answering it with a
// canned hello would be a worse bug than the one this fixes. So a message is
// claimed only when every word in it belongs to a small-talk phrase or a
// filler word; one other word, and it goes to the pipeline as before.

import type { LanguagePreference } from './language.js';
import type { TenantContext } from './types.js';

export type SmallTalk = 'greeting' | 'thanks' | 'acknowledgment' | 'farewell';

/**
 * The phrases, as word sequences, per kind. Longer phrases are listed where a
 * shorter one would misread them ("good night" is a farewell, "good" is not a
 * phrase at all). Tagalog is here because villa's visitors write it (D-043).
 *
 * Deliberately NOT acknowledgments: "yes", "oo", "opo", "yeah", "sure". Those
 * answer a question ("Would you like the Overnight slot?"), and a canned
 * "Let me know if you need anything else" in reply would drop the booking.
 */
const PHRASES: Record<SmallTalk, string[]> = {
  greeting: [
    'hi', 'hey', 'hello', 'yo', 'hiya', 'howdy', 'sup', 'greetings', 'good morning', 'good afternoon',
    'good evening', 'good day', 'morning', 'how are you', 'kamusta', 'kumusta', 'musta',
    'magandang umaga', 'magandang hapon', 'magandang gabi', 'magandang araw',
  ],
  thanks: [
    'thanks', 'thank you', 'thankyou', 'thx', 'ty', 'tysm', 'salamat', 'maraming salamat',
    'appreciate it', 'much appreciated', 'thanks a lot', 'thank you so much', 'thank you very much',
  ],
  acknowledgment: [
    'ok', 'okay', 'okey', 'oki', 'okie', 'k', 'alright', 'all right', 'got it', 'gotcha', 'i understand',
    'understood', 'i see', 'noted', 'sige', 'cool', 'great', 'nice', 'perfect', 'ayos', 'gets',
  ],
  farewell: [
    'bye', 'goodbye', 'good bye', 'bye bye', 'see you', 'see ya', 'see you later', 'take care',
    'good night', 'paalam', 'ingat', 'until next time',
  ],
};

/**
 * Words that ride along with small talk and change nothing: "Hi po",
 * "Salamat po sa inyo", "Hello there everyone". None of them can carry a
 * question on its own.
 */
const FILLER = new Set(
  'po ho naman lang din rin na ah oh so very much a lot there everyone all team guys sa inyo ka kayo again'.split(' '),
);

/** Longer than any real small talk, with room for "salamat po, bye". A second guard against a long message. */
const MAX_SMALL_TALK_LENGTH = 60;

/** Lower-case words only: punctuation, emoji and "?" gone ("Kamusta po?" is a greeting). */
function words(message: string): string[] {
  return message
    .toLowerCase()
    .replace(/[^\p{L}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean)
    // "heyyy", "hellooo", "byee", "okayyy" are the same word.
    .map((w) => w.replace(/(.)\1{2,}$/u, '$1').replace(/^(hey|hell?o|bye|oka?y)\w*$/u, (_m, stem) => stem));
}

/**
 * Which kinds of small talk a message is made of, or null if any word in it
 * is something else. Greedy longest-phrase match, left to right.
 */
function kindsIn(message: string): Set<SmallTalk> | null {
  if (message.trim().length === 0 || message.length > MAX_SMALL_TALK_LENGTH) return null;
  const ws = words(message).map((w) => (w === 'helo' ? 'hello' : w === 'oky' ? 'okay' : w));
  if (ws.length === 0) return null;
  const phrases = (Object.entries(PHRASES) as [SmallTalk, string[]][])
    .flatMap(([kind, list]) => list.map((p) => ({ kind, parts: p.split(' ') })))
    .sort((a, b) => b.parts.length - a.parts.length);

  const kinds = new Set<SmallTalk>();
  for (let i = 0; i < ws.length; ) {
    const hit = phrases.find((p) => p.parts.every((part, j) => ws[i + j] === part));
    if (hit) {
      kinds.add(hit.kind);
      i += hit.parts.length;
    } else if (FILLER.has(ws[i]!)) {
      i += 1;
    } else {
      return null; // a word that is not small talk: this is a real message
    }
  }
  return kinds.size > 0 ? kinds : null;
}

/**
 * What kind of small talk the WHOLE message is, or null.
 *
 * Mixed small talk resolves to the most final one: "thank you, bye" is a
 * farewell, "ok thanks" is thanks, "hi thanks" is thanks.
 */
export function classifySmallTalk(message: string): SmallTalk | null {
  const kinds = kindsIn(message);
  if (!kinds) return null;
  for (const kind of ['farewell', 'thanks', 'greeting', 'acknowledgment'] as const) {
    if (kinds.has(kind)) return kind;
  }
  return null;
}

/** Did the message thank the bot? Also true for "thank you, bye", which is a farewell. */
function thanked(message: string): boolean {
  return kindsIn(message)?.has('thanks') ?? false;
}

/**
 * Small-talk words that are Tagalog. language.ts's lists know "salamat" and
 * "sige" but not every greeting ("kamusta", "magandang umaga"), and a
 * one-word message is all the evidence there is on a first turn.
 */
const TAGALOG_SMALL_TALK = new Set(
  'po ho kamusta kumusta musta magandang salamat maraming sige paalam ingat ayos gets'.split(' '),
);

/** 'taglish' when the small talk itself is Tagalog ("Salamat po", "Kamusta"), else null. */
export function smallTalkLanguage(message: string): LanguagePreference | null {
  return words(message).some((w) => TAGALOG_SMALL_TALK.has(w)) ? 'taglish' : null;
}

/**
 * The first-contact greeting, per tenant (plan.md Phase 4): it names the
 * assistant and the business, so a visitor to one tenant's page never sees
 * another tenant's name. Short, and says nothing about "documents": D-047
 * took the system talk out of the refusal, and this is the same voice.
 */
export function greetingText(
  tenant: Pick<TenantContext, 'assistantName' | 'businessName'>,
  language: LanguagePreference = 'english',
): string {
  const { assistantName: a, businessName: b } = tenant;
  switch (language) {
    case 'taglish':
      return `Hi po! 👋 Ako si ${a}, ang assistant ng ${b}. Ano po ang maitutulong ko sa inyo today?`;
    case 'tagalog':
      return `Magandang araw po! 👋 Ako si ${a}, ang assistant ng ${b}. Ano po ang maitutulong ko sa inyo?`;
    default:
      return `Hi! 👋 I'm ${a}, the assistant for ${b}. How can I help you today?`;
  }
}

const REPLIES: Record<Exclude<SmallTalk, 'greeting'>, Record<LanguagePreference, string>> = {
  thanks: {
    english: "You're welcome! 😊 Let me know if you need anything else.",
    taglish: 'Walang anuman po! 😊 Let me know lang po if may kailangan pa kayo.',
    tagalog: 'Walang anuman po! 😊 Sabihan lang po ninyo ako kung may kailangan pa kayo.',
  },
  acknowledgment: {
    english: "Great! 😊 Let me know if there's anything else I can help with.",
    taglish: 'Sige po! 😊 Just let me know if may iba pa kayong tanong.',
    tagalog: 'Sige po! 😊 Sabihan lang po ninyo ako kung may iba pa kayong tanong.',
  },
  farewell: {
    english: 'Goodbye! Have a great day! 😊',
    taglish: 'Bye po! Ingat po kayo! 😊',
    tagalog: 'Paalam po! Mag-ingat po kayo! 😊',
  },
};

/** "Thank you, bye" gets a farewell that answers the thanks too. */
const THANKED_FAREWELL: Record<LanguagePreference, string> = {
  english: "You're welcome! Have a great day! 😊",
  taglish: 'Walang anuman po! Ingat po kayo! 😊',
  tagalog: 'Walang anuman po! Mag-ingat po kayo! 😊',
};

/**
 * The reply for a message that is nothing but small talk, or null.
 *
 * Null means "carry on with retrieval": the normal pipeline is unchanged for
 * every message this does not claim.
 *
 * `botAsked`: the bot's previous message ended in a question. Then "okay" or
 * "sige" is an ANSWER to it ("Gusto niyo po bang i-check ang Overnight?"
 * "Sige"), so it is not claimed and goes to the pipeline, which has the
 * history. Greetings, thanks and farewells are claimed either way.
 */
export function smallTalkReply(
  message: string,
  tenant: Pick<TenantContext, 'assistantName' | 'businessName'>,
  language: LanguagePreference = 'english',
  botAsked = false,
): string | null {
  const kind = classifySmallTalk(message);
  if (kind === null) return null;
  if (kind === 'acknowledgment' && botAsked) return null;
  if (kind === 'greeting') return greetingText(tenant, language);
  if (kind === 'farewell' && thanked(message)) return THANKED_FAREWELL[language];
  return REPLIES[kind][language];
}

/**
 * A mixed message that opens with thanks ("Thanks! Is the resort available
 * tomorrow?") is answered in full by the pipeline, and this is put in front
 * of the answer, so the thanks is not ignored. null when it does not open
 * with thanks. Display only: answer.ts never saves it, so a refusal stays
 * the exact NO_ANSWER marker the unanswered list matches (D-045, D-047).
 */
export function thanksPrefix(message: string, language: LanguagePreference = 'english'): string | null {
  // The thanks is the first phrase, and a real message follows it: "Thanks!"
  // alone is small talk, answered whole by smallTalkReply.
  const opening = message.split(/[.!,;:?\n]/, 1)[0] ?? '';
  if (!/\p{L}/u.test(message.slice(opening.length))) return null;
  const kinds = kindsIn(opening);
  if (!kinds?.has('thanks')) return null;
  return { english: "You're welcome! ", taglish: 'Walang anuman po! ', tagalog: 'Walang anuman po! ' }[language];
}

/**
 * The first-contact reply for a message that is nothing but a greeting, in
 * English, or null. Kept for callers that predate smallTalkReply (D-049).
 */
export function greetingReply(
  message: string,
  tenant: Pick<TenantContext, 'assistantName' | 'businessName'>,
): string | null {
  return classifySmallTalk(message) === 'greeting' ? greetingText(tenant) : null;
}
