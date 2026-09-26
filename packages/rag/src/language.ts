// language.ts — which language the reply is in, decided in code (D-043).
//
// WHY CODE, AND NOT A RULE IN THE PROMPT
// --------------------------------------
// The first version was prompt only: "English in, English out; Tagalog in,
// Taglish out", with an example of Taglish. gpt-4o-mini could not do both
// halves at once. With the Taglish example in the prompt, an ENGLISH question
// came back in Taglish ("Ang Overnight rate po natin is ₱20,000 on
// weekends"), and a bare "10 October" follow-up was read as English, so the
// conversation switched language mid-booking. Deciding the language is a
// classification, which code does the same way every time. WRITING Taglish is
// what the model is good at. So this file decides, and the prompt carries one
// directive for the language chosen.
//
// Two rules, applied to the user's own messages, newest first:
//
//   1. An explicit request ("Tagalog lang po", "Please respond in English")
//      wins, and holds until another request. It is found by scanning the
//      stored messages, not the history window: MAX_HISTORY re-sends only six
//      messages, and a request made four turns ago must still hold.
//   2. Otherwise, the language of the latest message that HAS one. A Tagalog
//      word in it means Taglish, and English means English. A bare date, a
//      number, "yes" or "okay" has no language, so the scan carries on to the
//      message before it. That is how a short follow-up keeps the language.
//
// A Tagalog QUESTION is not a request for Tagalog. It gets Taglish, and that
// distinction is the whole feature. Only naming the language is a request.
//
// An English turn with no request adds NOTHING to the prompt, so every such
// prompt is byte-identical to the one before this file existed. The model
// already answers English in English (lang-english passed before D-043).
//
// Same discipline as greeting.ts and the chunker: pure functions, no I/O, no
// model call, so the rules can be read and tested on their own.

/** The language a reply is written in. `tagalog` is Tagalog ONLY, and only on request. */
export type LanguagePreference = 'english' | 'taglish' | 'tagalog';

/** The words that name each language. "Filipino" and "Pilipino" are Tagalog here. */
const NAMES: Record<LanguagePreference, string[]> = {
  english: ['english', 'ingles'],
  tagalog: ['tagalog', 'filipino', 'pilipino'],
  taglish: ['taglish'],
};

/**
 * Words that may surround a language name in a message that is NOTHING BUT a
 * request: "Tagalog lang po sana ang sagot", "Can you reply in English
 * please". A message made only of these and a language name is a request and
 * nothing else, so it is answered by requestReply() without retrieval. There
 * is nothing to look up in "Please respond in English", and retrieval can only
 * end in the refusal (the same argument as greeting.ts).
 */
const REQUEST_WORDS = new Set(
  (
    // English
    'please pls kindly can could would you just only from now on use speak talk reply respond answer ' +
    'write switch change to in with do i want prefer like me us okay ok lets let s ' +
    // Tagalog
    'po lang lamang na nalang sana ang sagot sagutin sumagot mo ninyo niyo nyo mag magsalita ' +
    'gamitin gamit paki pakisagot pwede puwede ba sa ng tayo naman nga salita wika puro dapat ' +
    'gusto ko ako ka sige tapos'
  ).split(/\s+/),
);

/**
 * Cues that make a language name a request inside a longer message:
 * "Tagalog lang po, magkano ang Overnight?" asks for Tagalog AND asks a
 * question. Anchored to the name, so "Do you have an English menu?" is not
 * a request, and neither is a question that merely mentions a language.
 */
function requestPatterns(name: string): RegExp[] {
  return [
    // "tagalog lang", "english only", "english na lang", "english please"
    new RegExp(`\\b${name}\\s+(lang|lamang|only|na\\s+lang|nalang|please|pls)\\b`),
    // "in english", "sa tagalog", with a verb of replying near it
    new RegExp(`\\b(reply|respond|answer|speak|talk|write|switch|sagot\\w*|sumagot|magsalita|gamitin)\\b.{0,24}\\b(in|sa|to|ng)\\s+${name}\\b`),
    // "mag-english"
    new RegExp(`\\bmag\\s+${name}\\b`),
    // "puro tagalog", "pure english", "all in english"
    new RegExp(`\\b(puro|pure|purely|all\\s+in|buong)\\s+${name}\\b`),
  ];
}

