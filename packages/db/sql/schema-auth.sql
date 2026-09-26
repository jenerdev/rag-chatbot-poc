-- schema-auth.sql — auth-rls Phase 1: memberships, and the policies that make
-- Postgres enforce the tenant (plan/auth-rls.md § 1, § 3 Phase 1).
--
-- Run after schema.sql, schema-hybrid.sql, schema-tenancy.sql and
-- schema-bookings.sql, in the Supabase SQL editor. Idempotent: every step is
-- `if not exists`, `create or replace`, or a drop-then-create.
--
-- HARMLESS TO THE RUNNING APP. The app still talks to Postgres as
-- service_role, which bypasses RLS, so none of these policies apply to it
-- yet. They start to matter in Phase 3, when requests arrive with a tenant
-- token instead ({role: authenticated, tenant_id, sub?, app_admin?}, D-039).
--
-- The shape of every policy below: a missing claim is null, `x = null` is
-- never true, so everything defaults to DENY. Keep it that way.

-- 1. Who may administer which tenant. One role (decision 3): a row IS admin.
--    A user may belong to several tenants, which is why a staff token carries
--    the tenant as well as the user.
create table if not exists memberships (
  user_id    uuid        not null references auth.users(id) on delete cascade,
  tenant_id  bigint      not null references tenants(id)    on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, tenant_id)
);

-- "Which tenants is this user a member of" is the other lookup direction.
create index if not exists memberships_tenant_idx on memberships (tenant_id);

alter table memberships enable row level security;

-- 2. The two claim helpers.
--
-- The tenant the token speaks for. nullif() turns an empty claim into null
-- rather than a cast error.
create or replace function app_tenant_id() returns bigint
language sql stable
set search_path = ''
as $$ select nullif(auth.jwt() ->> 'tenant_id', '')::bigint $$;

-- Admin = the token says so AND the database agrees. A server bug that mints
-- app_admin for the wrong tenant still cannot write, because the membership
-- row for that tenant is not there.
--
-- security INVOKER, a deliberate deviation from the plan's § 1.2 sketch, which
-- said definer. D-042 limits definer to exactly two functions, and this one
-- does not need it: the memberships policy (step 3) already lets a user see
-- their own rows, which is all this reads. A chat token has no `sub`, so
-- auth.uid() is null and the answer is false, not an error (§ 2.4).
create or replace function app_is_admin() returns boolean
language sql stable
set search_path = ''
as $$
  select coalesce((auth.jwt() ->> 'app_admin')::boolean, false)
     and exists (
       select 1 from public.memberships m
       where m.user_id = auth.uid() and m.tenant_id = public.app_tenant_id()
     )
$$;

-- 3. The policies (plan § 1.3).
--
-- Every predicate calls the helpers as `(select public.app_tenant_id())`,
-- not bare. Wrapped in a sub-select, Postgres evaluates it ONCE per query as
-- an InitPlan, and the qual becomes `tenant_id = $1`: a plain comparison the
-- planner can use chunks_tenant_idx for. Bare, it is a function call per row,
-- which is the § 2.3 trap. Phase 2 measures this.
--
-- Write policies check BOTH the tenant and admin. app_is_admin() alone proves
-- "admin of the token's tenant". Without the tenant match too, that admin
-- could insert a row carrying ANOTHER tenant's id.
--
-- Policies name `to authenticated`. anon gets no policy, so it gets nothing.
-- service_role bypasses RLS.

-- tenants: NO policies at all, so no token reads the table directly. Pages
-- and chat resolve a slug through tenant_public() (step 5), whose column
-- list is the only way in. That is what keeps admin_key_hash out of reach.

-- documents: chat reads titles for the sources panel; admins add and delete.
drop policy if exists documents_read   on documents;
drop policy if exists documents_insert on documents;
drop policy if exists documents_delete on documents;
create policy documents_read on documents for select to authenticated
  using (tenant_id = (select public.app_tenant_id()));
create policy documents_insert on documents for insert to authenticated
  with check (tenant_id = (select public.app_tenant_id()) and (select public.app_is_admin()));
create policy documents_delete on documents for delete to authenticated
  using (tenant_id = (select public.app_tenant_id()) and (select public.app_is_admin()));

-- chunks: read by every search; inserted by ingest. No delete policy: chunks
-- go when their document goes, and FK cascades do not pass through RLS.
drop policy if exists chunks_read   on chunks;
drop policy if exists chunks_insert on chunks;
create policy chunks_read on chunks for select to authenticated
  using (tenant_id = (select public.app_tenant_id()));
