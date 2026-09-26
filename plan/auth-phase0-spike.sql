-- auth-phase0-spike.sql — TEMPORARY helpers for auth-rls Phase 0 (plan/auth-rls.md § 2.1, § 3).
--
-- whoami() hands back whatever claims PostgREST verified and passed to
-- Postgres. If a token we signed comes back from this function, PostgREST
-- trusted our signature, which is the one question Phase 0 has to answer.
-- It reads nothing from any table, so leaving anon's default EXECUTE on it
-- exposes only the caller's own claims.
--
-- auth_explain() is tenancy_explain() again (plan/tenancy-phase2-explain.sql),
-- for the baseline `explain analyze` of match_chunks as service_role. Phase 2
-- will want the same plan as a tenant token, so it is kept until then.
--
-- Run once in the Supabase SQL editor. DROP both when Phase 2 is signed off
-- (the statements are at the bottom).

create or replace function whoami()
returns jsonb
language sql
stable
as $$ select auth.jwt() $$;

create or replace function auth_explain(query text)
returns setof text
language plpgsql
volatile
as $$
declare
  line text;
begin
  if query !~* '^\s*select\s' then
    raise exception 'auth_explain runs SELECT statements only';
  end if;
  -- match_chunks carries this setting on itself (schema-tenancy.sql), so its
  -- inlined body has to be measured with it too. Local to this transaction.
  perform set_config('hnsw.iterative_scan', 'strict_order', true);
  for line in execute 'explain (analyze, buffers, costs off, timing off) ' || query loop
    return next line;
  end loop;
end;
$$;

-- Supabase grants EXECUTE on new public functions to anon by default. This one
-- runs arbitrary SELECTs, so only service_role may call it.
revoke all     on function auth_explain(text) from public, anon, authenticated;
grant  execute on function auth_explain(text) to service_role;

notify pgrst, 'reload schema';

-- When auth-rls Phase 2 is signed off:
--   drop function whoami();
--   drop function auth_explain(text);
--   notify pgrst, 'reload schema';
