-- schema-audit-log.sql — the 43rd file (D-138, plan/audit-log.md): WHO DID
-- WHAT, as staff and as a super user, kept in Postgres.
--
-- Bookings have had a log since D-104: booking_events, written by triggers,
-- shown as a stay's History. Nothing else had one: a document deleted, a
-- rate changed, a member promoted, a feature switched off, a login, each
-- was a console line the dev server printed and nobody kept (R-13). This
-- file adds ONE append-only table, audit_log, filled by Postgres itself.
--
-- THE RULES (plan § 0)
-- --------------------
-- 1. Postgres writes the log, never a route. audit_log has NO insert, update
--    or delete policy for any token. Rows come from audit_row(), ONE trigger
--    function on every table a staff or platform token may change, and from
--    audit_note(), a definer that writes exactly three named actions (login,
--    logout, proof_opened) for a caller that has a user id. A route cannot
--    forget to log, and cannot log in another actor's name: the actor is
--    auth.uid() at the moment of the write.
-- 2. One event, one table. The trigger is NOT on bookings, stays, payments,
--    change_requests or booking_events: a stay's log is booking_events, and
--    no guest's name, phone, email or amount enters this table.
--    activity_list() reads both sources into one list, never the note.
-- 3. The log holds what changed, not what it was: the table, the operation,
--    the row's key, a label, the NAMES of the changed columns, and the
--    before/after of a SHORT allowlist per table (v_keep in audit_row()).
--    Never a document's content, a chunk, a note's body, a push
--    subscription, a key hash. A column not in the allowlist is logged as
--    changed, by name, and nothing more.
-- 4. Two walls, and the reader is checked twice. The read policy: the
--    tenant's rows with activity:read, every row for a super user. The
--    function is security INVOKER (reads under that policy) and ALSO raises
--    insufficient_privilege for a caller without the permission, as
--    conversation_list() does.
-- 5. The chatbot does not change: nothing here is read by a prompt or a tool.
--
-- app_default_can(), app_permission_grantable() and role_permissions_configurable
-- are RE-DEFINED here with activity:read added, IDENTICAL to the text now in
-- schema-role-permissions.sql (edited the same day), so either file run last
-- gives the same function (trap 25) and permissions.test.ts, which reads the
-- 34th file, still pins the code to SQL.
--
-- Idempotent. Run after schema-rate-limit.sql (and so after every earlier file).

-- 1. The permission (D-128's two lists, and the matrix). activity:read is an
--    OWNER's by default and GRANTABLE: its only write-side is the policy below,
--    which a tenant's row reaches.
alter table public.role_permissions drop constraint if exists role_permissions_configurable;
alter table public.role_permissions add  constraint role_permissions_configurable check (permission in (
  'dashboard:read', 'documents:read', 'documents:write', 'bookings:read', 'bookings:write',
  'rooms:read', 'rooms:write', 'holidays:read', 'holidays:write', 'slots:read', 'slots:write',
  'promos:read', 'promos:write', 'payments:read', 'unanswered:read', 'unanswered:write',
  'conversations:read', 'members:manage', 'activity:read', 'sources:read'
));

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
      ('admin', 'sources:read'),
      -- owner: admin's, the members, and the activity log (D-138)
      ('owner', 'session'), ('owner', 'dashboard:read'), ('owner', 'documents:read'), ('owner', 'bookings:read'),
      ('owner', 'bookings:write'), ('owner', 'payments:read'), ('owner', 'unanswered:read'), ('owner', 'unanswered:write'),
      ('owner', 'conversations:read'), ('owner', 'documents:write'), ('owner', 'rooms:read'), ('owner', 'rooms:write'),
      ('owner', 'holidays:read'), ('owner', 'holidays:write'), ('owner', 'slots:read'), ('owner', 'slots:write'),
      ('owner', 'promos:read'), ('owner', 'promos:write'), ('owner', 'payments:write'), ('owner', 'payments:settings'),
      ('owner', 'sources:read'),
      ('owner', 'members:manage'), ('owner', 'activity:read')
    ) d (role, permission)
    where d.role = p_role and d.permission = p_permission
  )
$$;

create or replace function public.app_permission_grantable(p_permission text) returns boolean
language sql immutable
set search_path = ''
as $$
  select p_permission in (
    'documents:write', 'rooms:read', 'rooms:write', 'holidays:read', 'holidays:write',
    'slots:read', 'slots:write', 'promos:read', 'promos:write', 'activity:read', 'sources:read'
  )
$$;

