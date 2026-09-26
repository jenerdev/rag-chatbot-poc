// refusal.ts's tests (D-047). The marker must never reach a visitor, and
// nothing that is NOT exactly the marker may be swapped or lost.

import { describe, expect, it } from 'vitest';
import { NO_ANSWER } from './constants.js';
import { DEFAULT_REFUSALS, displayReply, isRefusal, refusalFilter, refusalText } from './refusal.js';

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
  it("uses the tenant's own message when it has one, in every language", () => {
    for (const language of ['english', 'taglish', 'tagalog'] as const) {
      expect(refusalText({ fallbackMessage: FRIENDLY }, language)).toBe(FRIENDLY);
    }
  });

  it('falls back to the built-in default in the reply language', () => {
    expect(refusalText({ fallbackMessage: null }, 'english')).toBe(DEFAULT_REFUSALS.english);
    expect(refusalText({ fallbackMessage: null }, 'taglish')).toBe(DEFAULT_REFUSALS.taglish);
    expect(refusalText({ fallbackMessage: null })).toBe(DEFAULT_REFUSALS.english);
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
