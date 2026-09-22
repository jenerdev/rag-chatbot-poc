-- tenancy-phase2-explain.sql — a TEMPORARY measurement helper for tenancy Phase 2.
--
-- Phase 2 needs `explain analyze` output, and the service-role REST API cannot
-- run arbitrary SQL. This function lets verify-style scripts ask Postgres for a
-- query plan over .rpc(), with the planner settings the measurement needs.
--
-- It is locked down on purpose:
--   * SELECT statements only. It refuses anything else before it runs.
--   * EXECUTE is revoked from public, anon and authenticated. Supabase grants
--     execute on public functions to anon by default, so without the revoke,
--     anyone holding the publishable key could run it.
--   * Settings are applied with set_config(..., true), so they last only for
--     the one request's transaction.
--
-- Run it once in the Supabase SQL editor. DROP IT when Phase 2 is signed off
-- (the statement is at the bottom).

create or replace function tenancy_explain(
  query      text,
  seqscan    boolean default true,     -- false = make the planner avoid a Seq Scan
  iterative  text    default 'off',    -- hnsw.iterative_scan: off | strict_order | relaxed_order
  ef_search  int     default 40        -- hnsw.ef_search, pgvector's default is 40
)
returns setof text
language plpgsql
volatile
as $$
declare
  line text;
begin
  if query !~* '^\s*select\s' then
    raise exception 'tenancy_explain runs SELECT statements only';
  end if;

  perform set_config('enable_seqscan',      case when seqscan then 'on' else 'off' end, true);
  perform set_config('hnsw.iterative_scan', iterative,        true);
  perform set_config('hnsw.ef_search',      ef_search::text,  true);

  for line in execute 'explain (analyze, buffers, costs off, timing off) ' || query loop
    return next line;
  end loop;
end;
$$;

revoke all     on function tenancy_explain(text, boolean, text, int) from public, anon, authenticated;
grant  execute on function tenancy_explain(text, boolean, text, int) to service_role;

notify pgrst, 'reload schema';

-- When Phase 2 is signed off:
--   drop function tenancy_explain(text, boolean, text, int);
--   notify pgrst, 'reload schema';
