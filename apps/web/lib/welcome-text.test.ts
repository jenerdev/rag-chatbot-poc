// The welcome line (D-139): the default words when a tenant set none, the
// tenant's own when it did, and the platform route's first word on the
// bound Postgres enforces again (tenants_welcome_text_length).

import { describe, expect, it } from 'vitest';
import { updateTenantSchema } from './schemas';
import { DEFAULT_WELCOME_TEXT, MAX_WELCOME_TEXT_LENGTH, welcomeTextOf } from './welcome-text';

describe('welcomeTextOf', () => {
  it('is the default for null, undefined, empty and blank', () => {
    for (const none of [null, undefined, '', '   ']) expect(welcomeTextOf(none)).toBe(DEFAULT_WELCOME_TEXT);
  });

  it("is the tenant's own line, trimmed", () => {
    expect(welcomeTextOf('  Ask about our rooms and rates. ')).toBe('Ask about our rooms and rates.');
  });

  it('the default fits the bound and ends like a sentence', () => {
    expect(DEFAULT_WELCOME_TEXT.length).toBeLessThanOrEqual(MAX_WELCOME_TEXT_LENGTH);
    expect(DEFAULT_WELCOME_TEXT).toMatch(/[.!?]$/);
  });
});

describe('updateTenantSchema: welcomeText', () => {
  const parse = (welcomeText: unknown) => updateTenantSchema.safeParse({ welcomeText });

  it('takes a trimmed line, or null for the default', () => {
    const ok = parse('  Ask about our rooms. ');
    expect(ok.success && ok.data.welcomeText).toBe('Ask about our rooms.');
    expect(parse('x'.repeat(MAX_WELCOME_TEXT_LENGTH)).success).toBe(true);
    expect(parse(null).success).toBe(true);
  });

  it('refuses what Postgres would refuse, in words', () => {
    for (const bad of ['', '   ', 'x'.repeat(MAX_WELCOME_TEXT_LENGTH + 1), 5, ['Ask about our rooms.']]) {
      expect(parse(bad).success, JSON.stringify(bad).slice(0, 40)).toBe(false);
    }
  });
});
