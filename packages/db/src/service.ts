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
import { staffClient } from './staff-auth.js';
import type { DbClient } from './tenant-client.js';

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

// ---------------------------------------------------------------------------
// The tools' OPERATOR member (plan/auth-rls.md § 2.7).
//
// The eval seeds bookings and the isolation suites ingest a probe document.
// That is staff work, and the app does staff work with a staff token. So the
// tools do too, as a real member with a documented address, not by quietly
// keeping service_role for it. Create one per tenant with
//
//     pnpm --filter @rag/db member:operator -- <slug>
//
// The account has a random password that is never printed or used. The tools
// mint its staff token directly, the same way requireAdmin() does.

/** The operator's email for a tenant. `example.com` is reserved, so no mail ever goes to it. */
export const operatorEmail = (slug: string) => `rag-operator+${slug}@example.com`;

/** A user's id by email, through the admin API, or null. */
export async function userIdByEmail(email: string): Promise<string | null> {
  const wanted = email.toLowerCase();
  for (let page = 1; ; page++) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw new Error(`Could not list users: ${error.message}`);
    const found = data.users.find((user) => user.email?.toLowerCase() === wanted);
    if (found) return found.id;
    if (data.users.length < 1000) return null;
  }
}

/**
 * The same tenant, acting as its operator member: a STAFF context, under RLS
 * and app_is_admin(). Throws, with the command to fix it, when there is no
 * operator member.
 */
export async function asOperator<T extends { id: number; slug: string }>(tenant: T): Promise<T & { db: DbClient }> {
  const userId = await userIdByEmail(operatorEmail(tenant.slug));
  const db = userId ? await staffClient(tenant.id, userId) : null;
  if (!db) {
    throw new Error(`No operator member for "${tenant.slug}". Run: pnpm --filter @rag/db member:operator -- ${tenant.slug}`);
  }
  return { ...tenant, db };
}
