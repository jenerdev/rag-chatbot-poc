import 'server-only';

// Fail fast on missing config.
//
// The POC did this in `server.js` just before `app.listen()`: one place, run
// once, at a moment that obviously existed. Next has no such moment — there is
// no single boot function, and a route handler is not evaluated until someone
// requests it.
//
// So the check lives in module scope here, and every route imports `ENV` from
// it. The first import throws, which surfaces the same one-line message it
// always did rather than a confusing 401 twenty minutes later while debugging
// something else (architecture.md § 8).

const REQUIRED = [
  'OPENAI_API_KEY',
  'OPENAI_CHAT_MODEL',
  'OPENAI_EMBEDDING_MODEL',
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  // Signs the admin session cookie (lib/admin-auth.ts). Without it, no admin
  // could ever log in, so a missing one gets the same one-clear-sentence
  // treatment as a missing API key.
  'ADMIN_COOKIE_SECRET',
] as const;

const missing = REQUIRED.filter((name) => !process.env[name]);

const MESSAGE =
  `Missing required environment variable(s): ${missing.join(', ')}. ` +
  'Copy .env.example to .env and fill it in.';

// Logged at import, which is the closest thing Next has to the POC's boot.
if (missing.length > 0) console.error(MESSAGE);

/**
 * Throw if config is missing. Called by `withRoute` before every handler.
 *
 * NOT a throw at module scope, though that was the first version and it looked
 * more like the POC's `process.exit(1)`. The problem showed up the moment it
 * was tested: a module that throws while loading never finishes loading, so the
 * handler it exports never exists, so `withRoute` never runs and the client
 * gets Next's generic 500 HTML page. The real message reached the server log
 * and nothing else — which is precisely the "no generic something went wrong"
 * that architecture.md § 9 rules out.
 *
 * So the check runs at import (one line in the log, immediately, as § 8 wants)
 * and throws per request (the real message reaches the client, as § 9 wants).
 */
export function assertEnv(): void {
  if (missing.length > 0) throw new Error(MESSAGE);
}

/**
 * The validated config.
 *
 * Exported as values rather than read from `process.env` at each call site, so
 * that the check above cannot be bypassed by a module that forgets to import
 * this one. Note the pipeline still reads the two model names from the
 * environment on every call — deliberately, so that editing .env takes effect
 * without a rebuild (D-005).
 */
export const ENV = {
  OPENAI_API_KEY: process.env.OPENAI_API_KEY!,
  OPENAI_CHAT_MODEL: process.env.OPENAI_CHAT_MODEL!,
  OPENAI_EMBEDDING_MODEL: process.env.OPENAI_EMBEDDING_MODEL!,
  SUPABASE_URL: process.env.SUPABASE_URL!,
} as const;
