-- auth-phase2-explain.sql — TEMPORARY helpers for auth-rls Phase 2 (plan/auth-rls.md § 2.3).
--
-- Phase 2 asks one question: do the RLS policies change the plan of a
-- search? Answering it needs the SAME query explained twice: once as
-- service_role, which bypasses RLS, and once as a tenant token, where the
-- policies apply. Measuring only as service_role measures nothing (§ 2.3).
--
-- auth_explain(query, seqscan) replaces Phase 0's one-argument version, as
-- service_role only. auth_explain_token(query, seqscan) is the same body,
-- callable by `authenticated`, so the policies apply to what it explains.
--
-- Why a second function rather than a role switch: a security-definer
-- function cannot `set role`, and service_role cannot switch to
-- authenticated. So the token has to make the call itself.
--
-- The token side is guarded twice:
--   * it refuses unless the token carries `app_explain: true`. Only our
--     signer can mint that claim, and no real chat or staff token has it;
--   * it is security INVOKER, so everything it explains runs under the
--     caller's RLS. It can show a plan only over rows the token may read
--     anyway. `explain analyze` really executes the query, so SELECT only.
--
-- Run once in the SQL editor. DROP BOTH when Phase 2 is signed off (bottom).

drop function if exists auth_explain(text);

create or replace function auth_explain(query text, seqscan boolean default true)
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
  -- The same setting match_chunks carries on itself (schema-tenancy.sql).
  perform set_config('hnsw.iterative_scan', 'strict_order', true);
  -- false = make the planner avoid a Seq Scan, to see whether the index is
  -- still USABLE under RLS, not only whether it is chosen at 34 rows.
  perform set_config('enable_seqscan', case when seqscan then 'on' else 'off' end, true);
  for line in execute 'explain (analyze, buffers, costs off, timing off) ' || query loop
    return next line;
  end loop;
end;
$$;

create or replace function auth_explain_token(query text, seqscan boolean default true)
returns setof text
language plpgsql
volatile
as $$
declare
  line text;
begin
  if coalesce((auth.jwt() ->> 'app_explain')::boolean, false) is not true then
    raise exception 'auth_explain_token needs a token minted with app_explain'
      using errcode = 'insufficient_privilege';
  end if;
  if query !~* '^\s*select\s' then
    raise exception 'auth_explain_token runs SELECT statements only';
  end if;
  perform set_config('hnsw.iterative_scan', 'strict_order', true);
  perform set_config('enable_seqscan', case when seqscan then 'on' else 'off' end, true);
  for line in execute 'explain (analyze, buffers, costs off, timing off) ' || query loop
    return next line;
  end loop;
end;
$$;

revoke all     on function auth_explain(text, boolean)       from public, anon, authenticated;
grant  execute on function auth_explain(text, boolean)       to service_role;
revoke all     on function auth_explain_token(text, boolean) from public, anon, authenticated;
grant  execute on function auth_explain_token(text, boolean) to authenticated;

notify pgrst, 'reload schema';

-- When auth-rls Phase 2 is signed off (with Phase 0's whoami):
--   drop function auth_explain(text, boolean);
--   drop function auth_explain_token(text, boolean);
--   drop function whoami();
--   notify pgrst, 'reload schema';
