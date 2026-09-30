-- schema-suggested-questions.sql — a tenant's suggested questions (D-089).
--
-- Run AFTER schema-day-price.sql. Safe to re-run.
--
-- Up to six short questions a visitor can click on a new, empty chat; the
-- click sends the question at once. Set by a super user on the platform
-- tenant form, beside the fallback messages, and read by the chat through
-- tenant_public(), like every other thing a visitor sees about a tenant.
--
-- It REPLACES tenant_public() from schema-roles.sql § 5, whose `create or
-- replace` would now fail on the changed return type. That step is guarded
-- on this column (CLAUDE.md trap 20). schema-auth.sql's older definition is
-- already guarded on platform_admins.

-- 1. The column. Null = no suggestions, the chat as it was.
alter table tenants add column if not exists suggested_questions jsonb;

-- 2. The shape, enforced by Postgres: an array of 1 to 6 strings, each 1 to
--    120 characters. A check cannot hold a subquery, so the test is an
--    immutable function (it reads nothing but its argument).
create or replace function public.suggested_questions_ok(p jsonb)
returns boolean
language sql immutable
set search_path = ''
as $$
  select jsonb_typeof(p) = 'array'
     and jsonb_array_length(p) between 1 and 6
     and not exists (
       select 1 from jsonb_array_elements(p) as e(q)
        where jsonb_typeof(e.q) <> 'string'
           or char_length(e.q #>> '{}') not between 1 and 120
     )
$$;

alter table tenants drop constraint if exists tenants_suggested_questions_shape;
alter table tenants add  constraint tenants_suggested_questions_shape check (
  suggested_questions is null or public.suggested_questions_ok(suggested_questions)
);

-- 3. tenant_public(), with the column. Its return type changes, so it is
--    dropped and re-created: the same body, still security definer, still
--    search_path = '', still no archived tenant. Its column list is the
--    boundary of what a token may read about a tenant (auth-rls § 1.3), and
--    suggested questions are meant for every visitor.
drop function if exists public.tenant_public(text);
create function public.tenant_public(p_slug text)
returns table (
  id                  bigint,
  slug                text,
  business_name       text,
  assistant_name      text,
  logo_url            text,
  banner_url          text,
  theme               jsonb,
  fallback_messages   jsonb,
  suggested_questions jsonb
)
language sql stable
security definer
set search_path = ''
as $$
  select t.id, t.slug, t.business_name, t.assistant_name, t.logo_url, t.banner_url, t.theme, t.fallback_messages,
         t.suggested_questions
  from public.tenants t
  where t.slug = p_slug and t.archived_at is null
$$;

-- 4. A dropped function loses its grants: re-applied as schema-roles.sql had them.
revoke all on function public.tenant_public(text) from public, anon, authenticated;
grant execute on function public.tenant_public(text) to anon, authenticated, service_role;
revoke all on function public.suggested_questions_ok(jsonb) from public, anon;
grant execute on function public.suggested_questions_ok(jsonb) to authenticated, service_role;

-- PostgREST caches the schema: without this the new column and return type
-- stay invisible to .from() and .rpc().
notify pgrst, 'reload schema';
