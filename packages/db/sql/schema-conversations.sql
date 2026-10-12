-- schema-conversations.sql — the staff list of a tenant's chats (plan/conversations.md, D-115).
--
-- Run after schema-staff-terms.sql. Idempotent. The 28th file. No table, no
-- column, no policy, no row written (plan Rule 1): ONE read that groups the
-- messages a tenant already holds into one row per conversation.
--
--   conversation_list(p_tenant_id, p_days, p_query, p_refused, p_before_at,
--   p_before_id, p_limit)  security INVOKER: it reads under the RLS the
--     caller's token already has. A chat token may read every message of its
--     tenant by policy (messages_read, schema-auth.sql), so the function
--     refuses any caller that is not a MEMBER of that tenant (app_is_staff()),
--     exactly as tenant_dashboard() does (plan Rule 2). service_role is
--     allowed, for the tools.
--
-- Why a function and not PostgREST: a turn count, a refusal count and the
-- first question per conversation are aggregates, which PostgREST does not
-- do by default; in JS they would read every message of the window (§ 2b.1).
--
-- What it lists: conversations with at least one message (an empty one, left
-- by a failed first turn, is not a chat anyone had; § 2b.2), whose LAST
-- message falls in the window, newest activity first. The window starts at
-- the tenant's local midnight (trap 9), from tenant_applications.config,
-- Asia/Manila for a tenant without bookings: the dashboard's rule. p_days is
-- 7, 30 or 90; anything else is 30.
--
-- A refusal is the exact NO_ANSWER marker (D-045, D-047), the same definition
-- as Unanswered and the dashboard. p_query matches any message of the
-- conversation, the visitor's or the assistant's, case-insensitively; its
-- `%`, `_` and `\` are escaped, so a search is never a pattern (§ 2b.3).
--
-- Paged by keyset on (last_at, id): the previous page's last row is passed
-- back, so a page never repeats or skips a row when new chats arrive.
--
-- Every name qualified (trap 19). Nothing here is the chat's: no prompt, no
-- tool (plan Rule 4).

create or replace function conversation_list(
  p_tenant_id bigint,
  p_days      int         default 30,
  p_query     text        default null,
  p_refused   boolean     default false,
  p_before_at timestamptz default null,
  p_before_id uuid        default null,
  p_limit     int         default 25
)
returns jsonb
language plpgsql stable
set search_path = ''
as $$
declare
  v_service  boolean := coalesce(auth.jwt() ->> 'role', '') = 'service_role';
  v_days     int := case when p_days in (7, 30, 90) then p_days else 30 end;
  v_limit    int := least(greatest(coalesce(p_limit, 25), 1), 100);
  v_marker   constant text := 'I don''t know based on the documents I have.';
  v_pattern  text;
  v_timezone text;
  v_from_ts  timestamptz;
  v_total    int;
  v_rows     jsonb;
begin
  if not v_service and (p_tenant_id is distinct from public.app_tenant_id() or not public.app_is_staff()) then
    raise exception 'conversation_list: not a member of tenant %', p_tenant_id using errcode = 'insufficient_privilege';
  end if;

  select coalesce(a.config->>'timezone', 'Asia/Manila') into v_timezone
  from public.tenant_applications a
  where a.tenant_id = p_tenant_id and a.application_key = 'bookings';
  v_timezone := coalesce(v_timezone, 'Asia/Manila');
  v_from_ts  := (((now() at time zone v_timezone)::date - v_days + 1)::timestamp at time zone v_timezone);

  if nullif(btrim(p_query), '') is not null then
    v_pattern := '%' || replace(replace(replace(btrim(p_query), '\', '\\'), '%', '\%'), '_', '\_') || '%';
  end if;

  -- ONE statement: every conversation of this tenant whose last message is
  -- in the window; the filters; the count before paging (the header's "N
  -- conversations": a window count over the filtered rows, taken before the
  -- keyset cuts the page); then the page, with each conversation's first
  -- question. One row more than the page is read, so `more` is known without
  -- a second count. tenant_id is named on every read, as well as by RLS
  -- (rule 6: each wall must hold alone).
  with agg as (
    select m.conversation_id as id,
           min(m.created_at) as started_at,
           max(m.created_at) as last_at,
           (count(*) filter (where m.role = 'user'))::int as turns,
           (count(*) filter (where m.role = 'assistant' and m.content = v_marker))::int as refusals
    from public.messages m
    where m.tenant_id = p_tenant_id
    group by m.conversation_id
    having max(m.created_at) >= v_from_ts
  ),
  filtered as (
    select a.*, count(*) over () as total
    from agg a
    where (not coalesce(p_refused, false) or a.refusals > 0)
      and (v_pattern is null or exists (
            select 1 from public.messages s
            where s.tenant_id = p_tenant_id and s.conversation_id = a.id and s.content ilike v_pattern))
  ),
  page as (
    select f.*
    from filtered f
    where p_before_at is null or (f.last_at, f.id) < (p_before_at, p_before_id)
    order by f.last_at desc, f.id desc
    limit v_limit + 1
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', p.id,
           'startedAt', p.started_at,
           'lastAt', p.last_at,
           'turns', p.turns,
           'refusals', p.refusals,
           'firstQuestion', q.first_question
         ) order by p.last_at desc, p.id desc), '[]'::jsonb),
         coalesce(max(p.total), 0)::int
  into v_rows, v_total
  from page p
  left join lateral (
    select left(u.content, 200) as first_question
    from public.messages u
    where u.tenant_id = p_tenant_id and u.conversation_id = p.id and u.role = 'user'
    order by u.id
    limit 1
  ) q on true;

  -- `total` is the filtered count. A page past the end has no row to carry
  -- it and says 0, so the screen keeps the first page's.
  return jsonb_build_object(
    'timezone', v_timezone,
    'days', v_days,
    'total', v_total,
    'more', jsonb_array_length(v_rows) > v_limit,
    'rows', case when jsonb_array_length(v_rows) > v_limit then v_rows - v_limit else v_rows end
  );
end;
$$;

-- EXECUTE: revoke from all three, grant back exactly who needs it.
revoke all on function conversation_list(bigint, int, text, boolean, timestamptz, uuid, int) from public, anon, authenticated;
grant execute on function conversation_list(bigint, int, text, boolean, timestamptz, uuid, int) to authenticated, service_role;
