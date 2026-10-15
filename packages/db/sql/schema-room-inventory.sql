-- schema-room-inventory.sql — a room type has several physical rooms (D-133,
-- plan/room-types.md Phase 1). The 37th file.
--
-- Run AFTER schema-stay-notes.sql. Safe to re-run IN ORDER (trap 25): every
-- step is `if not exists`, `create or replace`, or drops what it creates
-- first; the backfill fills only what is missing. It replaces NO earlier
-- function. It does replace an earlier CONSTRAINT, bookings_no_overlap, so
-- schema-holds.sql's step 5 is now guarded on this file's marker,
-- to_regclass('public.unit_rooms') (trap 20).
--
-- Until now one `units` row was one physical room. Alteza has 2 Casa Uno and
-- 3 Loft Suite, and the only way to say so was a row per room, each with its
-- own name, rate card and photos ("Kubo A", "Kubo B"). From here:
--
--   * `units` stays what the guest sees: the TYPE, with its name, capacity,
--     rates, photos and promos. Nothing that prices a stay changes.
--   * `unit_rooms` holds the PHYSICAL rooms of a unit. How many a type has
--     is how many active rows (Rule 2), never a number typed beside them.
--   * every booking row names its room, `bookings.room_id`, and
--     bookings_no_overlap compares rooms, not units (Rule 1). Same guarantee,
--     one level down.
--   * a booking that names no room gets one from ONE trigger,
--     bookings_room_assign (Rule 3), at every door.
--
-- Every unit gets one room named like it (the backfill, and a trigger for
-- new units), so every tenant behaves exactly as before until staff add a
-- second room. The counting reads (availability, request_booking's check,
-- bookings_pending_not_taken) are Phase 2's file.
--
-- The two walls (D-038): the policies below hold for tokens; the triggers
-- and the constraint hold for everyone, service_role included.

begin;

-- 1. The physical rooms. The composite FK keeps a room inside its unit's
--    tenant; the 3-column unique key is what bookings' FK points at, so a
--    booking cannot name a room of ANOTHER unit (Rule 4).
create table if not exists public.unit_rooms (
  id         bigint generated always as identity primary key,
  tenant_id  bigint  not null references public.tenants(id) on delete cascade,
  unit_id    bigint  not null,
  name       text    not null,
  active     boolean not null default true,
  sort_order int     not null default 0,
  created_at timestamptz not null default now(),
  constraint unit_rooms_unit_tenant_fk foreign key (unit_id, tenant_id)
    references public.units (id, tenant_id) on delete cascade,
  constraint unit_rooms_id_unit_tenant_key unique (id, unit_id, tenant_id),
  constraint unit_rooms_unit_name_key unique (unit_id, name),
  constraint unit_rooms_name_shape check (btrim(name) <> '' and length(name) <= 80)
);

create index if not exists unit_rooms_tenant_unit_idx on public.unit_rooms (tenant_id, unit_id);

-- 2. Policies. Any token of the tenant reads (the availability reads and the
--    booking page count them); owners and admins write, exactly like
--    unit_rates; D-128's twins on rooms:write.
alter table public.unit_rooms enable row level security;

drop policy if exists unit_rooms_read   on public.unit_rooms;
drop policy if exists unit_rooms_insert on public.unit_rooms;
drop policy if exists unit_rooms_update on public.unit_rooms;
drop policy if exists unit_rooms_delete on public.unit_rooms;
create policy unit_rooms_read on public.unit_rooms for select to authenticated
  using (tenant_id = (select public.app_tenant_id()));
create policy unit_rooms_insert on public.unit_rooms for insert to authenticated
  with check (tenant_id = (select public.app_tenant_id()) and (select public.app_is_admin()));
create policy unit_rooms_update on public.unit_rooms for update to authenticated
  using      (tenant_id = (select public.app_tenant_id()) and (select public.app_is_admin()))
  with check (tenant_id = (select public.app_tenant_id()) and (select public.app_is_admin()));
create policy unit_rooms_delete on public.unit_rooms for delete to authenticated
  using (tenant_id = (select public.app_tenant_id()) and (select public.app_is_admin()));

