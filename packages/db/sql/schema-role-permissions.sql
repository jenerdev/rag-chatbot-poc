-- schema-role-permissions.sql — the 34th file (D-128): WHAT EACH ROLE MAY DO,
-- per tenant, set by a super user on the platform page; and the super user's
-- own door to a tenant's knowledge base.
--
-- Until now a role's permissions were ONE table for every tenant
-- (apps/web/lib/permissions.ts), asked again in SQL by app_is_admin() and
-- app_is_staff() (D-079). That table stays: it is the DEFAULT. A tenant may
-- now differ from it, permission by permission and role by role, in
-- `role_permissions`. "Only the platform adds documents; the owner only
-- reads them" is two rows: owner documents:write false, admin
-- documents:write false.
--
-- THE RULES
-- ---------
-- 1. Restricting is always possible: a role may lose any CONFIGURABLE
--    permission. Granting beyond the default is possible only for the
--    GRANTABLE ones, the permissions whose every write is a plain table
--    policy (documents, rooms, holidays, slots, promos). The rest are
--    asked inside SECURITY DEFINER functions or by triggers that name a
--    role, which a row here cannot reach; a grant there would be a promise
--    one wall keeps and the other breaks. FIXED permissions (session,
--    payments:write, payments:settings) are not configurable at all.
-- 2. One answer, two walls. app_can() below and can() in permissions.ts
--    compute the same thing from the same rows: the default, then the
--    tenant's row, then the grantable rule. permissions.test.ts reads this
--    file's default matrix and its two lists and checks they equal the
--    code's, value by value.
-- 3. The existing policies are NOT edited (trap 20: no older file needs a
--    guard). Each gains a RESTRICTIVE twin, ANDed with it: a member whose
--    role lost the permission here is refused even where the old policy
--    let the role in. A grantable permission also gains a PERMISSIVE twin,
--    ORed with the old one, which lets in the role it was granted to. For a
--    member, the effect is app_can() exactly. For every other token (a chat
--    token, a platform token) app_may() is true and the old policies decide,
--    as before.
-- 4. The super user (D-076) may now read, add and delete a tenant's
--    knowledge-base documents and chunks: the platform can be the only one
--    who adds them. Still no bookings, guests, messages or payments: D-076's
--    line moves for the knowledge base alone (D-128).
--
-- activity:read (D-138, schema-audit-log.sql, the 43rd file) is in the three
-- lists below as well, identically, so either file run last gives the same
-- functions (trap 25); permissions.test.ts reads THIS file.
--
-- Idempotent. Run after schema-features.sql (and so after every earlier file).

-- 1. The overrides. Absent = the default.
create table if not exists public.role_permissions (
  tenant_id  bigint      not null references public.tenants (id) on delete cascade,
  role       text        not null,
  permission text        not null,
  allowed    boolean     not null,
  updated_at timestamptz not null default now(),
  primary key (tenant_id, role, permission),
  constraint role_permissions_role check (role in ('owner', 'admin', 'staff'))
);
alter table public.role_permissions drop constraint if exists role_permissions_configurable;
alter table public.role_permissions add  constraint role_permissions_configurable check (permission in (
  'dashboard:read', 'documents:read', 'documents:write', 'bookings:read', 'bookings:write',
  'rooms:read', 'rooms:write', 'holidays:read', 'holidays:write', 'slots:read', 'slots:write',
  'promos:read', 'promos:write', 'payments:read', 'unanswered:read', 'unanswered:write',
  'conversations:read', 'members:manage', 'activity:read'
));

alter table public.role_permissions enable row level security;
revoke all on public.role_permissions from anon;
--    Any token of the tenant reads its rows: app_can() runs as the caller,
--    and the pages read them to hide what a role cannot do.
drop policy if exists role_permissions_read on public.role_permissions;
create policy role_permissions_read on public.role_permissions for select to authenticated
  using (tenant_id = (select public.app_tenant_id()));
drop policy if exists role_permissions_super_all on public.role_permissions;
create policy role_permissions_super_all on public.role_permissions for all to authenticated
  using      ((select public.app_is_super()))
  with check ((select public.app_is_super()));

