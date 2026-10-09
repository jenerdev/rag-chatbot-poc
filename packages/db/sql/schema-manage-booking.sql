-- schema-manage-booking.sql — the guest's Manage booking page and what
-- stands behind it (plan/manage-booking.md).
--
-- Run AFTER schema-calendar.sql. The 23rd file. Idempotent. Phase 1's part:
-- stays, the `expired` status, booking_events, and the guest's one read.
-- Phases 3, 4 and 6 append their sections here. NO existing function is
-- replaced: everything below is added beside what is there, so re-running
-- an older file cannot undo it (trap 20).
--
--   stays                 one row per stay (a bookings group, D-100): the
--                         reference, and later its payment terms (plan § 2.1)
--   bookings.status       gains 'expired' (plan § 2.5; nothing writes it yet)
--   booking_events        every creation and every status change, written by
--                         a trigger, readable by staff, writable by nobody
--                         (plan Rule 2)
--   guest_lookup_failures the misses per reference, for the lockout (§ 2.2)
--   guest_stay()          the guest's ONE read: reference + email or phone →
--                         this stay's guest-facing columns, or null (Rule 4)
--
-- Nothing about holding changes: D-070, D-095, D-099 and D-100 stand.

-- 1. stays. One row per (tenant, group). The reference is the group's, so
--    it is unique per tenant here, which is also the index guest_stay()
--    finds a stay by. Payment terms join it in Phase 3.
create table if not exists stays (
  tenant_id   bigint      not null references tenants(id) on delete cascade,
  group_id    uuid        not null,
  reference   text        not null,
  created_at  timestamptz not null default now(),
  primary key (tenant_id, group_id),
  constraint stays_reference_unique unique (tenant_id, reference)
);

alter table stays enable row level security;
drop policy if exists stays_read on stays;
-- Staff of the tenant read. Nobody writes through a policy: the row is made
-- by the trigger below (definer) and removed by the delete trigger.
create policy stays_read on stays for select to authenticated
  using (tenant_id = (select public.app_tenant_id()) and (select public.app_is_staff()));

