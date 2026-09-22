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
import { greetingReply, greetingText } from './greeting.js';

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
  it('says what the bot is for, not just hello', () => {
    // A bare "Hello!" would be friendly and useless. The greeting is the one
    // moment a first-time user is definitely reading.
    const reply = greetingText(NORTHWIND);
    expect(reply).toMatch(/documents/i);
    expect(reply).toMatch(/passages I used/i);
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