-- 2. The defaults: permissions.ts's ROLE_PERMISSIONS, as rows.
create or replace function public.app_default_can(p_role text, p_permission text) returns boolean
language sql immutable
set search_path = ''
as $$
  select exists (
    select 1 from (values
      -- staff
      ('staff', 'session'), ('staff', 'dashboard:read'), ('staff', 'documents:read'), ('staff', 'bookings:read'),
      ('staff', 'bookings:write'), ('staff', 'payments:read'), ('staff', 'unanswered:read'), ('staff', 'unanswered:write'),
      ('staff', 'conversations:read'),
      -- admin: staff's, and the setup screens
      ('admin', 'session'), ('admin', 'dashboard:read'), ('admin', 'documents:read'), ('admin', 'bookings:read'),
      ('admin', 'bookings:write'), ('admin', 'payments:read'), ('admin', 'unanswered:read'), ('admin', 'unanswered:write'),
      ('admin', 'conversations:read'), ('admin', 'documents:write'), ('admin', 'rooms:read'), ('admin', 'rooms:write'),
      ('admin', 'holidays:read'), ('admin', 'holidays:write'), ('admin', 'slots:read'), ('admin', 'slots:write'),
      ('admin', 'promos:read'), ('admin', 'promos:write'), ('admin', 'payments:write'), ('admin', 'payments:settings'),
      -- owner: admin's, and the members
      ('owner', 'session'), ('owner', 'dashboard:read'), ('owner', 'documents:read'), ('owner', 'bookings:read'),
      ('owner', 'bookings:write'), ('owner', 'payments:read'), ('owner', 'unanswered:read'), ('owner', 'unanswered:write'),
      ('owner', 'conversations:read'), ('owner', 'documents:write'), ('owner', 'rooms:read'), ('owner', 'rooms:write'),
      ('owner', 'holidays:read'), ('owner', 'holidays:write'), ('owner', 'slots:read'), ('owner', 'slots:write'),
      ('owner', 'promos:read'), ('owner', 'promos:write'), ('owner', 'payments:write'), ('owner', 'payments:settings'),
      ('owner', 'members:manage'), ('owner', 'activity:read')
    ) d (role, permission)
    where d.role = p_role and d.permission = p_permission
  )
$$;

--    The permissions a row may GRANT beyond the default (rule 1).
create or replace function public.app_permission_grantable(p_permission text) returns boolean
language sql immutable
set search_path = ''
as $$
  select p_permission in (
    'documents:write', 'rooms:read', 'rooms:write', 'holidays:read', 'holidays:write',
    'slots:read', 'slots:write', 'promos:read', 'promos:write', 'activity:read'
  )
$$;

-- 3. The one question: may THIS member do that, in THIS tenant?
--    False for a token that is not a member's (no role). SECURITY INVOKER:
--    it reads role_permissions under the caller's token, whose read policy
--    is the tenant's own rows and calls nothing that reads this table back,
--    so there is no recursion.
create or replace function public.app_can(p_permission text) returns boolean
language sql stable
set search_path = ''
as $$
  with r as (select public.app_role() as role),
       o as (
         select p.allowed from public.role_permissions p, r
         where p.tenant_id = public.app_tenant_id() and p.role = r.role and p.permission = p_permission
       )
  select case
    when r.role is null then false
    when public.app_default_can(r.role, p_permission) then coalesce((select allowed from o), true)
    when public.app_permission_grantable(p_permission) then coalesce((select allowed from o), false)
    else false
  end
  from r
$$;

--    For the RESTRICTIVE policies: a member must be allowed; any other token
--    passes here and is judged by the old, permissive policies as before.
create or replace function public.app_may(p_permission text) returns boolean
language sql stable
set search_path = ''
as $$ select public.app_role() is null or public.app_can(p_permission) $$;

revoke all on function public.app_can(text), public.app_may(text) from public, anon;
grant execute on function public.app_can(text), public.app_may(text) to authenticated, service_role;

-- 4. Set a tenant's overrides in one statement: the platform form's Save.
--    Replaces every row of the tenant with the ones given (only the ones
--    that differ from the default are worth sending). SECURITY INVOKER: the
--    super policy on role_permissions is the guard, and this asks too.
create or replace function public.set_role_permissions(p_tenant_id bigint, p_rows jsonb) returns int
language plpgsql
set search_path = ''
as $$
declare
  v_count int;