create policy chunks_insert on chunks for insert to authenticated
  with check (tenant_id = (select public.app_tenant_id()) and (select public.app_is_admin()));

-- conversations, messages: the open chat reads and writes these, so a chat
-- token needs them. Tenant match only. There is no update or delete path.
drop policy if exists conversations_read   on conversations;
drop policy if exists conversations_insert on conversations;
create policy conversations_read on conversations for select to authenticated
  using (tenant_id = (select public.app_tenant_id()));
create policy conversations_insert on conversations for insert to authenticated
  with check (tenant_id = (select public.app_tenant_id()));

drop policy if exists messages_read   on messages;
drop policy if exists messages_insert on messages;
create policy messages_read on messages for select to authenticated
  using (tenant_id = (select public.app_tenant_id()));
create policy messages_insert on messages for insert to authenticated
  with check (tenant_id = (select public.app_tenant_id()));

-- tenant_applications, units, slots: read-only to tokens, seeded by SQL. The
-- tool description reads slot names; createBooking reads units and slots.
drop policy if exists tenant_applications_read on tenant_applications;
drop policy if exists units_read               on units;
drop policy if exists slots_read               on slots;
create policy tenant_applications_read on tenant_applications for select to authenticated
  using (tenant_id = (select public.app_tenant_id()));
create policy units_read on units for select to authenticated
  using (tenant_id = (select public.app_tenant_id()));
create policy slots_read on slots for select to authenticated
  using (tenant_id = (select public.app_tenant_id()));

-- bookings: ADMIN ONLY, reads included. The rows hold guest names and phones.
-- A chat token cannot read a single booking; it asks check_availability()
-- (step 4), which answers open/taken and nothing else (§ 2.5). Cancelling is
-- an update, so update needs both USING (which rows) and WITH CHECK (what
-- they may become).
drop policy if exists bookings_read   on bookings;
drop policy if exists bookings_insert on bookings;
drop policy if exists bookings_update on bookings;
create policy bookings_read on bookings for select to authenticated
  using (tenant_id = (select public.app_tenant_id()) and (select public.app_is_admin()));
create policy bookings_insert on bookings for insert to authenticated
  with check (tenant_id = (select public.app_tenant_id()) and (select public.app_is_admin()));
create policy bookings_update on bookings for update to authenticated
  using      (tenant_id = (select public.app_tenant_id()) and (select public.app_is_admin()))
  with check (tenant_id = (select public.app_tenant_id()) and (select public.app_is_admin()));

-- memberships: a user sees their own rows, which is what app_is_admin()
-- reads. Rows are added and removed by the CLI with service_role (Phase 5).
-- The revoke is belt and braces: with no write policy, writes are already
-- denied, but Supabase grants every privilege on new tables by default.
drop policy if exists memberships_read_own on memberships;
create policy memberships_read_own on memberships for select to authenticated
  using (user_id = (select auth.uid()));
revoke insert, update, delete on memberships from anon, authenticated;

-- 4. check_availability, rewritten (§ 2.5, D-042).
--
-- security DEFINER, so it runs as its owner and can see bookings, which a
-- chat token cannot. search_path = '' so a caller cannot put their own
-- `bookings` or `slot_range` in front of ours, and that is why every name
-- below is schema-qualified.
--
-- Because it bypasses RLS, it checks the tenant ITSELF: the p_tenant_id asked
-- about must be the token's tenant. `is distinct from` so a token with NO
-- tenant claim is refused too (`<>` against null would let it through).
-- service_role is let through, because the tools and today's app call it
-- that way, and they carry no tenant claim. Both service keys reach Postgres
-- as `role: service_role` in auth.jwt() (measured in Phase 1).
--
-- The body is otherwise unchanged from schema-bookings.sql, and it still
-- returns no guest data.
create or replace function check_availability (
  p_tenant_id bigint,
  p_from      date,
  p_to        date
)
returns table (
  booked_date date,
  unit        text,
  slot        text,
  status      text
)
language plpgsql stable
security definer
set search_path = ''
as $$
declare
  v_timezone text;
