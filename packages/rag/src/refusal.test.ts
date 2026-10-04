// refusal.ts's tests (D-047). The marker must never reach a visitor, and
// nothing that is NOT exactly the marker may be swapped or lost.

import { describe, expect, it } from 'vitest';
import { NO_ANSWER } from './constants.js';
import { DEFAULT_REFUSALS, displayReply, isRefusal, refusalFilter, refusalText, storedReply } from './refusal.js';

const FRIENDLY = 'Sorry po, wala pa kaming info diyan. Message us on Facebook: Villa Amihan.';

/** Feed a text through the filter in the given pieces; return everything it sent. */
function stream(pieces: string[], friendly = FRIENDLY): string {
  const out: string[] = [];
  const filter = refusalFilter((t) => out.push(t), friendly);
  for (const p of pieces) filter.push(p);
  filter.finish();
  return out.join('');
}

/** Split a text into deltas of n characters, as a stream would deliver it. */
const deltas = (text: string, n: number) => text.match(new RegExp(`[\\s\\S]{1,${n}}`, 'g')) ?? [];

describe('refusalText', () => {
  const VILLA = {
    fallbackMessages: {
      english: 'Sorry, message us on Viber.',
      taglish: 'Pasensya na po, message us sa Viber.',
      tagalog: 'Paumanhin po, magpadala ng mensahe sa Viber.',
    },
  };

  it("uses the tenant's own message for the reply's language (D-048)", () => {
    expect(refusalText(VILLA, 'english')).toBe(VILLA.fallbackMessages.english);
    expect(refusalText(VILLA, 'taglish')).toBe(VILLA.fallbackMessages.taglish);
    expect(refusalText(VILLA, 'tagalog')).toBe(VILLA.fallbackMessages.tagalog);
  });

  it("a language the tenant did not write gets the DEFAULT in that language, never another language's custom text", () => {
    const onlyTaglish = { fallbackMessages: { taglish: FRIENDLY } };
    expect(refusalText(onlyTaglish, 'taglish')).toBe(FRIENDLY);
    expect(refusalText(onlyTaglish, 'english')).toBe(DEFAULT_REFUSALS.english);
    expect(refusalText(onlyTaglish, 'tagalog')).toBe(DEFAULT_REFUSALS.tagalog);
  });

  it('no custom wording at all: the built-in default in the reply language', () => {
    expect(refusalText({ fallbackMessages: {} }, 'english')).toBe(DEFAULT_REFUSALS.english);
    expect(refusalText({ fallbackMessages: {} }, 'taglish')).toBe(DEFAULT_REFUSALS.taglish);
    expect(refusalText({ fallbackMessages: {} })).toBe(DEFAULT_REFUSALS.english);
  });

  it('no default is the marker, or technical about "documents"', () => {
    for (const text of Object.values(DEFAULT_REFUSALS)) {
      expect(text).not.toBe(NO_ANSWER);
      expect(text.toLowerCase()).not.toContain('document');
    }
  });
});

describe('isRefusal and displayReply', () => {
  it('the exact marker, trimmed, is a refusal and is swapped', () => {
    expect(isRefusal(NO_ANSWER)).toBe(true);
    expect(isRefusal(`  ${NO_ANSWER}\n`)).toBe(true);
    expect(displayReply(NO_ANSWER, FRIENDLY)).toBe(FRIENDLY);
  });

  // D-092: the prompt asks for an emoji where one fits, and the model may
  // decorate the marker too. Still a refusal, still swapped, SAVED exact.
  it('the marker with an emoji at either end is a refusal, and is stored as the exact marker', () => {
    expect(isRefusal(`${NO_ANSWER} 😔`)).toBe(true);
    expect(isRefusal(`🙏 ${NO_ANSWER}`)).toBe(true);
    expect(isRefusal(`❌ ${NO_ANSWER} 🙏`)).toBe(true);
    expect(displayReply(`${NO_ANSWER} 😔`, FRIENDLY)).toBe(FRIENDLY);
    expect(storedReply(`${NO_ANSWER} 😔`)).toBe(NO_ANSWER);
    expect(storedReply('The deposit is ₱2,000 ✅')).toBe('The deposit is ₱2,000 ✅');
    // An emoji with WORDS after the marker is an answer, as before.
    expect(isRefusal(`${NO_ANSWER} But the deposit is ₱2,000.`)).toBe(false);
  });

  it('a partial answer that contains the marker is an answer, and is left alone', () => {
    const partial = `The Day Tour is ₱9,500. ${NO_ANSWER}`;
    expect(isRefusal(partial)).toBe(false);
    expect(displayReply(partial, FRIENDLY)).toBe(partial);
  });

  it('an ordinary answer is untouched', () => {
    expect(displayReply('Check-in is at 2:00 PM.', FRIENDLY)).toBe('Check-in is at 2:00 PM.');
  });
});

describe('refusalFilter: what a streaming visitor sees', () => {
  it.each([1, 3, 7, 100])('the marker in deltas of %i characters becomes the friendly message, and nothing else', (n) => {
    expect(stream(deltas(NO_ANSWER, n))).toBe(FRIENDLY);
  });

  it('leading whitespace before the marker is still a refusal', () => {
    expect(stream(['\n', ...deltas(NO_ANSWER, 5)])).toBe(FRIENDLY);
  });

  it('a leading emoji, even split across two deltas, and a trailing one, are still the refusal (D-092)', () => {
    expect(stream(['😔 ', ...deltas(NO_ANSWER, 5)])).toBe(FRIENDLY);
    expect(stream(['\uD83D', '\uDE14 ', ...deltas(NO_ANSWER, 3), ' 🙏'])).toBe(FRIENDLY);
  });

  it.each([1, 4, 50])('an answer streams through unchanged (deltas of %i)', (n) => {
    const answer = 'Check-in is at 2:00 PM for the Overnight slot.';
    expect(stream(deltas(answer, n))).toBe(answer);
  });

  it('an answer that starts like the marker ("I don\'t know if…") is sent in full, not swapped', () => {
    const answer = "I don't know if the pool is heated, but the documents say it is a hot spring.";
    expect(stream(deltas(answer, 3))).toBe(answer);
  });

  it('the marker followed by more text is an answer: all of it is sent', () => {
    const answer = `${NO_ANSWER} But the Day Tour starts at 8:00 AM.`;
    expect(stream(deltas(answer, 6))).toBe(answer);
  });

  it('once the text diverges, deltas pass straight through (no buffering of a real answer)', () => {
    const out: string[] = [];
    const filter = refusalFilter((t) => out.push(t), FRIENDLY);
    filter.push('Yes');
    expect(out).toEqual(['Yes']);
    filter.push(' po');
    expect(out).toEqual(['Yes', ' po']);
  });

  it('a stream cut off inside the marker prefix sends what it held on finish', () => {
    expect(stream(["I don't know"])).toBe("I don't know");
  });

  it('nothing streamed, nothing sent', () => {
    expect(stream([])).toBe('');
  });
});
