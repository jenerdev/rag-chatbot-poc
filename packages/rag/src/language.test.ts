// language.ts's tests. No model, no database: these pin which messages count
// as an explicit language request (D-043).
//
// The failure that matters most is a Tagalog QUESTION read as a request for
// Tagalog. That would switch the reply to pure Tagalog, which is exactly the
// behaviour this feature replaces with the Taglish default.

import { describe, expect, it } from 'vitest';
import {
  detectLanguage,
  languageInstructions,
  languagePreference,
  languageRequest,
  replyLanguage,
  requestReply,
} from './language.js';
import type { LanguagePreference } from './language.js';

describe('explicit requests it must recognise', () => {
  const cases: [string, LanguagePreference][] = [
    ['Tagalog lang po sana ang sagot.', 'tagalog'],
    ['Tagalog lang po.', 'tagalog'],
    ['tagalog only please', 'tagalog'],
    ['Puro Tagalog po sana', 'tagalog'],
    ['Sagutin mo sa Tagalog', 'tagalog'],
    ['Filipino lang po', 'tagalog'],
    ['Please respond in English.', 'english'],
    ['English please', 'english'],
    ['English po', 'english'],
    ['Can you reply in English?', 'english'],
    ['Mag-English ka na lang po', 'english'],
    ['Taglish po', 'taglish'],
    ['Can you reply in Taglish?', 'taglish'],
  ];
  for (const [message, language] of cases) {
    it(`"${message}" → ${language}`, () => expect(languageRequest(message)).toBe(language));
  }

  it('two languages named: the last one wins ("not Tagalog, English")', () => {
    expect(languageRequest('Hindi Tagalog, English please')).toBe('english');
  });

  it('a request with a question attached is still a request', () => {
    expect(languageRequest('Tagalog lang po, magkano ang Overnight?')).toBe('tagalog');
  });
});

describe('messages that are NOT requests', () => {
  const notRequests = [
    // Tagalog and Taglish QUESTIONS: they get the Taglish default, not a pin.
    'Magkano po ang room for overnight?',
    'May available pa ba kayong room bukas?',
    'How much po yung room for 10 persons?',
    'Gusto ko po mag-book ng room sa Saturday.',
    // Short follow-ups: never a change of language.
    'yes',
    'okay',
    'September 28',
    '10',
    // A language named without asking for it.
    'Do you have an English menu?',
    'Is the tour guide Tagalog-speaking?',
  ];
  for (const message of notRequests) {
    it(`"${message}" → null`, () => expect(languageRequest(message)).toBeNull());
  }
});

describe('languagePreference: the latest explicit request, newest first', () => {
  it('none asked: null, so the prompt default (Taglish for Tagalog) applies', () => {
    expect(languagePreference(['Magkano po?', 'Hello'])).toBeNull();
  });

  it('short follow-ups do not reset it: the scan carries on past them', () => {
    expect(languagePreference(['September 28', 'yes', 'Tagalog lang po', 'Magkano po?'])).toBe('tagalog');
  });

  it('an explicit change overrides the earlier one', () => {
    expect(languagePreference(['Please respond in English.', 'Magkano po?', 'Tagalog lang po'])).toBe('english');
    expect(languagePreference(['Taglish po', 'Please respond in English.'])).toBe('taglish');
  });
});

describe('requestReply: a bare request is answered without retrieval', () => {
  it('"Tagalog lang po sana ang sagot." is acknowledged in Tagalog', () => {
    expect(requestReply('Tagalog lang po sana ang sagot.')).toBe(
      'Opo, sasagot po ako sa Tagalog. Ano po ang maitutulong ko sa inyo?',
    );
  });

  it('"Please respond in English." is acknowledged in English', () => {
    expect(requestReply('Please respond in English.')).toBe(
      "Of course! I'll respond in English from now on. How can I help you?",
    );
  });

  it('a request WITH a question goes through the pipeline instead', () => {
    expect(requestReply('Tagalog lang po, magkano ang Overnight?')).toBeNull();
    expect(requestReply('In English please, how much is the Day Tour?')).toBeNull();
  });

  it('an ordinary question is not claimed', () => {
    expect(requestReply('Magkano po ang Overnight?')).toBeNull();
    expect(requestReply('What is the Wi-Fi password?')).toBeNull();
  });
});