begin
  if coalesce(auth.jwt() ->> 'role', '') <> 'service_role'
     and p_tenant_id is distinct from public.app_tenant_id() then
    raise exception 'check_availability: tenant % is not the token''s tenant', p_tenant_id
      using errcode = 'insufficient_privilege';
  end if;
  if p_to < p_from then
    raise exception 'p_to (%) is before p_from (%)', p_to, p_from using errcode = 'invalid_parameter_value';
  end if;
  if p_to - p_from > 366 then
    raise exception 'A range of % days is too long; the limit is 366', p_to - p_from
      using errcode = 'invalid_parameter_value';
  end if;

  select config->>'timezone' into v_timezone
  from public.tenant_applications
  where tenant_id = p_tenant_id and application_key = 'bookings';
  if v_timezone is null then
    return;
  end if;

  return query
    select
      d::date,
      u.name,
      s.name,
      case when exists (
        select 1
        from public.bookings b
        where b.tenant_id = p_tenant_id
          and b.unit_id = u.id
          and b.status <> 'cancelled'
          and b.during && public.slot_range(d::date, s.start_time, s.duration, v_timezone)
      ) then 'taken' else 'open' end
    from generate_series(p_from, p_to, interval '1 day') as d
    cross join public.units u
    join public.slots s on s.tenant_id = u.tenant_id
    where u.tenant_id = p_tenant_id
    order by d, u.name, s.start_time, s.name;
end;
$$;

-- 5. tenant_public(slug): the only way a token reads a tenants row (D-042).
--
-- security DEFINER, because tenants has no policies. The column list IS the
-- security boundary: admin_key_hash is not in it, and nothing else can reach
-- the table. The server resolves a slug BEFORE it knows the tenant, so before
-- it can mint a token for it, which is why anon may call this one (plan
-- Phase 3 step 3). Everything returned is already shown on the public page.
create or replace function tenant_public(p_slug text)
returns table (
  id             bigint,
  slug           text,
  business_name  text,
  assistant_name text,
  logo_url       text,
  banner_url     text,
  theme          jsonb
)
language sql stable
security definer
set search_path = ''
as $$
  select t.id, t.slug, t.business_name, t.assistant_name, t.logo_url, t.banner_url, t.theme
  from public.tenants t
  where t.slug = p_slug
$$;

-- 6. EXECUTE grants.
--
-- Postgres grants EXECUTE to PUBLIC on every new function, and Supabase adds
-- anon and authenticated explicitly. So revoke from all three, then grant back
-- exactly who needs it. service_role is granted explicitly every time,
-- because revoking from PUBLIC must not take it away from the tools.
--
-- match_chunks and match_chunks_fts stay security INVOKER, so RLS on chunks
-- applies inside them, and they keep their p_tenant_id filter (Rule 1: two
-- walls). anon loses them: without a policy it could only ever get zero
-- rows from them, and now it cannot call them at all.
revoke all on function app_tenant_id()                                  from public, anon, authenticated;
revoke all on function app_is_admin()                                   from public, anon, authenticated;
revoke all on function check_availability(bigint, date, date)           from public, anon, authenticated;
revoke all on function tenant_public(text)                              from public, anon, authenticated;
revoke all on function match_chunks(vector, bigint, int, float)         from public, anon, authenticated;
revoke all on function match_chunks_fts(text, vector, bigint, int)      from public, anon, authenticated;

grant execute on function app_tenant_id()                               to authenticated, service_role;
grant execute on function app_is_admin()                                to authenticated, service_role;
grant execute on function check_availability(bigint, date, date)        to authenticated, service_role;
grant execute on function tenant_public(text)                           to anon, authenticated, service_role;
grant execute on function match_chunks(vector, bigint, int, float)      to authenticated, service_role;
grant execute on function match_chunks_fts(text, vector, bigint, int)   to authenticated, service_role;

-- 7. The shared admin key is gone (auth-rls Phase 6). Staff log in with
--    Supabase Auth and a membership (D-040). No code reads or writes this
--    column any more, and a column that holds nothing still has to be
--    guarded (`select('*')` would fetch it), so it is dropped, not kept.
--    schema-tenancy.sql still creates it on a fresh install; this removes it.
alter table tenants drop column if exists admin_key_hash;

-- PostgREST caches the schema: without this, memberships and tenant_public
-- stay invisible to .from() and .rpc() until the cache refreshes on its own.
notify pgrst, 'reload schema';

-- Verify:
--   pnpm --filter @rag/db verify     -- 28 + the Phase 1 checks
--   pnpm eval                        -- 18/19, the app is unchanged
