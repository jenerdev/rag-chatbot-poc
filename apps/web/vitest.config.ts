import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Only the PURE lib files have unit tests here (permissions.ts, theme.ts,
// tables.ts): the ones a Client Component may import. Everything with
// `server-only` or a database behind it is covered by verify.mjs, the
// isolation suites and staff-cases.mjs, live.
//
// `@/` is tsconfig's alias; vitest does not read tsconfig paths, so the one
// component test (reply-text.test.ts, which imports a component that imports
// `@/lib/tables`) needs it spelled out here.
export default defineConfig({
  // Next compiles JSX with the automatic runtime (no `import React`); esbuild
  // under vitest defaults to the classic one and asks for React in scope.
  esbuild: { jsx: 'automatic' },
  resolve: { alias: { '@': fileURLToPath(new URL('.', import.meta.url)) } },
  test: { include: ['lib/**/*.test.ts'] },
});