do $twins$
declare
  c text;
begin
  foreach c in array array['insert', 'update', 'delete'] loop
    execute format('drop policy if exists %I on public.unit_rooms', 'unit_rooms_may_' || c);
    execute format('drop policy if exists %I on public.unit_rooms', 'unit_rooms_can_' || c);
    execute format(
      'create policy %I on public.unit_rooms as restrictive for %s to authenticated %s',
      'unit_rooms_may_' || c, c,
      case c
        when 'insert' then 'with check ((select public.app_may(''rooms:write'')))'
        when 'update' then 'using ((select public.app_may(''rooms:write''))) with check ((select public.app_may(''rooms:write'')))'
        else 'using ((select public.app_may(''rooms:write'')))'
      end);
    execute format(
      'create policy %I on public.unit_rooms for %s to authenticated %s',
      'unit_rooms_can_' || c, c,
      case c
        when 'insert' then 'with check (tenant_id = (select public.app_tenant_id()) and (select public.app_can(''rooms:write'')))'
        when 'update' then 'using (tenant_id = (select public.app_tenant_id()) and (select public.app_can(''rooms:write''))) with check (tenant_id = (select public.app_tenant_id()) and (select public.app_can(''rooms:write'')))'
        else 'using (tenant_id = (select public.app_tenant_id()) and (select public.app_can(''rooms:write'')))'
      end);
  end loop;
end;
$twins$;

-- A room's unit and tenant never change once made: a room moved to another
-- type would take its bookings' history with it. Only these three columns.
revoke all on public.unit_rooms from anon;
revoke update on public.unit_rooms from authenticated;
grant update (name, active, sort_order) on public.unit_rooms to authenticated;

-- 3. Every unit has a room. A new unit gets one named like it, so the Rooms
--    screen's "add a room type" needs no second step; a renamed unit's
--    room follows while it still carries the old name. Definer: the unit's
--    writer may lack nothing here, but the room must exist whatever the
--    caller's policies say. Trigger-only, so no token can call it.
create or replace function public.units_first_room() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    insert into public.unit_rooms (tenant_id, unit_id, name)
    values (new.tenant_id, new.id, new.name)
    on conflict (unit_id, name) do nothing;
  elsif new.name is distinct from old.name then
    update public.unit_rooms set name = new.name
    where unit_id = new.id and tenant_id = new.tenant_id and name = old.name
      and not exists (select 1 from public.unit_rooms r where r.unit_id = new.id and r.name = new.name);
  end if;
  return null;
end;
$$;
revoke all on function public.units_first_room() from public, anon, authenticated;

drop trigger if exists units_first_room on public.units;
create trigger units_first_room
  after insert or update of name on public.units
  for each row execute function public.units_first_room();

insert into public.unit_rooms (tenant_id, unit_id, name)
select u.tenant_id, u.id, u.name
from public.units u
where not exists (select 1 from public.unit_rooms r where r.unit_id = u.id);

-- 4. bookings.room_id, filled from the backfill. The fill is an UPDATE of
--    every booking row, and bookings has BEFORE UPDATE triggers that would
--    recompute `during` from today's slot times, refuse a row on a date
--    closed since, or on a slot retired since (bookings_compute_during,
--    bookings_not_on_closed_day, bookings_slot_active). None of that is this
--    file's business, so the user triggers are off for the fill alone; the
--    FK triggers (internal) stay on. One unit has exactly one room here, so
--    the pick is not a choice.
alter table public.bookings add column if not exists room_id bigint;

alter table public.bookings disable trigger user;
update public.bookings b
set room_id = (select r.id from public.unit_rooms r where r.unit_id = b.unit_id order by r.sort_order, r.id limit 1)
where b.room_id is null;
alter table public.bookings enable trigger user;

alter table public.bookings alter column room_id set not null;

alter table public.bookings drop constraint if exists bookings_room_fk;
-- NO ACTION, like the slot FK: a room with history is retired, never
-- deleted; deleting a unit or a tenant cascades to both rooms and bookings
-- in one statement, and NO ACTION is checked at its end.
alter table public.bookings add constraint bookings_room_fk foreign key (room_id, unit_id, tenant_id)
  references public.unit_rooms (id, unit_id, tenant_id);

