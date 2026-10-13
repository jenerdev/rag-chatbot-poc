-- schema-notification-reads.sql — the 30th file (plan/notifications.md § 8,
-- the Notifications item, 2026-10-14).
--
-- The sidebar's count was what WAITS (pending requests, proofs to verify),
-- so opening a notification could never clear it: only deciding the stay
-- did. Staff asked for a Notifications item of its own, whose number is
-- what they have not READ. This file gives each member a read mark per
-- notification, on every device at once:
--
--   notification_outbox   staff may now READ their tenant's rows: the same
--                         rows a push is made from (Rule 1), the same role
--                         rule as notify_claim() (Rule 3: a proof only for
--                         owners and admins)
--   notification_reads    one row per (member, notification) read
--   notification_feed()   unread count + the newest rows with a read flag
--   notification_read()   mark some, or all, as read
--
-- Both functions are security INVOKER, like conversation_list(): they read
-- and write under the token's own RLS, and refuse a caller that is not
-- staff of that tenant on top. Run after schema-notifications.sql.
-- Idempotent.
--
-- Every function: set search_path = '' and every name qualified (trap 19).

-- 1. The outbox, readable by its own tenant's staff ---------------------------
--    Named fields only (Rule 2): kind, reference, first night, nights, when.
--    No guest name, phone, email or amount is in the table to read.

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'notification_outbox_id_tenant') then
    alter table public.notification_outbox add constraint notification_outbox_id_tenant unique (id, tenant_id);
  end if;
end $$;

grant select on public.notification_outbox to authenticated;
drop policy if exists notification_outbox_staff_read on public.notification_outbox;
create policy notification_outbox_staff_read on public.notification_outbox for select to authenticated
  using (
    tenant_id = (select public.app_tenant_id())
    and (select public.app_is_staff())
    -- The same rule as notify_claim(): request and change to every role,
    -- a proof to owners and admins (lib/permissions.ts NOTIFY_PERMISSION).
    and (kind in ('request', 'change') or (select public.app_is_admin()))
  );

-- 2. notification_reads ---------------------------------------------------------
--    Per member, not per device: read on the phone is read on the laptop.
--    The foreign keys keep a mark in its notification's tenant and with a
--    member of it; removing the member or the notification removes the mark.

create table if not exists public.notification_reads (
  tenant_id  bigint      not null,
  user_id    uuid        not null default auth.uid(),
  outbox_id  bigint      not null,
  read_at    timestamptz not null default now(),
  primary key (user_id, outbox_id),
  constraint notification_reads_member_fk foreign key (user_id, tenant_id)
    references public.memberships (user_id, tenant_id) on delete cascade,
  constraint notification_reads_outbox_fk foreign key (outbox_id, tenant_id)
    references public.notification_outbox (id, tenant_id) on delete cascade
);
create index if not exists notification_reads_tenant_idx on public.notification_reads (tenant_id, user_id);

alter table public.notification_reads enable row level security;
grant select, insert, delete on public.notification_reads to authenticated;
-- A member reads and marks only their own, in the token's tenant. No
-- update: a mark is there or not.
drop policy if exists notification_reads_read on public.notification_reads;
create policy notification_reads_read on public.notification_reads for select to authenticated
  using (user_id = (select auth.uid()) and tenant_id = (select public.app_tenant_id()) and (select public.app_is_staff()));
drop policy if exists notification_reads_insert on public.notification_reads;
create policy notification_reads_insert on public.notification_reads for insert to authenticated
  with check (user_id = (select auth.uid()) and tenant_id = (select public.app_tenant_id()) and (select public.app_is_staff()));
drop policy if exists notification_reads_delete on public.notification_reads;
create policy notification_reads_delete on public.notification_reads for delete to authenticated
  using (user_id = (select auth.uid()) and tenant_id = (select public.app_tenant_id()) and (select public.app_is_staff()));

-- 3. notification_feed(p_tenant_id, p_limit) ------------------------------------
--    { unread, items: [{ id, kind, reference, firstNight, nights, at, read }] }
--    The last 30 days, newest first. `unread` counts the whole window, not
--    only the rows returned: the poll asks for 5, the page for 100.

create or replace function public.notification_feed(p_tenant_id bigint, p_limit int default 50)
returns jsonb
language plpgsql stable
set search_path = ''
as $$
declare
  v_limit int := least(greatest(coalesce(p_limit, 50), 1), 200);
  v_from  timestamptz := now() - interval '30 days';
  v_unread int;
  v_items  jsonb;
begin
  if p_tenant_id is distinct from public.app_tenant_id() or not public.app_is_staff() then
    raise exception 'notification_feed: not a member of tenant %', p_tenant_id using errcode = 'insufficient_privilege';
  end if;

  -- RLS has already narrowed both tables to this member and role; the
  -- tenant filter is said again (rule 6, wall 1).
  select count(*)::int into v_unread
  from public.notification_outbox o
  where o.tenant_id = p_tenant_id and o.created_at >= v_from
    and not exists (select 1 from public.notification_reads r where r.outbox_id = o.id and r.user_id = auth.uid());

  select coalesce(jsonb_agg(x.item order by x.id desc), '[]'::jsonb) into v_items
  from (
    select o.id, jsonb_build_object(
      'id', o.id, 'kind', o.kind, 'reference', o.reference, 'firstNight', o.first_night, 'nights', o.nights,
      'at', o.created_at,
      'read', exists (select 1 from public.notification_reads r where r.outbox_id = o.id and r.user_id = auth.uid())
    ) as item
    from public.notification_outbox o
    where o.tenant_id = p_tenant_id and o.created_at >= v_from
    order by o.id desc
    limit v_limit
  ) x;

  return jsonb_build_object('unread', v_unread, 'items', v_items);
end;
$$;
revoke all on function public.notification_feed(bigint, int) from public, anon;
grant execute on function public.notification_feed(bigint, int) to authenticated;

-- 4. notification_read(p_tenant_id, p_ids) ---------------------------------------
--    Marks the named notifications read, or every unread one in the window
--    when p_ids is null ("Mark all read"). Only rows the member may see are
--    marked (RLS on the outbox); an id that is not theirs marks nothing,
--    exactly like one that does not exist. Returns how many were marked.

create or replace function public.notification_read(p_tenant_id bigint, p_ids bigint[] default null)
returns int
language plpgsql
set search_path = ''
as $$
declare
  v_count int;
begin
  if p_tenant_id is distinct from public.app_tenant_id() or not public.app_is_staff() then
    raise exception 'notification_read: not a member of tenant %', p_tenant_id using errcode = 'insufficient_privilege';
  end if;

  insert into public.notification_reads (tenant_id, outbox_id)
  select o.tenant_id, o.id
  from public.notification_outbox o
  where o.tenant_id = p_tenant_id
    and (p_ids is null or o.id = any (p_ids))
    and o.created_at >= now() - interval '30 days'
  on conflict (user_id, outbox_id) do nothing;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;
revoke all on function public.notification_read(bigint, bigint[]) from public, anon;
grant execute on function public.notification_read(bigint, bigint[]) to authenticated;

notify pgrst, 'reload schema';
