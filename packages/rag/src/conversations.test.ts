import { describe, expect, it } from 'vitest';
import { NO_ANSWER } from './constants.js';
import { conversationDays, messageKind, parseConversationPage } from './conversations.js';

describe('conversationDays', () => {
  it('keeps the three windows, as numbers or query strings', () => {
    expect(conversationDays(7)).toBe(7);
    expect(conversationDays('90')).toBe(90);
  });
  it('makes anything else 30, as the SQL function does', () => {
    for (const v of [45, '1', '', null, undefined, 'abc', 7.5]) expect(conversationDays(v)).toBe(30);
  });
});

describe('messageKind', () => {
  it('names a visitor message a question, whatever it says', () => {
    expect(messageKind('user', NO_ANSWER)).toBe('question');
  });
  it('names the exact marker a refusal, and a reply that mentions it an answer', () => {
    expect(messageKind('assistant', NO_ANSWER)).toBe('refusal');
    expect(messageKind('assistant', `The pool hours, yes. ${NO_ANSWER}`)).toBe('answer');
  });
  it('names the two failure shapes answer.ts saves', () => {
    expect(messageKind('assistant', '[no answer — the request failed]')).toBe('failed');
    expect(messageKind('assistant', 'Check-in is at […answer interrupted]')).toBe('interrupted');
  });
});

// The jsonb conversation_list() returns (verify 169's shape).
describe('parseConversationPage', () => {
  it('maps every field and clamps the window', () => {
    const page = parseConversationPage({
      timezone: 'Asia/Manila',
      days: 30,
      total: 2,
      more: false,
      rows: [
        { id: 'b', startedAt: '2026-10-13T01:00:00+00:00', lastAt: '2026-10-13T01:00:00+00:00', turns: 1, refusals: 0, firstQuestion: 'What time is check-in?', extra: 'dropped' },
        { id: 'a', startedAt: 's', lastAt: 'l', turns: '2', refusals: 1, firstQuestion: null },
      ],
    });
    expect(page.total).toBe(2);
    expect(page.more).toBe(false);
    expect(page.rows[0]).toEqual({ id: 'b', startedAt: '2026-10-13T01:00:00+00:00', lastAt: '2026-10-13T01:00:00+00:00', turns: 1, refusals: 0, firstQuestion: 'What time is check-in?' });
    expect(page.rows[1].turns).toBe(2);
    expect(page.rows[1].firstQuestion).toBe('');
  });
  it('reads an empty or odd value as an empty page', () => {
    expect(parseConversationPage(null)).toEqual({ timezone: 'Asia/Manila', days: 30, total: 0, more: false, rows: [] });
  });
});
