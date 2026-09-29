import { defineConfig } from 'vitest/config';

// `server-only` resolves to an empty module under the `react-server` condition
// and to a module that THROWS under every other (packages/db/src/service.ts
// explains why). Node scripts carry `--conditions=react-server` for it
// (CLAUDE.md rule 4); vitest gets the same condition here, so a test can
// import tenant-client.ts without the guard firing.
export default defineConfig({
  resolve: { conditions: ['react-server'] },
  test: { include: ['src/**/*.test.ts'] },
});
