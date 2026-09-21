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
import { GREETING_REPLY, greetingReply } from './greeting.js';

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
      expect(greetingReply(message)).toBe(GREETING_REPLY);
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
      expect(greetingReply(message)).toBeNull();
    });
  }
});

describe('the reply itself', () => {
  it('says what the bot is for, not just hello', () => {
    // A bare "Hello!" would be friendly and useless. The greeting is the one
    // moment a first-time user is definitely reading.
    expect(GREETING_REPLY).toMatch(/knowledge base/i);
    expect(GREETING_REPLY.length).toBeGreaterThan(40);
  });
});
