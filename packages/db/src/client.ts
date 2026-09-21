// @rag/db — one configured client, exported. Nothing else.
//
// No query logic lives here. Keeping this package to a single responsibility
// means every database call in the project is visible at its call site in
// @rag/pipeline, rather than hidden behind wrapper functions.

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

// The SERVICE ROLE key, not the anon key (D-006).
//
// service_role bypasses Row Level Security entirely. That is what this server
// needs — it is the only client of the database and there is no auth to derive
// permissions from. It is also why this key must NEVER reach the browser: it is
// effectively a master key to the whole database (risks.md § R-2).
//
// RLS is enabled on all four tables with no policies, so the anon key can do
// nothing at all. If you ever paste the wrong key into .env, every query will
// fail loudly with a policy error rather than half-working.
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
