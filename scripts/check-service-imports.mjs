// check-service-imports.mjs — plan/auth-rls.md Rule 2, enforced.
//
// `@rag/db/service` is the client that BYPASSES Row Level Security. Requests
// must never hold it: they reach Postgres as a tenant token, and RLS is the
// second wall behind every tenant_id filter. Before this check, that rule
// was a grep someone had to remember to run. Now `pnpm typecheck` runs it
// first, and a single import of it under apps/ or packages/*/src fails.
//
// tools/ directories are allowed, and are the point of the entry point:
// fixtures, probe tenants, the member CLI, and checks that must see past RLS
// to compare against it.
//
// Zero dependencies and no parser. An import is a `from '…'`, an `import('…')`
// or a `require('…')` naming the specifier. Lines that are comments are
// skipped, because the docs mention the entry point by name on purpose.
//
//   node scripts/check-service-imports.mjs

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const SOURCE = /\.(ts|tsx|js|jsx|mjs|cjs)$/;
const SKIP = new Set(['node_modules', '.next', 'dist', '.turbo', 'tools']);

// `@rag/db/service`, or, inside packages/db/src itself, `./service(.js)`.
const FROM_ANYWHERE = /(?:from\s*|import\s*\(\s*|require\s*\(\s*)['"]@rag\/db\/service['"]/;
const FROM_INSIDE_DB = /(?:from\s*|import\s*\(\s*|require\s*\(\s*)['"]\.\/service(?:\.js)?['"]/;

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* walk(path);
    else if (SOURCE.test(name)) yield path;
  }
}

const roots = [join(ROOT, 'apps')];
for (const pkg of readdirSync(join(ROOT, 'packages'))) {
  const src = join(ROOT, 'packages', pkg, 'src');
  try {
    if (statSync(src).isDirectory()) roots.push(src);
  } catch {
    // a package without src/ (tsconfig) has nothing to check
  }
}

const hits = [];
for (const root of roots) {
  for (const file of walk(root)) {
    const insideDb = file.includes(join('packages', 'db', 'src'));
    // service.ts may import what it needs; it is the entry point itself.
    if (insideDb && file.endsWith(join('src', 'service.ts'))) continue;
    readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .forEach((line, index) => {
        const code = line.trim();
        if (code.startsWith('//') || code.startsWith('*') || code.startsWith('/*')) return;
        if (FROM_ANYWHERE.test(line) || (insideDb && FROM_INSIDE_DB.test(line))) {
          hits.push(`${relative(ROOT, file)}:${index + 1}: ${code}`);
        }
      });
  }
}

if (hits.length > 0) {
  console.error('check-service-imports: the RLS-bypassing client is imported where requests run (auth-rls Rule 2):');
  for (const hit of hits) console.error(`  ${hit}`);
  console.error('Requests use tenant.db (a token-scoped client). @rag/db/service is for tools/ only.');
  process.exitCode = 1;
} else {
  console.log(`check-service-imports: OK — no @rag/db/service import under apps/ or packages/*/src (${roots.length} roots).`);
}
