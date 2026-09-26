// @rag/db/service — the client that BYPASSES Row Level Security.
//
// Imported ONLY by tools/ scripts: migrations-adjacent setup, fixtures, the
// member CLI, and the checks that need to see past RLS to compare. Since
// auth-rls Phase 3, requests never use it. They use a token-scoped client
// (`scopedClient`, in the main entry point), and Postgres enforces the tenant.
// That is why this is a separate entry point: `import { supabase } from
// '@rag/db'` no longer compiles, and `@rag/db/service` under apps/ or
// packages/*/src is something a grep can find (plan/auth-rls.md Rule 2).
//
// The one exception until auth-rls Phase 6 is apps/web/lib/admin-auth.ts. It
// reads tenants.admin_key_hash, which no token can reach by design, and the
// admin key it checks is removed in Phase 6.

// ⚠️ THE GUARD. This import is the whole reason this is a separate package.
//
// In the POC, keeping the service_role key out of the browser was easy: the key
// lived in a Node process that had no way to reach a client. Next.js removes
// that guarantee — one Client Component importing this file, directly or
// through a barrel that re-exports both halves of an app, and the key is
// inlined into a JavaScript bundle and served to everybody who loads the page.
//
// `server-only` resolves to an empty module under the `react-server` condition
// and to a module that throws under every other. So a Server Component imports
// this happily, and a Client Component fails **at build time**, with a message
// naming the problem, rather than shipping.
//
// The cost, which is real and was measured rather than assumed: a plain Node
// process has no `react-server` condition either, so any script importing this
// package must run with `node --conditions=react-server`. That is why the eval
// and score tools carry that flag. A flag on four scripts is a smaller price
// than a master key in a bundle.
import 'server-only';

import { createClient } from '@supabase/supabase-js';
import type { Database } from './database.types.js';

// The SERVICE ROLE key (D-006, superseded for requests by D-039).
//
// service_role bypasses Row Level Security entirely. That is what setup tools
// need, and it is why this key must NEVER reach the browser: it is effectively
// a master key to the whole database (risks.md § R-2).
export const supabase = createClient<Database>(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  {
    auth: {
      // There is no user session here — this is a server talking to a database.
      persistSession: false,
      autoRefreshToken: false,
    },
  },
);