-- 2. The stay row is made with the stay's first booking. BEFORE INSERT,
--    named to run right after bookings_aa_fill_group_and_reference (name
--    order), so group_id and reference are already filled. SECURITY DEFINER
--    (D-042's shape) so that no token needs an insert policy on `stays`; it
--    writes only the row's own tenant, group and reference, and if the
--    booking itself is then refused (RLS, a constraint), the statement rolls
--    back and this row with it.
create or replace function bookings_ensure_stay() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.stays (tenant_id, group_id, reference)
  values (new.tenant_id, new.group_id, new.reference)
  on conflict (tenant_id, group_id) do nothing;
  return new;
end;
$$;
drop trigger if exists bookings_ab_ensure_stay on bookings;
create trigger bookings_ab_ensure_stay
  before insert on bookings
  for each row execute function bookings_ensure_stay();

-- 3. A stay whose last booking is hard-deleted goes too (the tools' fixtures
--    are seeded and deleted on every run). Without this, the orphan keeps
--    its reference, and a later booking_reference() that draws it would
--    fail stays_reference_unique. Tokens have no delete policy on bookings,
--    so this runs for service_role and the SQL editor only.
create or replace function bookings_drop_empty_stays() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  delete from public.stays s
  using (select distinct o.tenant_id, o.group_id from gone o) g
  where s.tenant_id = g.tenant_id and s.group_id = g.group_id
    and not exists (select 1 from public.bookings b where b.tenant_id = g.tenant_id and b.group_id = g.group_id);
  return null;
end;
$$;
drop trigger if exists bookings_drop_empty_stays on bookings;
create trigger bookings_drop_empty_stays
  after delete on bookings
  referencing old table as gone
  for each statement execute function bookings_drop_empty_stays();

-- 4. Backfill, counted. Every group already has one reference (D-100's
--    repair); if any has two, or a row lacks either, stop rather than guess.
do $backfill$
declare
  v_split   int;
  v_missing int;
  v_before  int;
  v_after   int;
  v_groups  int;
begin
  select count(*) into v_missing from public.bookings where group_id is null or reference is null;
  select count(*) into v_split from (
    select 1 from public.bookings group by tenant_id, group_id having count(distinct reference) > 1
  ) x;
  if v_missing > 0 or v_split > 0 then
    raise exception 'stays backfill: % rows without group or reference, % groups with two references', v_missing, v_split;
  end if;
  select count(*) into v_before from public.stays;
  insert into public.stays (tenant_id, group_id, reference, created_at)
  select b.tenant_id, b.group_id, min(b.reference), min(b.created_at)
  from public.bookings b
  group by b.tenant_id, b.group_id
  on conflict (tenant_id, group_id) do nothing;
  select count(*) into v_after from public.stays;
  select count(*) into v_groups from (select distinct tenant_id, group_id from public.bookings) g;
  raise notice 'stays backfill: % before, % after, % groups in bookings', v_before, v_after, v_groups;
end;
$backfill$;

-- 5. Every booking belongs to a stay. After the backfill this cannot fail.
alter table bookings drop constraint if exists bookings_stay_fk;
alter table bookings add constraint bookings_stay_fk
  foreign key (tenant_id, group_id) references stays (tenant_id, group_id);

-- 6. 'expired': pending, past its payment deadline, nothing verified (plan
--    § 2.5). Nothing writes it until Phase 5; the guest page and the screens
--    must already know the word. Re-created, looser, so it cannot fail.
alter table bookings drop constraint if exists bookings_status;
alter table bookings add constraint bookings_status
  check (status in ('pending', 'confirmed', 'cancelled', 'expired'));

-- 7. booking_events. Append-only: staff read, no token writes, no update or
--    delete policy for anyone. Written by the triggers below, which are
--    SECURITY DEFINER for that reason alone. Phases 3, 4 and 6 add kinds.
create table if not exists booking_events (
  id          bigint      generated always as identity primary key,
  tenant_id   bigint      not null,
  group_id    uuid        not null,
  at          timestamptz not null default now(),
  actor_kind  text        not null,
  actor_user  uuid,
  kind        text        not null,
  from_value  text,
  to_value    text,
  row_count   int,
  note        text,
  constraint booking_events_stay_fk foreign key (tenant_id, group_id)
    references stays (tenant_id, group_id) on delete cascade,
  constraint booking_events_actor check (actor_kind in ('guest', 'staff', 'system')),
  constraint booking_events_kind check (kind in ('created', 'status'))
);
create index if not exists booking_events_stay_idx on booking_events (tenant_id, group_id, at);

alter table booking_events enable row level security;
drop policy if exists booking_events_read on booking_events;
create policy booking_events_read on booking_events for select to authenticated
  using (tenant_id = (select public.app_tenant_id()) and (select public.app_is_staff()));

-- Who did it, from the request's own claims. A staff token carries `sub`; a
-- chat token is `authenticated` with none (a guest, through a definer such
-- as request_booking()); service_role and a direct session are the system.
-- A definer that acts for someone else names it with set_config('app.actor').
create or replace function app_actor() returns text
language sql
stable
set search_path = ''
as $$
  select case
    when coalesce(current_setting('app.actor', true), '') in ('guest', 'staff', 'system') then current_setting('app.actor', true)
    when auth.uid() is not null then 'staff'
    when coalesce(auth.jwt() ->> 'role', '') = 'authenticated' then 'guest'
    else 'system'
  end
$$;

-- 8. The two event triggers: statement-level with transition tables, so a
--    three-night group confirmed in one statement is ONE event (row_count = 3),
--    not three. (A transition table cannot sit on an UPDATE OF column
--    trigger, so the update one compares the statuses itself.)
create or replace function bookings_log_created() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.booking_events (tenant_id, group_id, actor_kind, actor_user, kind, to_value, row_count, note)
  select n.tenant_id, n.group_id, public.app_actor(), auth.uid(), 'created', n.status, count(*), min(n.source)
  from born n
  group by n.tenant_id, n.group_id, n.status;
  return null;
end;
$$;
drop trigger if exists bookings_log_created on bookings;
create trigger bookings_log_created
  after insert on bookings
  referencing new table as born
  for each statement execute function bookings_log_created();

create or replace function bookings_log_status() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.booking_events (tenant_id, group_id, actor_kind, actor_user, kind, from_value, to_value, row_count, note)
  select n.tenant_id, n.group_id, public.app_actor(), auth.uid(), 'status', o.status, n.status, count(*), max(n.decision_note)
  from after_rows n
  join before_rows o on o.id = n.id
  where o.status is distinct from n.status
  group by n.tenant_id, n.group_id, o.status, n.status;
  return null;
end;
$$;
drop trigger if exists bookings_log_status on bookings;
create trigger bookings_log_status
  after update on bookings
  referencing old table as before_rows new table as after_rows
  for each statement execute function bookings_log_status();

-- Trigger functions are not callable through PostgREST, but say so anyway.
revoke all on function bookings_ensure_stay()    from public, anon, authenticated;
revoke all on function bookings_log_created()    from public, anon, authenticated;
revoke all on function bookings_log_status()     from public, anon, authenticated;
revoke all on function bookings_drop_empty_stays() from public, anon, authenticated;

-- 9. The lockout's memory. No policy for any token: only guest_stay()
--    (definer) reads and writes it.
create table if not exists guest_lookup_failures (
  id         bigint      generated always as identity primary key,
  tenant_id  bigint      not null references tenants(id) on delete cascade,
  reference  text        not null,
  at         timestamptz not null default now()
);
create index if not exists guest_lookup_failures_ref_idx on guest_lookup_failures (tenant_id, reference, at);
alter table guest_lookup_failures enable row level security;

-- 10. A phone as a key: request_booking()'s normalisation (spaces, dots,
--     dashes and brackets out; +63 → 0), so a staff row typed "0917 845
--     2290" matches a guest typing "+639178452290".
create or replace function phone_key(p_phone text) returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when v like '+63%' then '0' || substr(v, 4)
    else v
  end
  from (select regexp_replace(coalesce(p_phone, ''), '[\s().-]', '', 'g') as v) x
$$;

