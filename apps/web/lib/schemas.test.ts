// schemas.ts's suggested questions (D-089): the platform route's first word
// on the shape Postgres enforces again (tenants_suggested_questions_shape).

import { describe, expect, it } from 'vitest';
import { MAX_SUGGESTED_QUESTION_LENGTH, MAX_SUGGESTED_QUESTIONS, updateTenantSchema } from './schemas';

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
