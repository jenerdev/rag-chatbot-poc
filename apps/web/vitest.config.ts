import { defineConfig } from 'vitest/config';

// Only the PURE lib files have unit tests here (permissions.ts, theme.ts):
// the ones a Client Component may import. Everything with `server-only` or a
// database behind it is covered by verify.mjs, the isolation suites and
// staff-cases.mjs, live.
export default defineConfig({
  test: { include: ['lib/**/*.test.ts'] },
});