-- 11. guest_stay(): the guest's ONE read (plan Rule 4, § 2.2, § 2.3).
--     SECURITY DEFINER, D-042's shape: a chat token has no read policy on
--     bookings, and this returns one stay's guest-facing columns only. It
--     checks its caller (the token's tenant, or service_role for the tools)
--     before anything. Every miss (no such reference, wrong contact, a
--     stay with no contact, another tenant's reference, a locked reference)
--     is the same null. After 5 misses in an hour, a reference answers null
--     even to the right contact, for the rest of that hour.
create or replace function guest_stay(p_tenant_id bigint, p_reference text, p_contact text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  c_max_misses constant int := 5;
  c_window     constant interval := interval '1 hour';
  v_ref     text := upper(regexp_replace(coalesce(p_reference, ''), '\s', '', 'g'));
  v_contact text := btrim(coalesce(p_contact, ''));
  v_email   text;
  v_phone   text;
  v_group   uuid;
  v_status  text;
  v_out     jsonb;
begin
  if coalesce(auth.jwt() ->> 'role', '') <> 'service_role'
     and p_tenant_id is distinct from public.app_tenant_id() then
    raise exception 'guest_stay: tenant % is not the token''s tenant', p_tenant_id
      using errcode = 'insufficient_privilege';
  end if;

  -- Nothing that cannot be a reference or a contact is looked up or counted.
  if v_ref !~ '^[A-Z]{3}-[A-Z0-9]{6}$' or char_length(v_contact) not between 5 and 254 then
    return null;
  end if;
  if position('@' in v_contact) > 0 then
    v_email := lower(v_contact);
  else
    v_phone := public.phone_key(v_contact);
    if v_phone !~ '^09[0-9]{9}$' then
      return null;
    end if;
  end if;

  if (select count(*) from public.guest_lookup_failures f
      where f.tenant_id = p_tenant_id and f.reference = v_ref and f.at > now() - c_window) >= c_max_misses then
    return null;
  end if;

  select s.group_id into v_group
  from public.stays s
  where s.tenant_id = p_tenant_id and s.reference = v_ref
    and exists (
      select 1 from public.bookings b
      where b.tenant_id = s.tenant_id and b.group_id = s.group_id
        and ((v_email is not null and lower(btrim(b.guest_email)) = v_email)
          or (v_phone is not null and public.phone_key(b.guest_phone) = v_phone))
    );

  if v_group is null then
    delete from public.guest_lookup_failures f
    where f.tenant_id = p_tenant_id and f.reference = v_ref and f.at < now() - interval '1 day';
    insert into public.guest_lookup_failures (tenant_id, reference) values (p_tenant_id, v_ref);
    return null;
  end if;

  -- The stay's status: confirmed if any row is, else pending, else expired,
  -- else cancelled. Its rows are the ones in that status (a reschedule, in
  -- Phase 6, leaves cancelled rows beside the live ones).
  select b.status into v_status
  from public.bookings b
  where b.tenant_id = p_tenant_id and b.group_id = v_group
  order by array_position(array['confirmed', 'pending', 'expired', 'cancelled'], b.status)
  limit 1;

  select jsonb_build_object(
    'reference',   v_ref,
    'status',      v_status,
    'source',      min(b.source),
    'guest_name',  min(b.guest_name),
    'check_in',    min(b.booked_date),
    'starts_at',   min(lower(b.during)),
    'ends_at',     max(upper(b.during)),
    'ended',       max(upper(b.during)) < now(),
    'nights',      count(distinct b.booked_date),
    'created_at',  min(b.created_at),
    'price',       jsonb_build_object(
                     'base',         sum(b.base_price),
                     'extra_guests', sum(b.extra_guest_price),
                     'surcharge',    sum(b.surcharge),
                     'discount',     sum(b.discount),
                     'total',        sum(b.price)),
    'rooms',       (select jsonb_agg(r order by r ->> 'unit', r ->> 'slot')
                    from (select distinct jsonb_build_object('unit', u.name, 'slot', sl.name, 'guests', b2.guest_count) as r
                          from public.bookings b2
                          join public.units u on u.tenant_id = b2.tenant_id and u.id = b2.unit_id
                          join public.slots sl on sl.tenant_id = b2.tenant_id and sl.id = b2.slot_id
                          where b2.tenant_id = p_tenant_id and b2.group_id = v_group and b2.status = v_status) x),
    'timezone',    (select a.config ->> 'timezone' from public.tenant_applications a
                    where a.tenant_id = p_tenant_id and a.application_key = 'bookings'),
    'currency',    (select coalesce(a.config ->> 'currency', 'PHP') from public.tenant_applications a
                    where a.tenant_id = p_tenant_id and a.application_key = 'bookings')
  ) into v_out
  from public.bookings b
  where b.tenant_id = p_tenant_id and b.group_id = v_group and b.status = v_status;

  return v_out;
end;
$$;

revoke all on function guest_stay(bigint, text, text) from public, anon;
grant execute on function guest_stay(bigint, text, text) to authenticated, service_role;

-- PostgREST caches the schema: the new table, function and columns are
-- unknown to it until told.
notify pgrst, 'reload schema';