/** Lowercase, hyphens and punctuation to spaces: "Mag-English po!" → "mag english po". */
function normalize(message: string): string {
  return message
    .toLowerCase()
    .replace(/[^a-z\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The language this ONE message asks for, or null.
 *
 * Null for every message that is not a request, which is almost all of them.
 * If a message names two ("hindi Tagalog, English please"), the one named
 * LAST wins, because that is where a correction goes.
 */
export function languageRequest(message: string): LanguagePreference | null {
  const text = normalize(message);
  const words = text.split(' ');

  let found: { language: LanguagePreference; at: number } | null = null;
  for (const [language, names] of Object.entries(NAMES) as [LanguagePreference, string[]][]) {
    for (const name of names) {
      const at = words.lastIndexOf(name);
      if (at === -1) continue;
      const asked =
        words.every((w) => w === name || REQUEST_WORDS.has(w)) ||
        requestPatterns(name).some((p) => p.test(text));
      if (asked && (found === null || at > found.at)) found = { language, at };
    }
  }
  return found?.language ?? null;
}

/**
 * The request in force: the most recent explicit request, or null.
 *
 * `userMessages` is NEWEST FIRST, the current message included, because that
 * is the order the database returns them in. A short reply ("yes", "okay",
 * "10 October") is not a request, so it changes nothing, and the scan
 * carries on to the request before it.
 */
export function languagePreference(userMessages: string[]): LanguagePreference | null {
  for (const message of userMessages) {
    const asked = languageRequest(message);
    if (asked) return asked;
  }
  return null;
}

/**
 * Tagalog function words: grammar, not vocabulary. Content words are no help
 * ("room", "booking" and "Overnight" are English in Taglish too), but a
 * Tagalog sentence almost never gets by without one of these. Left out on
 * purpose: "at" and "may", which are English words as well.
 */
const TAGALOG_MARKERS = new Set(
  (
    'po opo ho ang ng nang mga sa na ay ba ko mo niyo ninyo nyo inyo natin namin kayo tayo kami ' +
    'siya sila ako ikaw ito iyan yan yung iyong lang din rin naman pa kung para pero kasi wala ' +
    'meron mayroon hindi pwede puwede pong magkano ilan anong ano saan kailan paano bakit gusto ' +
    'salamat pag kapag nasa bukas ngayon sige'
  ).split(/\s+/),
);

/** Common English words, enough to tell an English sentence from a bare date. */
const ENGLISH_MARKERS = new Set(
  (
    'the a an is are was be you your we i it for and or of to in on with this that can will would ' +
    'could there here please have has do does not but if what when how which where who much many'
  ).split(/\s+/),
);

/**
 * The language ONE message is written in, or null when it has none.
 *
 * `tagalog` means "has Tagalog in it", so it covers Taglish too: both get a
 * Taglish reply. One Tagalog word is enough ("How much po?"). English needs
 * two English words and no Tagalog, so "10 October", "yes" and "okay" come
 * back null and never switch the language.
 */
export function detectLanguage(message: string): 'english' | 'tagalog' | null {
  const words = normalize(message).split(' ');
  if (words.some((w) => TAGALOG_MARKERS.has(w))) return 'tagalog';
  if (words.filter((w) => ENGLISH_MARKERS.has(w)).length >= 2) return 'english';
  return null;
}

export interface LanguageChoice {
  language: LanguagePreference;
  /** True when the user explicitly asked for it. */
  asked: boolean;
}

/**
 * The language to reply in, from the user's messages, NEWEST FIRST, the
 * current one included. The two rules are at the top of this file. With
 * nothing determinable at all, a conversation of dates and "okay"s, the
 * answer is English, which is what the prompt did before this file existed.
 */
export function replyLanguage(userMessages: string[]): LanguageChoice {
  const asked = languagePreference(userMessages);
  if (asked) return { language: asked, asked: true };
  for (const message of userMessages) {
    const detected = detectLanguage(message);
    if (detected) return { language: detected === 'tagalog' ? 'taglish' : 'english', asked: false };
  }
  return { language: 'english', asked: false };
}

/** Longer than any request worth answering on its own. A guard, like MAX_GREETING_LENGTH. */
const MAX_REQUEST_LENGTH = 80;

/** The acknowledgement for each request, in the language asked for. */
const ACKNOWLEDGEMENTS: Record<LanguagePreference, string> = {
  english: "Of course! I'll respond in English from now on. How can I help you?",
  tagalog: 'Opo, sasagot po ako sa Tagalog. Ano po ang maitutulong ko sa inyo?',
  taglish: "Sure po! I'll reply in Taglish from now on. Ano po ang maitutulong ko sa inyo?",
};

/**
 * The reply to a message that is nothing but a language request, or null.
 *
 * "Please respond in English" has nothing to retrieve. Sent through the
 * pipeline, it finds no chunk and ends in the refusal, which is the wrong
 * answer to a perfectly clear instruction. So, like a greeting, it is
 * answered here. A request with a question attached ("Tagalog lang po,
 * magkano ang Overnight?") returns null: the question goes through the
 * pipeline, and replyLanguage() applies the request.
 */
export function requestReply(message: string): string | null {
  const text = normalize(message);
  if (text.length > MAX_REQUEST_LENGTH) return null;
  const language = languageRequest(message);
  if (language === null) return null;
  const onlyRequest = text.split(' ').every((w) => NAMES[language].includes(w) || REQUEST_WORDS.has(w));
  return onlyRequest ? ACKNOWLEDGEMENTS[language] : null;
}

// --- the prompt text for each language ---------------------------------------
// This is prompt text, so an edit here is an edit to buildPrompt(): re-run
// `pnpm eval` (CLAUDE.md rule 1). Every line answers a reply the lang-* cases
// measured (plan/baseline/eval-lang-*.txt).

// Worded as what TO write, with a before and an after, because that is the
// shape this model follows (D-017). Placeholders, not facts, so the example
// holds nothing that could be copied into an answer as a fact. The last
// sentence is for the tools block's example, which is English: without it,
// every availability answer copied that sentence word for word, in English.
const TAGLISH = [
  'Reply in Taglish, the way Filipino customer service talks: about half',
  'Tagalog and half English, mixed inside each sentence. English nouns are',
  'not enough: every sentence needs English grammar words too (is, are, and,',
  'for, on, you can, if, but), mixed with everyday Tagalog (po, ang, natin,',
  'naman, pa, kung, lang). For example:',
  '- asked "Magkano po ang X?", write "Ang X po natin is ₱N on weekdays, and',
  '  ₱M naman on weekends." Not "Ang X ay ₱N sa weekdays at ₱M sa weekends."',
  '- asked "Pwede po bang X?", write "Yes po, you can X." Not "Oo po, puwede',
  '  ang X."',
  '- for "Yes, the X is open on D.", write "Yes po, the X is open pa sa D."',
  'No deep or formal Tagalog, and no slang. Any other example in these',
  'instructions is in English: keep its facts and its shape, in Taglish.',
];

const TAGALOG = [
  'Reply entirely in Tagalog: simple, everyday Tagalog, with English only for',
  'names, prices and terms that have no everyday Tagalog word. Any other',
  'example in these instructions is in English: keep its facts and its shape,',
  'in Tagalog.',
];

// Said with every non-English directive. A block that asks for translation
// must say that the refusal is not translated, or it would be, and the
// refusal is an exact string (NO_ANSWER) that the UI and D-035 rely on.
const FACTS = [
  'Changing the language never changes a fact: say what the context says, and',
  'add nothing. The refusal sentence stays exactly as written, in English.',
];

const ASKED: Record<LanguagePreference, string> = {
  english: 'The user asked for English. Reply only in English, whatever language they write in.',
  tagalog: 'The user asked for Tagalog only.',
  taglish: 'The user asked for Taglish.',
};

/**
 * The lines buildPrompt() appends for this choice, or [] for none.
 *
 * [] for an English reply nobody asked for: the model answers English in
 * English unprompted, and no line means no change to any English prompt.
 */
export function languageInstructions(choice: LanguageChoice): string[] {
  const asked = choice.asked ? [ASKED[choice.language]] : [];
  switch (choice.language) {
    case 'english':
      return asked;
    case 'taglish':
      return [...asked, ...TAGLISH, ...FACTS];
    case 'tagalog':
      return [...asked, ...TAGALOG, ...FACTS];
  }
}
