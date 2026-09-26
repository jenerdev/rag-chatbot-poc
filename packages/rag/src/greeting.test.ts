// The greeting matcher's tests.
//
// Two failure modes, and the second is much worse than the first:
//
//   1. A greeting is not recognised  -> the user gets the refusal. Mildly rude.
//   2. A QUESTION is recognised as a greeting -> the user asked something real
//      and got a canned hello instead, with no sources and no way to tell why.
//
// So most of what is below is case 2.

import { describe, expect, it } from 'vitest';
import { classifySmallTalk, greetingReply, greetingText, smallTalkLanguage, smallTalkReply, thanksPrefix } from './greeting.js';

// Two tenants, so the reply can be checked for naming the right one.
const NORTHWIND = { assistantName: 'Nora', businessName: 'Northwind Labs' };
const VILLA = { assistantName: 'Lia', businessName: 'Villa Amihan Private Resort' };

describe('greetings it must recognise', () => {
  const greetings = [
    'hi',
    'Hi',
    'HI',
    'hi!',
    'hello',
    'Hello!',
    'hellooo',
    'hey',
    'heyyy',
    'hey there',
    'yo',
    'hiya',
    'howdy',
    'sup',
    'greetings',
    'good morning',
    'Good Morning!',
    'good afternoon',
    'good evening',
    'good day',
    'good morning team',
    'hello everyone',
    '  hi  ',
    'hello 👋',
    'hi,',
  ];

  for (const message of greetings) {
    it(`${JSON.stringify(message)}`, () => {
      expect(greetingReply(message, NORTHWIND)).toBe(greetingText(NORTHWIND));
    });
  }
});

describe('what it must NOT claim', () => {
  const questions = [
    // The dangerous shape: opens like a greeting, is a question.
    'hi, what is the Wi-Fi password?',
    'hello, can I check in early?',
    'good morning, what time is breakfast?',
    'hey what are the rates',
    // No question mark, but plainly a request.
    'hi i need the wifi password',
    'good morning please send the rates',
    // Real questions.
    'What is the Wi-Fi password?',
    'How many guests can stay?',
    'extension 4417',
    // Words that merely contain a greeting.
    'high chair availability',
    'hello kitty themed party',
    'is there a helipad',
    // Empty and whitespace.
    '',
    '   ',
  ];

  for (const message of questions) {
    it(`${JSON.stringify(message)}`, () => {
      expect(greetingReply(message, NORTHWIND)).toBeNull();
    });
  }
});

describe('the reply itself', () => {
  it('is short, offers help, and does not talk about "documents" (D-049)', () => {
    // The first version said what the bot was for ("I will answer from the
    // documents and show you the exact passages I used"). D-047 took that
    // system voice out of the refusal; this is the same voice, and the
    // sources panel still shows the passages without being announced.
    const reply = greetingText(NORTHWIND);
    expect(reply).toBe("Hi! 👋 I'm Nora, the assistant for Northwind Labs. How can I help you today?");
    expect(reply).not.toMatch(/document/i);
  });

  it('greets in the conversation language', () => {
    expect(greetingText(VILLA, 'taglish')).toMatch(/^Hi po! 👋 Ako si Lia/);
    expect(greetingText(VILLA, 'tagalog')).toMatch(/^Magandang araw po! 👋 Ako si Lia/);
  });

  it("names this tenant's assistant and business, and never the other's", () => {
    const villa = greetingReply('hi', VILLA);
    expect(villa).toContain('Lia');
    expect(villa).toContain('Villa Amihan Private Resort');
    expect(villa).not.toContain('Nora');
    expect(villa).not.toContain('Northwind');

    const northwind = greetingReply('hi', NORTHWIND);
    expect(northwind).toContain('Nora');
    expect(northwind).not.toContain('Lia');
  });
});

// --- D-049: thanks, acknowledgments, farewells, Tagalog, mixed messages -----

