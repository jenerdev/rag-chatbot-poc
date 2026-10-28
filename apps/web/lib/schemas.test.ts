// schemas.ts's suggested questions (D-089): the platform route's first word
// on the shape Postgres enforces again (tenants_suggested_questions_shape).

import { describe, expect, it } from 'vitest';
import {
  bookQuoteSchema,
  chatSchema,
  copyHolidaysSchema,
  createSlotSchema,
  firstError,
  MAX_SUGGESTED_QUESTION_LENGTH,
  MAX_SUGGESTED_QUESTIONS,
  paymentSettingsSchema,
  setRatesSchema,
  updateTenantSchema,
} from './schemas';

// T-013 (GHSA-mrhx-c7xc-m3w5): zod 4 refuses an over-cap list BEFORE parsing
// one element; zod 3 parsed all and kept every issue (a million empty rooms:
// 2,000,001 issues, 1,136 ms, +379 MB). Every list a route takes has a cap.
describe('every list is capped, and an over-long one costs one issue', () => {
  const huge = Array.from({ length: 100_000 }, () => ({}));
  for (const [name, schema, body, words] of [
    ['bookQuoteSchema.rooms', bookQuoteSchema, { slotId: 1, checkIn: '2026-11-01', rooms: huge }, 'One request holds at most 10 rooms.'],
    ['setRatesSchema.rates', setRatesSchema, { rates: huge }, 'Send at most 100 rates at once.'],
    ['copyHolidaysSchema.days', copyHolidaysSchema, { days: huge, toYear: 2027 }, 'Copy at most 100 dates at once.'],
    ['paymentSettingsSchema.methods', paymentSettingsSchema, { settings: { methods: huge, fee: { kind: 'full' }, payWithinHours: null, reviewWithinHours: null, terms: null } }, 'config.payments.methods is a list of 1 to 5 ways to pay'],
  ] as const) {
    it(name, () => {
      const r = (schema as typeof bookQuoteSchema).safeParse(body);
      expect(r.success).toBe(false);
      expect(r.error!.issues).toHaveLength(1);
      expect(firstError(r.error!)).toBe(words);
    });
  }
});

// The messages are the contract (schemas.ts's header): zod 3's own words,
// kept on zod 4 by typeError() and v3Words.
describe("zod 3's words on zod 4", () => {
  const first = (schema: typeof chatSchema, body: unknown) => {
    const r = schema.safeParse(body);
    return r.success ? 'ok' : firstError(r.error);
  };
  it('a required field, missing and of the wrong type', () => {
    expect(first(chatSchema, {})).toBe('A message is required');
    expect(first(chatSchema, { message: 5 })).toBe('A message is required');
    expect(first(chatSchema, { message: 'x'.repeat(5000) })).toMatch(/^Question is 5000 characters; the limit is \d+$/);
    expect(first(chatSchema, { message: 'hi', conversationId: 5 })).toBe('conversationId must be a string');
  });
  it("zod 3's defaults where no schema words its own", () => {
    expect(first(createSlotSchema as never, {})).toBe('Required');
    expect(first(createSlotSchema as never, { name: 5 })).toBe('Expected string, received number');
    expect(first(createSlotSchema as never, { name: 'A', startTime: '10:00', minutes: 60, extra: 1 })).toBe("Unrecognized key(s) in object: 'extra'");
    expect(first(updateTenantSchema as never, { chatRetentionDays: 1.5 })).toBe('Expected integer, received float');
  });
});

const parse = (suggestedQuestions: unknown) => updateTenantSchema.safeParse({ suggestedQuestions });

describe('updateTenantSchema: suggestedQuestions', () => {
  it('takes up to six trimmed questions, in order, or null to clear', () => {
    const ok = parse(['  What rooms do you have? ', 'Do you allow pets?']);
    expect(ok.success && ok.data.suggestedQuestions).toEqual(['What rooms do you have?', 'Do you allow pets?']);
    expect(parse(Array.from({ length: MAX_SUGGESTED_QUESTIONS }, (_, i) => `Q${i}`)).success).toBe(true);
    expect(parse(null).success).toBe(true);
  });

  it('refuses what Postgres would refuse, in words', () => {
    for (const bad of [
      Array.from({ length: MAX_SUGGESTED_QUESTIONS + 1 }, (_, i) => `Q${i}`),
      [],
      ['   '],
      ['x'.repeat(MAX_SUGGESTED_QUESTION_LENGTH + 1)],
      ['Rooms?', 5],
      'What rooms do you have?',
    ]) {
      expect(parse(bad).success, JSON.stringify(bad).slice(0, 40)).toBe(false);
    }
  });
});
