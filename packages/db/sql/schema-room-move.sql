-- schema-room-move.sql — staff move a stay to another room of the same type
-- (D-133, plan/room-types.md Phase 3, Rule 4). The 39th file.
--
-- Run AFTER schema-room-counts.sql. Safe to re-run IN ORDER (trap 25): it
-- widens a check constraint (every row the older ones allowed still passes)
-- and creates or replaces its own functions only; it replaces no older one.
--
-- The assigner picks a room when a booking is made; the re-pick moves it at
-- Confirm if it has to. Staff may still want it elsewhere: a guest asks for
-- the room by the pool, or two stays should swap. From here:
--   * move_room() moves every remaining night of a stay that sits in one
--     room to another room of the SAME type, in one statement, and writes
--     the decision to booking_events with its note (D-096);
--   * bookings_room_move_guard refuses any update of room_id onto a room
--     that is retired, or taken (confirmed or held) for one of those nights,
--     in the words taken.ts passes through. A pending row holds nothing
--     (D-070), but it is not MOVED onto a night someone holds, just as it is
--     not BORN on one (D-099). The FK bookings_room_fk keeps the type.
--   * a move never changes the price: unit, slot, date, guests and promo
--     stay, so bookings_compute_during keeps the stored amounts.

begin;

-- 1. The event log learns a fourth kind of decision.
alter table public.booking_events drop constraint if exists booking_events_kind;
alter table public.booking_events add constraint booking_events_kind
  check (kind in ('created', 'status', 'payment', 'change', 'room'));

-- 2. The guard: every door that changes room_id meets it, staff tokens
--    writing the row by hand included. Definer, because it must see who
--    holds the room whatever the caller may read. Trigger-only.
create or replace function public.bookings_room_move_guard() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_room text;
  v_held boolean;
begin
  if new.room_id is not distinct from old.room_id or new.status not in ('pending', 'confirmed') then
    return new;
  end if;
  select r.name into v_room
  from public.unit_rooms r
  where r.id = new.room_id and r.unit_id = new.unit_id and r.tenant_id = new.tenant_id and r.active;
  if v_room is null then
    raise exception 'That room is retired or is not one of this room type''s'
      using errcode = 'check_violation';
  end if;
  select (t.status <> 'confirmed') into v_held
  from public.bookings t
  where t.room_id = new.room_id and t.id <> new.id
    and (t.status = 'confirmed' or t.held) and t.during && new.during
  order by (t.status = 'confirmed') desc
  limit 1;
  if found then
    raise exception 'taken on %: % is %', new.booked_date, v_room,
      case when v_held then 'held for another guest for that slot' else 'already confirmed for that slot' end
      using errcode = 'exclusion_violation';
  end if;
  if exists (select 1 from public.bookings g
             where g.tenant_id = new.tenant_id and g.group_id = new.group_id and g.id <> new.id
               and g.room_id = new.room_id and g.status in ('pending', 'confirmed') and g.booked_date = new.booked_date) then
    raise exception 'This stay already uses % on %', v_room, new.booked_date
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
revoke all on function public.bookings_room_move_guard() from public, anon, authenticated;

drop trigger if exists bookings_room_move_guard on public.bookings;
create trigger bookings_room_move_guard
  before update of room_id on public.bookings
  for each row execute function public.bookings_room_move_guard();

-- 3. The move. Definer, so it can write the event row (booking_events has
--    no insert policy: only triggers and definers write it), and therefore
--    it checks its caller itself: a member of THIS tenant's staff whose role
--    may write bookings (app_can, D-128). The booking is any row of the
--    stay; what moves is every live, not-yet-ended row of that stay in the
--    same room. Returns how many rows moved; null when the booking is not
--    this tenant's or not there (the route's 404, one answer for both).
create or replace function public.move_room(
  p_tenant_id  bigint,
  p_booking_id bigint,
  p_room_id    bigint,
  p_note       text
) returns int
language plpgsql security definer
set search_path = ''
as $$
declare
  v_b     record;
  v_from  text;
  v_to    text;
  v_note  text := nullif(btrim(coalesce(p_note, '')), '');
  v_count int;
begin
  if p_tenant_id is distinct from public.app_tenant_id() or not public.app_can('bookings:write') then
    raise exception 'move_room: not staff of tenant % with bookings:write', p_tenant_id
      using errcode = 'insufficient_privilege';
  end if;
  if v_note is null then
    raise exception 'Write why the booking moves' using errcode = 'invalid_parameter_value';
  end if;
  if char_length(v_note) > 500 then
    raise exception 'A note is at most 500 characters' using errcode = 'invalid_parameter_value';
  end if;

  select b.id, b.unit_id, b.room_id, b.group_id into v_b
  from public.bookings b
  where b.tenant_id = p_tenant_id and b.id = p_booking_id;
  if v_b.id is null then
    return null;
  end if;
  select r.name into v_from from public.unit_rooms r where r.id = v_b.room_id;
  select r.name into v_to
  from public.unit_rooms r
  where r.tenant_id = p_tenant_id and r.id = p_room_id and r.unit_id = v_b.unit_id;
  if v_to is null then
    raise exception 'That room is not one of this room type''s' using errcode = 'invalid_parameter_value';
  end if;
  if p_room_id = v_b.room_id then
    raise exception 'The booking is already in %', v_to using errcode = 'invalid_parameter_value';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('unit_rooms:' || v_b.unit_id::text, 0));

  update public.bookings b
  set room_id = p_room_id
  where b.tenant_id = p_tenant_id and b.group_id = v_b.group_id and b.room_id = v_b.room_id
    and b.status in ('pending', 'confirmed') and upper(b.during) > now();
  get diagnostics v_count = row_count;
  if v_count = 0 then
    raise exception 'Nothing left to move: the stay has ended or is cancelled' using errcode = 'invalid_parameter_value';
  end if;

  insert into public.booking_events (tenant_id, group_id, actor_kind, actor_user, kind, from_value, to_value, row_count, note)
  values (p_tenant_id, v_b.group_id, 'staff', auth.uid(), 'room', v_from, v_to, v_count, v_note);
  return v_count;
end;
$$;
revoke all on function public.move_room(bigint, bigint, bigint, text) from public, anon, authenticated;
grant execute on function public.move_room(bigint, bigint, bigint, text) to authenticated;

notify pgrst, 'reload schema';

commit;