-- 2. The table. tenant_id null is a platform-wide row (a super user added, a
--    tenant removed, a super user's login). Cascades with its tenant (D-077).
create table if not exists public.audit_log (
  id          bigint      generated always as identity primary key,
  tenant_id   bigint      references public.tenants (id) on delete cascade,
  at          timestamptz not null default now(),
  actor_kind  text        not null,
  actor_user  uuid,
  area        text        not null,
  action      text        not null,
  subject     text,
  label       text,
  changed     text[],
  before      jsonb,
  after       jsonb,
  constraint audit_log_actor check (actor_kind in ('staff', 'super', 'system')),
  constraint audit_log_action check (action in ('insert', 'update', 'delete', 'login', 'logout', 'proof_opened', 'tenant_removed')),
  constraint audit_log_label check (label is null or length(label) <= 200)
);
create index if not exists audit_log_tenant_idx   on public.audit_log (tenant_id, at desc, id desc);
create index if not exists audit_log_platform_idx on public.audit_log (at desc, id desc) where tenant_id is null;

alter table public.audit_log enable row level security;
revoke all on public.audit_log from anon;
revoke insert, update, delete on public.audit_log from authenticated;

--    READ: the tenant's own rows with activity:read (app_can(), so a tenant's
--    override reaches it with no twin policy); every row for a super user
--    (the platform's Activity tab; the log holds no guest and no content,
--    rules 2 and 3, so D-076's line is not crossed). NO other policy: no
--    token inserts, updates or deletes a row.
drop policy if exists audit_log_read on public.audit_log;
create policy audit_log_read on public.audit_log for select to authenticated
  using (
    (select public.app_is_super())
    or (tenant_id = (select public.app_tenant_id()) and (select public.app_can('activity:read')))
  );

-- 3. Who. A staff token carries sub; a platform token carries sub and
--    app_super (and app_is_super() demands the platform_admins row, D-076);
--    service_role, a direct session and a chat token have no uid: system.
--    A tool run as a tenant's operator member is 'staff' with the operator's
--    id, which is the truth.
create or replace function public.app_actor_kind() returns text
language sql stable
set search_path = ''
as $$
  select case
    when auth.uid() is null then 'system'
    when public.app_is_super() then 'super'
    else 'staff'
  end
$$;

-- 4. The trigger: ONE function, ONE case on the table. AFTER ROW, SECURITY
--    DEFINER (the only way a token with no insert policy writes the log),
--    search_path '' with every name qualified (trap 19). It never alters the
--    write: it returns null.
create or replace function public.audit_row() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_old     jsonb := case when tg_op = 'INSERT' then null else to_jsonb(old) end;
  v_new     jsonb := case when tg_op = 'DELETE' then null else to_jsonb(new) end;
  v_row     jsonb := coalesce(v_new, v_old);
  v_tenant  bigint;
  v_area    text;
  v_subject text;
  v_label   text;
  v_keep    text[];
  v_changed text[];
  v_before  jsonb;
  v_after   jsonb;
begin
  case tg_table_name
    when 'documents' then
      v_area := 'documents'; v_subject := v_row ->> 'id'; v_label := v_row ->> 'title';
      v_keep := array['title'];
    when 'units' then
      v_area := 'rooms'; v_subject := v_row ->> 'id'; v_label := v_row ->> 'name';
      v_keep := array['name', 'capacity', 'standard_capacity', 'extra_person_rate', 'active', 'sort_order'];
    when 'unit_rooms' then
      v_area := 'rooms'; v_subject := v_row ->> 'id'; v_label := v_row ->> 'name';
      v_keep := array['name', 'active'];
    when 'unit_rates' then
      v_area := 'rates'; v_subject := (v_row ->> 'unit_id') || ':' || (v_row ->> 'slot_id');
      select u.name || ' · ' || s.name into v_label
      from public.units u, public.slots s
      where u.id = (v_row ->> 'unit_id')::bigint and s.id = (v_row ->> 'slot_id')::bigint;
      v_keep := array['weekday_price', 'weekend_price', 'holiday_price'];
    when 'unit_images' then
      v_area := 'photos'; v_subject := v_row ->> 'id';
      select u.name into v_label from public.units u where u.id = (v_row ->> 'unit_id')::bigint;
      v_keep := array['sort_order'];
    when 'rate_calendar' then
      v_area := 'holidays'; v_subject := v_row ->> 'day'; v_label := coalesce(v_row ->> 'label', v_row ->> 'day');
      v_keep := array['day', 'kind', 'label', 'surcharge'];
    when 'slots' then
      v_area := 'slots'; v_subject := v_row ->> 'id'; v_label := v_row ->> 'name';
      v_keep := array['name', 'start_time', 'duration', 'nightly', 'active'];
    when 'promos' then
      v_area := 'promos'; v_subject := v_row ->> 'id'; v_label := v_row ->> 'name';
      v_keep := array['name', 'kind', 'value', 'valid_from', 'valid_to', 'code', 'max_uses', 'active'];
    when 'memberships' then
      v_area := 'members'; v_subject := v_row ->> 'user_id';
      v_keep := array['user_id', 'role'];
    when 'role_permissions' then
      v_area := 'permissions'; v_subject := (v_row ->> 'role') || ':' || (v_row ->> 'permission'); v_label := (v_row ->> 'role') || ' · ' || (v_row ->> 'permission');
      v_keep := array['role', 'permission', 'allowed'];
    when 'tenant_features' then
      v_area := 'features'; v_subject := v_row ->> 'feature'; v_label := v_row ->> 'feature';
      v_keep := array['feature', 'enabled'];
    when 'tenant_applications' then
      v_area := 'applications'; v_subject := v_row ->> 'application_key'; v_label := v_row ->> 'application_key';
      v_keep := array['application_key', 'config'];
    when 'tenants' then
      -- A deleted tenant is gone with its rows (the FK cascades); tenant:remove
      -- writes the one platform row for that itself (plan § 2b.5).
      if tg_op = 'DELETE' then return null; end if;
      v_area := 'tenant'; v_subject := v_row ->> 'slug'; v_label := v_row ->> 'business_name';
      v_keep := array['slug', 'business_name', 'assistant_name', 'logo_url', 'banner_url', 'assistant_avatar_url', 'theme',
                      'archived_at', 'dpa_signed_on', 'privacy_contact_name', 'privacy_contact_email', 'policy_version',
                      'chat_retention_days', 'guest_retention_days', 'audit_retention_days', 'fallback_messages', 'suggested_questions',
                      'welcome_text'];
    when 'unanswered_resolutions' then
      v_area := 'unanswered'; v_subject := v_row ->> 'message_id';
      v_keep := array['message_id'];
    when 'stay_notes' then
      -- The body is NEVER kept (rule 3); the stay's reference is looked up at read time.
      v_area := 'stay_notes'; v_subject := v_row ->> 'id';
      v_keep := array['group_id'];
    when 'platform_admins' then
      v_area := 'platform'; v_subject := v_row ->> 'user_id';
      v_keep := array['user_id'];
    else
      raise exception 'audit_row: % is not an audited table', tg_table_name;
  end case;

  v_tenant := case tg_table_name
    when 'tenants' then (v_row ->> 'id')::bigint
    when 'platform_admins' then null
    else (v_row ->> 'tenant_id')::bigint
  end;

  -- A tenant's hard delete (D-077) cascades through every audited table, and
  -- each row's AFTER DELETE fires here with the tenant already gone: a row
  -- for it would violate the FK and FAIL THE DELETE (verify 212 and 223
  -- found it on the first run). The cascade is not an action anyone took on
  -- a row; tenant:remove writes the one platform row for the whole thing.
  if tg_op = 'DELETE' and v_tenant is not null and not exists (select 1 from public.tenants t where t.id = v_tenant) then
    return null;
  end if;

  if tg_op = 'UPDATE' then
    -- The columns whose value differs, by name; updated_at is bookkeeping.
    select coalesce(array_agg(n.key order by n.key), '{}') into v_changed
    from jsonb_each(v_new) n
    where n.key <> 'updated_at' and n.value is distinct from (v_old -> n.key);
    -- A no-op save (every screen sends the whole form) is not an event (§ 2b.3).
    if cardinality(v_changed) = 0 then return null; end if;
  end if;

  if v_old is not null then
    select jsonb_object_agg(o.key, o.value) into v_before from jsonb_each(v_old) o where o.key = any (v_keep);
  end if;
  if v_new is not null then
    select jsonb_object_agg(n.key, n.value) into v_after from jsonb_each(v_new) n where n.key = any (v_keep);
  end if;

  insert into public.audit_log (tenant_id, actor_kind, actor_user, area, action, subject, label, changed, before, after)
  values (v_tenant, public.app_actor_kind(), auth.uid(), v_area, lower(tg_op), v_subject, left(v_label, 200), v_changed, v_before, v_after);
  return null;
end;
$$;

--    Attached to the 16 tables staff or the platform may change (plan § 2.1).
--    documents on insert and delete only: an edit is a new id (D-044).
do $attach$
declare
  t record;
begin
  for t in select * from (values
    ('documents',              'insert or delete'),
    ('units',                  'insert or update or delete'),
    ('unit_rooms',             'insert or update or delete'),
    ('unit_rates',             'insert or update or delete'),
    ('unit_images',            'insert or update or delete'),
    ('rate_calendar',          'insert or update or delete'),
    ('slots',                  'insert or update or delete'),
    ('promos',                 'insert or update or delete'),
    ('memberships',            'insert or update or delete'),
    ('role_permissions',       'insert or update or delete'),
    ('tenant_features',        'insert or update or delete'),
    ('tenant_applications',    'insert or update or delete'),
    ('tenants',                'insert or update'),
    ('unanswered_resolutions', 'insert or delete'),
    ('stay_notes',             'insert or delete'),
    ('platform_admins',        'insert or delete')
  ) v (tbl, ops) loop
    execute format('drop trigger if exists %I on public.%I', t.tbl || '_audit', t.tbl);
    execute format('create trigger %I after %s on public.%I for each row execute function public.audit_row()', t.tbl || '_audit', t.ops, t.tbl);
  end loop;
end;
$attach$;

-- 5. The three named actions (plan § 2.3). SECURITY DEFINER; it refuses a
--    caller with no user id FIRST, so a chat token (authenticated, no sub)
--    can never write a row (§ 2b.4): that is why a failed login is not here.
--    A tenant's row needs a member of that tenant; a platform row (p_tenant_id
--    null) needs a super user. Returns the row's id.
create or replace function public.audit_note(p_tenant_id bigint, p_action text, p_subject text default null) returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id bigint;
begin
  if auth.uid() is null then
    raise exception 'audit_note: no user on this token' using errcode = 'insufficient_privilege';
  end if;
  if p_action not in ('login', 'logout', 'proof_opened') then
    raise exception 'audit_note: % is not a named action', p_action using errcode = 'check_violation';
  end if;
  if p_tenant_id is null then
    if not public.app_is_super() then
      raise exception 'audit_note: a platform row needs a super user' using errcode = 'insufficient_privilege';
    end if;
  elsif p_tenant_id is distinct from public.app_tenant_id() or not public.app_is_staff() then
    raise exception 'audit_note: tenant % is not the token''s tenant' , p_tenant_id using errcode = 'insufficient_privilege';
  end if;
  if p_action = 'proof_opened' and (p_subject is null or p_tenant_id is null) then
    raise exception 'audit_note: proof_opened names the payment' using errcode = 'check_violation';
  end if;
  insert into public.audit_log (tenant_id, actor_kind, actor_user, area, action, subject)
  values (p_tenant_id, public.app_actor_kind(), auth.uid(), case when p_action = 'proof_opened' then 'proof' else 'session' end, p_action, left(p_subject, 200))
  returning id into v_id;
  return v_id;