describe('detectLanguage: grammar words, not vocabulary', () => {
  const cases: [string, 'english' | 'tagalog' | null][] = [
    // The prompt examples from the brief.
    ['Magkano po ang room for overnight?', 'tagalog'],
    ['May available pa ba kayong room bukas?', 'tagalog'],
    ['How much po yung room for 10 persons?', 'tagalog'], // Taglish counts as Tagalog: both get Taglish
    ['Gusto ko po mag-book ng room sa Saturday.', 'tagalog'],
    ['How much is the Overnight rate on weekends?', 'english'],
    ['What is the Wi-Fi password?', 'english'],
    ['Who do I contact on extension 4417?', 'english'],
    // No language: they must never switch it.
    ['September 28', null],
    ['10 October', null],
    ['yes', null],
    ['okay', null],
    ['12', null],
    ['Overnight', null],
  ];
  for (const [message, language] of cases) {
    it(`"${message}" → ${language}`, () => expect(detectLanguage(message)).toBe(language));
  }
});

describe('replyLanguage: newest first, the current message included', () => {
  it('Tagalog in: Taglish out, not Tagalog', () => {
    expect(replyLanguage(['Magkano po ang Overnight?'])).toEqual({ language: 'taglish', asked: false });
  });

  it('English in: English out', () => {
    expect(replyLanguage(['How much is the Overnight?'])).toEqual({ language: 'english', asked: false });
  });

  it('a bare date keeps the language of the message before it', () => {
    expect(replyLanguage(['September 28', 'May available room ba bukas?'])).toEqual({ language: 'taglish', asked: false });
    expect(replyLanguage(['okay', 'yes', 'Is the Overnight open?'])).toEqual({ language: 'english', asked: false });
  });

  it('an unrequested switch follows the latest message that has a language', () => {
    expect(replyLanguage(['How much is the Day Tour?', 'Magkano po ang Overnight?']).language).toBe('english');
    expect(replyLanguage(['Magkano po ang Day Tour?', 'How much is the Overnight?']).language).toBe('taglish');
  });

  it('an explicit request wins over the language the user writes in, and holds', () => {
    expect(replyLanguage(['Magkano po?', 'Please respond in English.'])).toEqual({ language: 'english', asked: true });
    expect(replyLanguage(['How much is it?', 'yes', 'Tagalog lang po'])).toEqual({ language: 'tagalog', asked: true });
  });

  it('an explicit change overrides the earlier request', () => {
    expect(replyLanguage(['Taglish po', 'Magkano po?', 'Tagalog lang po'])).toEqual({ language: 'taglish', asked: true });
  });

  it('nothing determinable: English, the behaviour before D-043', () => {
    expect(replyLanguage(['10 October', 'okay'])).toEqual({ language: 'english', asked: false });
    expect(replyLanguage([])).toEqual({ language: 'english', asked: false });
  });
});

describe('languageInstructions: the prompt lines', () => {
  it('an unrequested English reply adds nothing, so English prompts are unchanged', () => {
    expect(languageInstructions({ language: 'english', asked: false })).toEqual([]);
  });

  it('a requested English reply adds exactly one line', () => {
    const lines = languageInstructions({ language: 'english', asked: true });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('Reply only in English');
  });

  it('Taglish and Tagalog each carry their directive, and the facts/refusal lines', () => {
    const taglish = languageInstructions({ language: 'taglish', asked: false }).join(' ');
    const tagalog = languageInstructions({ language: 'tagalog', asked: true }).join(' ');
    expect(taglish).toContain('Reply in Taglish');
    expect(tagalog).toContain('Reply entirely in Tagalog');
    expect(tagalog).toContain('The user asked for Tagalog only.');
    for (const text of [taglish, tagalog]) {
      expect(text).toContain('Changing the language never changes a fact');
      expect(text).toContain('The refusal sentence stays exactly as written, in English.');
    }
  });
});