-- 5. THE constraint, per room (Rule 1). Before the swap, prove the rows
--    already satisfy it (§ 2.1); with one room per unit it is the old
--    constraint's own truth, and the add would refuse otherwise anyway, but
--    this says why in words.
do $check$
declare
  v_pairs int;
begin
  select count(*) into v_pairs
  from public.bookings a
  join public.bookings b on b.room_id = a.room_id and b.id > a.id and b.during && a.during
  where (a.status = 'confirmed' or a.held) and (b.status = 'confirmed' or b.held);
  if v_pairs > 0 then
    raise exception 'room inventory: % pair(s) of taking rows already share a room and a span', v_pairs;
  end if;
end;
$check$;

alter table public.bookings drop constraint if exists bookings_no_overlap;
alter table public.bookings add  constraint bookings_no_overlap exclude using gist (
  room_id with =,
  during  with &&
) where (status = 'confirmed' or held);

-- 6. The assigner (Rule 3). BEFORE INSERT, named to fire after
--    bookings_aa_fill_group_and_reference (group_id) and
--    bookings_compute_during (during): Phase 0's spike listed the order, and
--    showed that a BEFORE ROW trigger sees the rows its own statement
--    inserted earlier, in every insert shape the doors use.
--
--    A row that names its room keeps it; the room must be active (a retired
--    room takes no new booking) and the FK says it is this unit's. A row
--    that names none gets, under a lock per unit:
--      1. a room this stay (group) used for this unit the night before and
--         does not use tonight, so a stay keeps its room and a stay of two
--         rooms of one type keeps both;
--      2. else the first active room, by sort_order, that this stay does not
--         use tonight and no TAKING row (confirmed or held) overlaps,
--         preferring one no pending row overlaps either;
--      3. else the room with the fewest pending overlaps: a pending row
--         holds nothing (D-070), and a confirmed or held one is refused by
--         the constraint, as before.
--    Definer: it must see every booking of the unit to choose, whatever the
--    caller's read policy (a staff role may lose bookings:read, D-128); it
--    returns nothing but the room it sets. Trigger-only.
create or replace function public.bookings_room_assign() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_room bigint;
begin
  if new.room_id is not null then
    if not exists (select 1 from public.unit_rooms r
                   where r.id = new.room_id and r.unit_id = new.unit_id and r.tenant_id = new.tenant_id and r.active) then
      raise exception 'That room is retired or is not one of this room type''s'
        using errcode = 'check_violation';
    end if;
    return new;
  end if;

  perform pg_advisory_xact_lock(hashtextextended('unit_rooms:' || new.unit_id::text, 0));

  -- 1. The room this stay had last night.
  select r.id into v_room
  from public.unit_rooms r
  where r.tenant_id = new.tenant_id and r.unit_id = new.unit_id and r.active
    and exists (select 1 from public.bookings p
                where p.tenant_id = new.tenant_id and p.group_id = new.group_id and p.room_id = r.id
                  and p.status <> 'cancelled' and p.booked_date = new.booked_date - 1)
    and not exists (select 1 from public.bookings q
                    where q.tenant_id = new.tenant_id and q.group_id = new.group_id and q.room_id = r.id
                      and q.status <> 'cancelled' and q.booked_date = new.booked_date)
    and not exists (select 1 from public.bookings t
                    where t.room_id = r.id and (t.status = 'confirmed' or t.held) and t.during && new.during)
  order by r.sort_order, r.id
  limit 1;

  -- 2. A free room, one no pending row wants first.
  if v_room is null then
    select r.id into v_room
    from public.unit_rooms r
    where r.tenant_id = new.tenant_id and r.unit_id = new.unit_id and r.active
      and not exists (select 1 from public.bookings q
                      where q.tenant_id = new.tenant_id and q.group_id = new.group_id and q.room_id = r.id
                        and q.status <> 'cancelled' and q.booked_date = new.booked_date)
      and not exists (select 1 from public.bookings t
                      where t.room_id = r.id and (t.status = 'confirmed' or t.held) and t.during && new.during)
    order by exists (select 1 from public.bookings p
                     where p.room_id = r.id and p.status = 'pending' and p.during && new.during),
             r.sort_order, r.id
    limit 1;
  end if;

  -- 3. Nothing free: the room with the fewest pending overlaps. A pending
  --    row holds nothing, so that is its room until Confirm; a confirmed or
  --    held row is then refused by bookings_no_overlap itself, the same 23P01
  --    and the same sentence as before this file (staff-clash § 2.5).
  if v_room is null then
    select r.id into v_room
    from public.unit_rooms r
    where r.tenant_id = new.tenant_id and r.unit_id = new.unit_id and r.active
    order by (select count(*) from public.bookings p
              where p.room_id = r.id and p.status = 'pending' and p.during && new.during),
             r.sort_order, r.id
    limit 1;
  end if;

  if v_room is null then
    raise exception '% has no active room to book', (select u.name from public.units u where u.id = new.unit_id)
      using errcode = 'check_violation';
  end if;

  new.room_id := v_room;
  return new;