begin
  if not public.app_is_super() then
    raise exception 'Only a super user sets role permissions.' using errcode = 'insufficient_privilege';
  end if;
  if jsonb_typeof(p_rows) is distinct from 'array' then
    raise exception 'The permissions are a list of { role, permission, allowed }.' using errcode = 'check_violation';
  end if;
  delete from public.role_permissions where tenant_id = p_tenant_id;
  insert into public.role_permissions (tenant_id, role, permission, allowed)
  select p_tenant_id, r->>'role', r->>'permission', (r->>'allowed')::boolean
  from jsonb_array_elements(p_rows) r;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;
revoke all on function public.set_role_permissions(bigint, jsonb) from public, anon;
grant execute on function public.set_role_permissions(bigint, jsonb) to authenticated;

-- 5. The restrictive twins (rule 3). One per table and command the role
--    policies guard, named <table>_may_<command>.
do $restrict$
declare
  t record;
begin
  for t in select * from (values
    ('documents',              'insert', 'documents:write'),
    ('documents',              'delete', 'documents:write'),
    ('documents',              'select', 'documents:read'),
    ('chunks',                 'insert', 'documents:write'),
    ('chunks',                 'select', 'documents:read'),
    ('bookings',               'select', 'bookings:read'),
    ('bookings',               'insert', 'bookings:write'),
    ('bookings',               'update', 'bookings:write'),
    ('stays',                  'select', 'bookings:read'),
    ('booking_events',         'select', 'bookings:read'),
    ('change_requests',        'select', 'bookings:read'),
    ('payments',               'select', 'payments:read'),
    ('unanswered_resolutions', 'select', 'unanswered:read'),
    ('unanswered_resolutions', 'insert', 'unanswered:write'),
    ('unanswered_resolutions', 'delete', 'unanswered:write'),
    ('promos',                 'insert', 'promos:write'),
    ('promos',                 'update', 'promos:write'),
    ('promos',                 'delete', 'promos:write'),
    ('slots',                  'insert', 'slots:write'),
    ('slots',                  'update', 'slots:write'),
    ('slots',                  'delete', 'slots:write'),
    ('rate_calendar',          'insert', 'holidays:write'),
    ('rate_calendar',          'update', 'holidays:write'),
    ('rate_calendar',          'delete', 'holidays:write'),
    ('units',                  'insert', 'rooms:write'),
    ('units',                  'update', 'rooms:write'),
    ('unit_rates',             'insert', 'rooms:write'),
    ('unit_rates',             'update', 'rooms:write'),
    ('unit_rates',             'delete', 'rooms:write'),
    ('unit_images',            'insert', 'rooms:write'),
    ('unit_images',            'update', 'rooms:write'),
    ('unit_images',            'delete', 'rooms:write'),
    ('memberships',            'insert', 'members:manage'),
    ('memberships',            'update', 'members:manage'),
    ('memberships',            'delete', 'members:manage')
  ) v (tbl, cmd, perm) loop
    execute format('drop policy if exists %I on public.%I', t.tbl || '_may_' || t.cmd, t.tbl);
    execute format(
      'create policy %I on public.%I as restrictive for %s to authenticated %s',
      t.tbl || '_may_' || t.cmd, t.tbl, t.cmd,
      case t.cmd
        when 'insert' then format('with check ((select public.app_may(%L)))', t.perm)
        when 'update' then format('using ((select public.app_may(%L))) with check ((select public.app_may(%L)))', t.perm, t.perm)
        else format('using ((select public.app_may(%L)))', t.perm)
      end);
  end loop;
end;
$restrict$;

--    NOT promos' SELECT: any member reads promos by design (the staff booking
--    form's picker, schema-promos.sql), while promos:read is the Promos
--    SCREEN, admin-only by default. A restrictive read on promos:read broke
--    that picker for staff (verify 198 found it); an earlier run of this
--    file made the policy, so it is dropped here.
drop policy if exists promos_may_select on public.promos;

--    Storage: a restrictive policy on storage.objects covers EVERY bucket,
--    so each names its own and passes the rest through.
drop policy if exists unit_images_objects_may_insert on storage.objects;
create policy unit_images_objects_may_insert on storage.objects as restrictive for insert to authenticated
  with check (bucket_id <> 'unit-images' or (select public.app_may('rooms:write')));