describe('classifySmallTalk: the whole message is small talk', () => {
  it.each([
    // greetings, English and Tagalog
    ['Hi', 'greeting'], ['Hello', 'greeting'], ['Hey', 'greeting'], ['Good morning', 'greeting'],
    ['Good afternoon', 'greeting'], ['Good evening', 'greeting'], ['Hi po', 'greeting'], ['Hello po', 'greeting'],
    ['Kamusta', 'greeting'], ['Kumusta po?', 'greeting'], ['Magandang umaga po', 'greeting'], ['How are you?', 'greeting'],
    // thanks
    ['Thank you', 'thanks'], ['Thanks', 'thanks'], ['Thank you so much', 'thanks'], ['Salamat', 'thanks'],
    ['Salamat po', 'thanks'], ['Thanks po', 'thanks'], ['Maraming salamat po!', 'thanks'], ['ty', 'thanks'],
    // acknowledgments
    ['Okay', 'acknowledgment'], ['Alright', 'acknowledgment'], ['Got it', 'acknowledgment'],
    ['I understand', 'acknowledgment'], ['Sige', 'acknowledgment'], ['Noted', 'acknowledgment'], ['okayyy', 'acknowledgment'],
    ['Sige po', 'acknowledgment'],
    // farewells, and the most final kind wins
    ['Bye', 'farewell'], ['Goodbye', 'farewell'], ['See you', 'farewell'], ['Thank you, bye', 'farewell'],
    ['Salamat, bye', 'farewell'], ['ingat po', 'farewell'], ['ok bye', 'farewell'],
    // mixed small talk
    ['ok thanks', 'thanks'], ['hi thanks', 'thanks'], ['Okay, noted', 'acknowledgment'],
  ] as const)('%s → %s', (message, kind) => {
    expect(classifySmallTalk(message)).toBe(kind);
  });

  it.each([
    // A real question or request in it: never claimed.
    'Hi, what time is check-in?',
    'Thanks! Is the resort available tomorrow?',
    'Hello, magkano yung overnight?',
    'Salamat po, may parking ba?',
    'okay, how about bukas?',
    'sige, bukas po',
    'Thank you for the rates',
    // Answers to a question the bot asked: not acknowledgments at all.
    'yes',
    'opo',
    'oo',
    'sure',
    // Words that merely contain small talk.
    'okra',
    'thanksgiving promo',
    'byebye shuttle',
  ])('%s is not small talk', (message) => {
    expect(classifySmallTalk(message)).toBeNull();
  });
});

describe('smallTalkReply', () => {
  it('thanks, in each language, and nothing about documents', () => {
    expect(smallTalkReply('Thank you', VILLA)).toBe("You're welcome! 😊 Let me know if you need anything else.");
    expect(smallTalkReply('Salamat po', VILLA, 'taglish')).toMatch(/^Walang anuman po! 😊/);
  });

  it('a farewell that also thanks answers both', () => {
    expect(smallTalkReply('Thank you, bye', VILLA)).toBe("You're welcome! Have a great day! 😊");
    expect(smallTalkReply('Bye', VILLA)).toBe('Goodbye! Have a great day! 😊');
  });

  it('"okay" is claimed, UNLESS the bot just asked a question: then it is an answer, for the pipeline', () => {
    expect(smallTalkReply('okay', VILLA)).toBe("Great! 😊 Let me know if there's anything else I can help with.");
    expect(smallTalkReply('sige', VILLA, 'taglish', true)).toBeNull();
    // A greeting or thanks is still small talk after a question.
    expect(smallTalkReply('thanks', VILLA, 'english', true)).not.toBeNull();
  });

  it('a greeting names the tenant', () => {
    expect(smallTalkReply('Hi po', VILLA, 'taglish')).toContain('Villa Amihan Private Resort');
  });
});

describe('smallTalkLanguage', () => {
  it('Tagalog small talk is Taglish even on a first turn', () => {
    expect(smallTalkLanguage('Salamat po')).toBe('taglish');
    expect(smallTalkLanguage('Kamusta')).toBe('taglish');
    expect(smallTalkLanguage('Thanks')).toBeNull();
  });
});

describe('thanksPrefix: a mixed message that opens with thanks', () => {
  it('"Thanks! Is the resort available tomorrow?" is answered with the thanks acknowledged first', () => {
    expect(thanksPrefix('Thanks! Is the resort available tomorrow?')).toBe("You're welcome! ");
    expect(thanksPrefix('Salamat po! Magkano ang overnight?', 'taglish')).toBe('Walang anuman po! ');
  });

  it('not for pure thanks (that is small talk), and not for a message that does not open with thanks', () => {
    expect(thanksPrefix('Thanks!')).toBeNull();
    expect(thanksPrefix('Hi, what time is check-in?')).toBeNull();
    expect(thanksPrefix('Is it available? thanks')).toBeNull();
  });
});
