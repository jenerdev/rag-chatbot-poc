import { describe, expect, it } from 'vitest';
import { ASSISTANT_FAILED, errorBody, newRequestId, SERVER_FAILED } from './error-body';

// Audit S-3 / B-6 (D-158): what a failure tells the client.
const withStatus = (message: string, status: number) => Object.assign(new Error(message), { status });
const PROD = { openai: false, expose: false, requestId: 'abc12345' };

describe('errorBody', () => {
  it('passes a request status through with its own words', () => {
    for (const status of [400, 401, 403, 404, 409, 429]) {
      const mapped = errorBody(withStatus('taken on 2026-12-01: Garden Room is already confirmed', status), PROD);
      expect(mapped.status).toBe(status);
      expect(mapped.body).toEqual({ error: 'taken on 2026-12-01: Garden Room is already confirmed' });
    }
  });

  it('hides a Postgres message behind a fixed sentence and a ref, and logs it', () => {
    const pg = new Error('rate_allow: relation "public.rate_windows" does not exist');
    const mapped = errorBody(pg, PROD);
    expect(mapped.status).toBe(500);
    expect(mapped.body).toEqual({ error: `${SERVER_FAILED} (ref abc12345)`, requestId: 'abc12345' });
    expect(JSON.stringify(mapped.body)).not.toContain('rate_windows');
    expect(mapped.log).toBe('[error] 500 ref abc12345: rate_allow: relation "public.rate_windows" does not exist');
  });

  it('treats a 5xx-carrying or unknown status as the server failing', () => {
    expect(errorBody(withStatus('boom', 503), PROD).status).toBe(500);
    expect(errorBody(withStatus('boom', 418), PROD).status).toBe(500);
    expect(errorBody('a string was thrown', PROD).body.error).toBe(`${SERVER_FAILED} (ref abc12345)`);
    expect(errorBody(null, PROD).status).toBe(500);
  });

  it("makes EVERY OpenAI failure a 502 with the assistant's sentence, never its key or its 401/429", () => {
    const openai = { ...PROD, openai: true };
    for (const status of [400, 401, 404, 429, 500, 503]) {
      const mapped = errorBody(withStatus('Incorrect API key provided: sk-proj-****abcd (HTTP 401)', status), openai);
      expect(mapped.status).toBe(502);
      expect(mapped.body.error).toBe(`${ASSISTANT_FAILED} (ref abc12345)`);
      expect(JSON.stringify(mapped.body)).not.toContain('sk-');
      expect(mapped.log).toContain('sk-proj-****abcd');
    }
  });

  it('appends the real message outside production, for the developer', () => {
    const mapped = errorBody(new Error('column "x" does not exist'), { ...PROD, expose: true });
    expect(mapped.body.error).toBe(`${SERVER_FAILED} (ref abc12345) [dev: column "x" does not exist]`);
  });
});

describe('newRequestId', () => {
  it('is eight hex characters, different each time', () => {
    const a = newRequestId();
    expect(a).toMatch(/^[0-9a-f]{8}$/);
    expect(newRequestId()).not.toBe(a);
  });
});