end;
$$;
revoke all on function public.bookings_room_assign() from public, anon, authenticated;

drop trigger if exists bookings_room_assign on public.bookings;
create trigger bookings_room_assign
  before insert on public.bookings
  for each row execute function public.bookings_room_assign();

-- 7. Retiring and deleting a room (the D-090 pattern). A room with an
--    upcoming booking, pending or confirmed, is not retired: move the
--    booking first (Phase 3). An active unit keeps at least one active room.
--    A booked room is never deleted: bookings_room_fk (NO ACTION) refuses
--    it; an unbooked one may go, unless it is its active unit's last.
create or replace function public.unit_rooms_guard() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_unit_active boolean;
begin
  if tg_op = 'UPDATE' and not (old.active and not new.active) then
    return new;
  end if;
  select u.active into v_unit_active from public.units u where u.id = old.unit_id;
  -- A cascade from deleting the unit or the tenant. The parent row is gone
  -- before its cascades run, but a tenant's cascade may reach this room
  -- before it reaches the unit, so the tenant is asked too.
  if v_unit_active is null or not exists (select 1 from public.tenants t where t.id = old.tenant_id) then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if tg_op = 'UPDATE' and exists (
    select 1 from public.bookings b
    where b.room_id = old.id and b.status in ('pending', 'confirmed') and upper(b.during) > now()
  ) then
    raise exception '% has upcoming bookings; move them to another room first', old.name
      using errcode = 'check_violation';
  end if;
  if old.active and v_unit_active and not exists (
    select 1 from public.unit_rooms r where r.unit_id = old.unit_id and r.active and r.id <> old.id
  ) then
    raise exception '% is the last room of its type; retire the room type instead', old.name
      using errcode = 'check_violation';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;
revoke all on function public.unit_rooms_guard() from public, anon, authenticated;

drop trigger if exists unit_rooms_guard on public.unit_rooms;
create trigger unit_rooms_guard
  before update of active or delete on public.unit_rooms
  for each row execute function public.unit_rooms_guard();

-- 8. A whole-resort unit is the one property: it has exactly one active
--    room. Deferred, like units_whole_resort_one_active, so a swap inside
--    one transaction is allowed.
create or replace function public.unit_rooms_whole_resort_one() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if public.booking_type_of(new.tenant_id) = 'whole_resort'
     and (select count(*) from public.unit_rooms r where r.unit_id = new.unit_id and r.active) > 1 then
    raise exception 'A whole-resort property has one room; this one would have more'
      using errcode = 'check_violation';
  end if;
  return null;
end;
$$;
revoke all on function public.unit_rooms_whole_resort_one() from public, anon, authenticated;

drop trigger if exists unit_rooms_whole_resort_one on public.unit_rooms;
create constraint trigger unit_rooms_whole_resort_one
  after insert or update of active on public.unit_rooms
  deferrable initially deferred
  for each row execute function public.unit_rooms_whole_resort_one();

commit;