drop policy if exists unit_images_objects_may_delete on storage.objects;
create policy unit_images_objects_may_delete on storage.objects as restrictive for delete to authenticated
  using (bucket_id <> 'unit-images' or (select public.app_may('rooms:write')));
drop policy if exists payment_proofs_may_select on storage.objects;
create policy payment_proofs_may_select on storage.objects as restrictive for select to authenticated
  using (bucket_id <> 'payment-proofs' or (select public.app_may('payments:read')));

-- 6. The permissive twins of the GRANTABLE permissions (rule 1): the role a
--    tenant granted one to gets in. Named <table>_can_<command>.
do $grant$
declare
  t record;
begin
  for t in select * from (values
    ('documents',     'insert', 'documents:write'),
    ('documents',     'delete', 'documents:write'),
    ('chunks',        'insert', 'documents:write'),
    ('promos',        'insert', 'promos:write'),
    ('promos',        'update', 'promos:write'),
    ('promos',        'delete', 'promos:write'),
    ('slots',         'insert', 'slots:write'),
    ('slots',         'update', 'slots:write'),
    ('slots',         'delete', 'slots:write'),
    ('rate_calendar', 'insert', 'holidays:write'),
    ('rate_calendar', 'update', 'holidays:write'),
    ('rate_calendar', 'delete', 'holidays:write'),
    ('units',         'insert', 'rooms:write'),
    ('units',         'update', 'rooms:write'),
    ('unit_rates',    'insert', 'rooms:write'),
    ('unit_rates',    'update', 'rooms:write'),
    ('unit_rates',    'delete', 'rooms:write'),
    ('unit_images',   'insert', 'rooms:write'),
    ('unit_images',   'update', 'rooms:write'),
    ('unit_images',   'delete', 'rooms:write')
  ) v (tbl, cmd, perm) loop
    execute format('drop policy if exists %I on public.%I', t.tbl || '_can_' || t.cmd, t.tbl);
    execute format(
      'create policy %I on public.%I for %s to authenticated %s',
      t.tbl || '_can_' || t.cmd, t.tbl, t.cmd,
      case t.cmd
        when 'insert' then format('with check (tenant_id = (select public.app_tenant_id()) and (select public.app_can(%L)))', t.perm)
        when 'update' then format('using (tenant_id = (select public.app_tenant_id()) and (select public.app_can(%L))) with check (tenant_id = (select public.app_tenant_id()) and (select public.app_can(%L)))', t.perm, t.perm)
        else format('using (tenant_id = (select public.app_tenant_id()) and (select public.app_can(%L)))', t.perm)
      end);
  end loop;
end;
$grant$;

drop policy if exists unit_images_objects_can_insert on storage.objects;
create policy unit_images_objects_can_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'unit-images' and (storage.foldername(name))[1] = ((select public.app_tenant_id()))::text and (select public.app_can('rooms:write')));
drop policy if exists unit_images_objects_can_select on storage.objects;
create policy unit_images_objects_can_select on storage.objects for select to authenticated
  using (bucket_id = 'unit-images' and (storage.foldername(name))[1] = ((select public.app_tenant_id()))::text and (select public.app_can('rooms:write')));
drop policy if exists unit_images_objects_can_delete on storage.objects;
create policy unit_images_objects_can_delete on storage.objects for delete to authenticated
  using (bucket_id = 'unit-images' and (storage.foldername(name))[1] = ((select public.app_tenant_id()))::text and (select public.app_can('rooms:write')));

-- 7. The super user's door to the knowledge base (rule 4). The platform
--    names the tenant in every query (wall 1); these let the platform token,
--    which has no tenant claim, reach the rows at all (wall 2 asks for the
--    platform_admins row, app_is_super()). The chunk's composite foreign key
--    still refuses a chunk whose tenant is not its document's.
drop policy if exists documents_super_all on public.documents;
create policy documents_super_all on public.documents for all to authenticated
  using ((select public.app_is_super())) with check ((select public.app_is_super()));
drop policy if exists chunks_super_all on public.chunks;
create policy chunks_super_all on public.chunks for all to authenticated
  using ((select public.app_is_super())) with check ((select public.app_is_super()));

notify pgrst, 'reload schema';
