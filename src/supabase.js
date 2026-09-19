// src/supabase.js — one configured client, exported. Nothing else.
//
// No query logic lives here. Keeping this file to a single responsibility means
// every database call in the project is visible at its call site in rag.js,
// rather than hidden behind wrapper functions.

import { createClient } from '@supabase/supabase-js';

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
export const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  {
    auth: {
      // There is no user session here — this is a server talking to a database.
      persistSession: false,
      autoRefreshToken: false,
    },
  },
);