end;
$$;
revoke all on function public.audit_note(bigint, text, text) from public, anon;
grant execute on function public.audit_note(bigint, text, text) to authenticated, service_role;

-- 6. Retention (D-131's rule, applied): a per-tenant period, swept by the
--    retention tool on service_role (a direct, counted delete: the rows need
--    no aggregation). 730 days by default; 90 to 3650.
alter table public.tenants add column if not exists audit_retention_days int not null default 730;
alter table public.tenants drop constraint if exists tenants_retention;
alter table public.tenants add  constraint tenants_retention check (
  chat_retention_days between 30 and 1825 and guest_retention_days between 180 and 3650 and audit_retention_days between 90 and 3650
);

-- 7. The ONE read: activity_list(). security INVOKER: audit_log under the
--    caller's policy, booking_events under its own (staff of the tenant), and
--    it refuses a caller that is neither allowed activity:read on that tenant
--    nor a super user (nor service_role), so a chat token gets a refusal and
--    a member without the permission gets a refusal, not an empty page.
--
--    p_tenant_id null lists the platform-wide rows (super users only).
--    Window: p_days in (7, 30, 90, 365), else 30, from the tenant's local
--    midnight (trap 9). p_area filters one area ('bookings' is the
--    booking_events source). p_actor one user. p_q matches the label,
--    escaped. Keyset on (at, key) where key = source || ':' || id, so two
--    sources never collide. One row more than the page is read for `more`.
create or replace function public.activity_list(
  p_tenant_id bigint,
  p_days      int         default 30,
  p_area      text        default null,
  p_actor     uuid        default null,
  p_q         text        default null,
  p_before_at timestamptz default null,
  p_before_key text       default null,
  p_limit     int         default 50
)
returns jsonb
language plpgsql stable
set search_path = ''
as $$
declare
  v_service  boolean := coalesce(auth.jwt() ->> 'role', '') = 'service_role';
  v_super    boolean := public.app_is_super();
  v_days     int := case when p_days in (7, 30, 90, 365) then p_days else 30 end;
  v_limit    int := least(greatest(coalesce(p_limit, 50), 1), 200);
  v_pattern  text;
  v_timezone text := 'Asia/Manila';
  v_from_ts  timestamptz;
  v_total    int;
  v_rows     jsonb;
begin
  if p_tenant_id is null then
    if not (v_service or v_super) then
      raise exception 'activity_list: the platform log is for super users' using errcode = 'insufficient_privilege';
    end if;
  elsif not (v_service or v_super or (p_tenant_id is not distinct from public.app_tenant_id() and public.app_can('activity:read'))) then
    raise exception 'activity_list: not allowed to read tenant %''s activity', p_tenant_id using errcode = 'insufficient_privilege';
  end if;

  if p_tenant_id is not null then
    select coalesce(a.config->>'timezone', 'Asia/Manila') into v_timezone
    from public.tenant_applications a
    where a.tenant_id = p_tenant_id and a.application_key = 'bookings';
    v_timezone := coalesce(v_timezone, 'Asia/Manila');
  end if;
  v_from_ts := (((now() at time zone v_timezone)::date - v_days + 1)::timestamp at time zone v_timezone);

  if nullif(btrim(p_q), '') is not null then
    v_pattern := '%' || replace(replace(replace(btrim(p_q), '\', '\\'), '%', '\%'), '_', '\_') || '%';
  end if;

  -- The actors' emails, ONCE: member_emails() is a definer that admits this
  -- caller (a member, a super user, service_role) and lists CURRENT members;
  -- a removed member's rows keep the id and no email. With no tenant (the
  -- platform log) it lists nothing and raises nothing.
  with emails as (
    select e.user_id, e.email from public.member_emails(p_tenant_id) e
  ),
  everything as (
    select 'audit' as source, l.id, l.at, l.actor_kind, l.actor_user, l.area, l.action, l.subject, l.label, l.changed, l.before, l.after
    from public.audit_log l
    where l.tenant_id is not distinct from p_tenant_id and l.at >= v_from_ts
    union all
    -- A stay's events, never its note (rule 2): the reference, the kind, the statuses.
    select 'bookings', e.id, e.at, e.actor_kind, e.actor_user, 'bookings', e.kind, e.group_id::text, s.reference, null,
           case when e.from_value is not null then jsonb_build_object('status', e.from_value) end,
           case when e.to_value is not null then jsonb_build_object('status', e.to_value) end
    from public.booking_events e
    left join public.stays s on s.tenant_id = e.tenant_id and s.group_id = e.group_id
    where p_tenant_id is not null and e.tenant_id = p_tenant_id and e.at >= v_from_ts
  ),
  filtered as (
    select x.*, x.source || ':' || x.id as key, count(*) over () as total
    from everything x
    where (p_area is null or x.area = p_area)
      and (p_actor is null or x.actor_user = p_actor)
      and (v_pattern is null or x.label ilike v_pattern or x.subject ilike v_pattern)
  ),
  page as (
    select f.*
    from filtered f
    where p_before_at is null or (f.at, f.key) < (p_before_at, p_before_key)
    order by f.at desc, f.key desc
    limit v_limit + 1
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'key', p.key,
           'source', p.source,
           'at', p.at,
           'actorKind', p.actor_kind,
           'actorUser', p.actor_user,
           'actorEmail', m.email,
           'area', p.area,
           'action', p.action,
           'subject', p.subject,
           'label', p.label,
           'changed', to_jsonb(p.changed),
           'before', p.before,
           'after', p.after
         ) order by p.at desc, p.key desc), '[]'::jsonb),
         coalesce(max(p.total), 0)::int
  into v_rows, v_total
  from page p
  left join emails m on m.user_id = p.actor_user;

  return jsonb_build_object(
    'timezone', v_timezone,
    'days', v_days,
    'total', v_total,
    'more', jsonb_array_length(v_rows) > v_limit,
    'rows', case when jsonb_array_length(v_rows) > v_limit then v_rows - v_limit else v_rows end
  );
end;
$$;
revoke all on function public.activity_list(bigint, int, text, uuid, text, timestamptz, text, int) from public, anon, authenticated;
grant execute on function public.activity_list(bigint, int, text, uuid, text, timestamptz, text, int) to authenticated, service_role;

notify pgrst, 'reload schema';
