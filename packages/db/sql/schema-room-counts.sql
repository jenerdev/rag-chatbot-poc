-- schema-room-counts.sql — "taken" is a count of rooms (D-133, plan/room-types.md
-- Phase 2). The 38th file.
--
-- Run AFTER schema-room-inventory.sql. Safe to re-run IN ORDER (trap 25).
-- It replaces six definitions from older files, each of which is now
-- GUARDED on this file's marker, room_for() (trap 20):
--   * check_availability, check_room_availability, request_booking and
--     bookings_pending_not_taken (schema-holds.sql, steps 10–13);
--   * stay_taken (schema-stay-outcome.sql);
--   * bookings_room_assign (schema-room-inventory.sql, the one before this;
--     same signature, so a re-run of that file in order is followed by this).
--
-- Since the 37th file a unit (a room TYPE) has rooms, and the constraint
-- refuses a double booking per ROOM. Everything that said "taken" still asked
-- "does this UNIT have a taking row", so a second Casa Uno was never offered.
-- From here:
--   * a type is taken on a span when NO active room of it is free; the
--     per_room read says how many are (rooms_free of rooms_total);
--   * request_booking() may name a type several times, up to its free rooms;
--   * a pending row is refused when this stay already needs every free room
--     of its type; a single-room type gets exactly the old words;
--   * Confirm, or a hold, re-picks the room when the one assigned at request
--     time has been taken since (a pending row holds nothing, D-070);
--   * stay_taken() says a pending stay cannot go ahead when it needs more
--     rooms of a type than are free.
-- A type with one room behaves exactly as before: every count is 0 or 1.

begin;

-- 1. The ONE room picker (Rule 3), for the insert assigner and the re-pick.
--    The first active room of the unit that this stay does not use on that
--    date and that no TAKING row (confirmed or held, the constraint's own
--    predicate) overlaps, preferring the room this stay had the night
--    before, then one no other stay's pending row wants. p_self is the row
--    being placed, so an UPDATE does not count itself. Null when none is
--    free. Called only from definer triggers; no token may call it.
create or replace function public.room_for(
  p_tenant_id bigint,
  p_unit_id   bigint,
  p_group_id  uuid,
  p_date      date,
  p_during    tstzrange,
  p_self      bigint
) returns bigint
language sql stable
set search_path = ''
as $$
  select r.id
  from public.unit_rooms r
  where r.tenant_id = p_tenant_id and r.unit_id = p_unit_id and r.active
    and not exists (select 1 from public.bookings q
                    where q.tenant_id = p_tenant_id and q.group_id = p_group_id and q.room_id = r.id
                      and q.status <> 'cancelled' and q.booked_date = p_date and q.id is distinct from p_self)
    and not exists (select 1 from public.bookings t
                    where t.room_id = r.id and t.id is distinct from p_self
                      and (t.status = 'confirmed' or t.held) and t.during && p_during)
  order by
    exists (select 1 from public.bookings p
            where p.tenant_id = p_tenant_id and p.group_id = p_group_id and p.room_id = r.id
              and p.status <> 'cancelled' and p.booked_date = p_date - 1 and p.id is distinct from p_self) desc,
    exists (select 1 from public.bookings p
            where p.room_id = r.id and p.status = 'pending' and p.id is distinct from p_self
              and p.group_id is distinct from p_group_id and p.during && p_during),
    r.sort_order, r.id
  limit 1
$$;
revoke all on function public.room_for(bigint, bigint, uuid, date, tstzrange, bigint) from public, anon, authenticated;

-- 2. The insert assigner, now through room_for(). Unchanged in effect.
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
  v_room := public.room_for(new.tenant_id, new.unit_id, new.group_id, new.booked_date, new.during, null);

  -- Nothing free: the room with the fewest pending overlaps. A pending row
  -- holds nothing; a confirmed or held one is refused there by
  -- bookings_no_overlap, with the constraint's own 23P01.
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

-- 3. The re-pick (Rule 3). When a row starts TAKING its span (pending →
--    confirmed, or a hold), and its room has been taken since it was
--    assigned, it moves to another free room of the same type. With none
--    free, the room stays and the constraint answers 23P01 as before: the
--    409 now means "every room of this type is taken". A row whose room the
--    caller changed in the same UPDATE (a move, Phase 3) keeps it. Named to
--    fire after bookings_aa0_release_before_confirm (a lapsed hold is
--    released first) and bookings_compute_during.
create or replace function public.bookings_room_repick() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_room bigint;
begin
  if new.room_id is distinct from old.room_id then
    return new;
  end if;
  if not ((new.status = 'confirmed' and old.status is distinct from 'confirmed')
          or (new.held and not coalesce(old.held, false))) then
    return new;
  end if;
  perform pg_advisory_xact_lock(hashtextextended('unit_rooms:' || new.unit_id::text, 0));
  if not exists (select 1 from public.bookings t
                 where t.room_id = new.room_id and t.id <> new.id
                   and (t.status = 'confirmed' or t.held) and t.during && new.during) then
    return new;
  end if;
  v_room := public.room_for(new.tenant_id, new.unit_id, new.group_id, new.booked_date, new.during, new.id);
  if v_room is not null then
    new.room_id := v_room;
  end if;
  return new;
end;
$$;
revoke all on function public.bookings_room_repick() from public, anon, authenticated;

drop trigger if exists bookings_room_repick on public.bookings;
create trigger bookings_room_repick
  before update of status, held on public.bookings
  for each row execute function public.bookings_room_repick();

-- 4. bookings_pending_not_taken(), from schema-holds.sql, counting rooms. A
--    pending row is refused when the free rooms of its type, less the ones
--    this stay already needs on that span (its earlier rows in the same
--    statement are visible, Phase 0's spike), are none. A type with ONE room
--    keeps the old words exactly; with more it says "every <type>", which
--    taken.ts passes through unchanged. Still security invoker.
create or replace function public.bookings_pending_not_taken() returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_unit      text;
  v_total     int;
  v_free_conf int;
  v_free_take int;
  v_mine      int;
begin
  if new.status <> 'pending' then
    return new;   -- a confirmed insert is the constraint's to judge; a cancelled one holds nothing
  end if;
  if new.during is null then
    raise exception 'booking on % has no span to check', new.booked_date using errcode = 'exclusion_violation';
  end if;
  select u.name into v_unit from public.units u where u.tenant_id = new.tenant_id and u.id = new.unit_id;
  select count(*),
         count(*) filter (where not exists (
           select 1 from public.bookings c
           where c.tenant_id = new.tenant_id and c.room_id = r.id
             and c.status = 'confirmed' and c.during && new.during)),
         count(*) filter (where not exists (
           select 1 from public.bookings c
           where c.tenant_id = new.tenant_id and c.room_id = r.id
             and public.booking_takes(c.status, c.held, c.held_until) and c.during && new.during))
    into v_total, v_free_conf, v_free_take
  from public.unit_rooms r
  where r.tenant_id = new.tenant_id and r.unit_id = new.unit_id and r.active;
  select count(*) into v_mine
  from public.bookings g
  where g.tenant_id = new.tenant_id and g.group_id = new.group_id and g.unit_id = new.unit_id
    and g.status <> 'cancelled' and g.during && new.during;

  if v_free_conf - v_mine <= 0 then
    raise exception 'taken on %: % is already confirmed for that slot', new.booked_date,
      case when v_total > 1 then 'every ' || v_unit else coalesce(v_unit, 'that unit') end
      using errcode = 'exclusion_violation';
  end if;
  -- schema-holds.sql: a live hold blocks a new pending row too, in its own words.
  if v_free_take - v_mine <= 0 then
    raise exception 'taken on %: % is held for another guest for that slot', new.booked_date,
      case when v_total > 1 then 'every ' || v_unit else coalesce(v_unit, 'that unit') end
      using errcode = 'exclusion_violation';
  end if;
  return new;
end;
$$;

-- 5. check_availability(), from schema-holds.sql: same columns, same grants
--    (create OR REPLACE); `taken` now means no active room of the unit is
--    free. For a whole-resort tenant (one unit, one room) nothing changes.
create or replace function public.check_availability (
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
      case when not exists (
        select 1
        from public.unit_rooms r
        where r.tenant_id = p_tenant_id and r.unit_id = u.id and r.active
          and not exists (
            select 1
            from public.bookings b
            where b.tenant_id = p_tenant_id
              and b.room_id = r.id
              and public.booking_takes(b.status, b.held, b.held_until)
              and b.during && public.slot_range(d::date, s.start_time, s.duration, v_timezone))
      ) then 'taken' else 'open' end
    from generate_series(p_from, p_to, interval '1 day') as d
    cross join public.units u
    join public.slots s on s.tenant_id = u.tenant_id
    where u.tenant_id = p_tenant_id
      and u.active
    order by d, u.name, s.start_time, s.name;
end;
$$;

-- 6. check_room_availability(), from schema-holds.sql, with two more
--    columns at the END: rooms_free and rooms_total (active rooms). A new
--    return type cannot be "create or replace"d, so it is dropped and made
--    again, and its grants with it (schema-day-price.sql's pair). Callers
--    map rows field by field (CLAUDE.md rule 7), so no read leaks the counts
--    until one chooses to (Phase 5).
drop function if exists public.check_room_availability(bigint, date, date, text, text, int);
create function public.check_room_availability (
  p_tenant_id bigint,
  p_from      date,
  p_to        date,
  p_slot      text,
  p_unit      text,
  p_guests    int
)
returns table (
  booked_date       date,
  unit              text,
  capacity          int,
  standard_capacity int,
  extra_person_rate bigint,
  slot              text,
  status            text,
  price             bigint,
  extra_guest_price bigint,
  total             bigint,
  day_price         bigint,
  rooms_free        int,
  rooms_total       int
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
    raise exception 'check_room_availability: tenant % is not the token''s tenant', p_tenant_id
      using errcode = 'insufficient_privilege';
  end if;
  if p_to < p_from then
    raise exception 'p_to (%) is before p_from (%)', p_to, p_from using errcode = 'invalid_parameter_value';
  end if;
  if p_to - p_from > 366 then
    raise exception 'A range of % days is too long; the limit is 366', p_to - p_from
      using errcode = 'invalid_parameter_value';
  end if;
  if p_guests is not null and p_guests <= 0 then
    raise exception 'p_guests must be positive, not %', p_guests using errcode = 'invalid_parameter_value';
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
      u.capacity,
      u.standard_capacity,
      u.extra_person_rate,
      s.name,
      case when rc.free = 0 then 'taken' else 'open' end,
      q.base_price,
      q.extra_guest_price,
      q.price,
      d0.price,
      rc.free,
      rc.total
    from generate_series(p_from, p_to, interval '1 day') as d
    cross join public.units u
    join public.slots s on s.tenant_id = u.tenant_id
    cross join lateral (
      select count(*)::int as total,
             (count(*) filter (where not exists (
                select 1
                from public.bookings b
                where b.tenant_id = p_tenant_id
                  and b.room_id = r.id
                  and public.booking_takes(b.status, b.held, b.held_until)
                  and b.during && public.slot_range(d::date, s.start_time, s.duration, v_timezone))))::int as free
      from public.unit_rooms r
      where r.tenant_id = p_tenant_id and r.unit_id = u.id and r.active
    ) rc
    cross join lateral public.unit_quote(p_tenant_id, u.id, s.id, d::date, p_guests) q
    cross join lateral public.unit_quote(p_tenant_id, u.id, s.id, d::date, null) d0
    where u.tenant_id = p_tenant_id
      and u.active
      and (p_slot   is null or s.name = p_slot)
      and (p_unit   is null or u.name = p_unit)
      and (p_guests is null or u.capacity is null or u.capacity >= p_guests)
    order by d, u.sort_order, u.name, s.start_time, s.name;
end;
$$;
revoke all on function public.check_room_availability(bigint, date, date, text, text, int) from public, anon, authenticated;
grant execute on function public.check_room_availability(bigint, date, date, text, text, int) to authenticated, service_role;

-- 7. request_booking(), from schema-holds.sql: a type may be named several
--    times, once per room wanted, up to its active rooms; and the date
--    check counts the free rooms of each type against how many this
--    request wants. Same signature, so its grants and its wrapper
--    (request_booking_with_consent, schema-legal.sql) are unchanged.
-- GUARDED (D-147, 2026-10-26): schema-free-guests.sql replaces this with p_free (and drops this signature).
-- Once that file has run, re-running THIS file must not put a body with no
-- free count back, so the definition is skipped (CLAUDE.md trap 20).
do $guard$
begin
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'bookings' and column_name = 'free_guests') then
    execute $ddl$
create or replace function public.request_booking (
  p_tenant_id  bigint,
  p_slot_id    bigint,
  p_unit_ids   bigint[],
  p_guests     int[],
  p_check_in   date,
  p_nights     int,
  p_name       text,
  p_phone      text,
  p_email      text,
  p_notes      text,
  p_promo_code text default null
)
returns table (
  reference         text,
  booked_date       date,
  unit              text,
  slot              text,
  starts_at         timestamptz,
  ends_at           timestamptz,
  guests            int,
  base_price        bigint,
  extra_guest_price bigint,
  surcharge         bigint,
  discount          bigint,
  price             bigint
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_max_nights  int;
  v_max_advance int;
  c_max_open      constant int := 3;
  c_max_rows      constant int := 70;
  v_timezone text;
  v_slug     text;
  v_start    time;
  v_duration interval;
  v_nightly  boolean;
  v_today    date;
  v_units    int;
  v_name     text;
  v_phone    text;
  v_email    text;
  v_notes    text;
  v_open     int;
  v_group    uuid := gen_random_uuid();
  v_ref      text;
  v_code     text;
  v_subtotal bigint;
  v_promo    record;
  v_short    text;
begin
  if coalesce(auth.jwt() ->> 'role', '') <> 'service_role'
     and p_tenant_id is distinct from public.app_tenant_id() then
    raise exception 'request_booking: tenant % is not the token''s tenant', p_tenant_id
      using errcode = 'insufficient_privilege';
  end if;

  select a.config->>'timezone', t.slug,
         coalesce((a.config->>'max_stay_nights')::int, 14),
         coalesce((a.config->>'max_advance_days')::int, 365)
    into v_timezone, v_slug, v_max_nights, v_max_advance
  from public.tenant_applications a
  join public.tenants t on t.id = a.tenant_id
  where a.tenant_id = p_tenant_id and a.application_key = 'bookings';
  if v_timezone is null then
    raise exception 'This business does not take bookings' using errcode = 'invalid_parameter_value';
  end if;

  select s.start_time, s.duration, s.nightly into v_start, v_duration, v_nightly
  from public.slots s
  where s.tenant_id = p_tenant_id and s.id = p_slot_id;
  if v_start is null then
    raise exception 'No such booking slot' using errcode = 'invalid_parameter_value';
  end if;

  v_today := (now() at time zone v_timezone)::date;
  if p_check_in is null or p_nights is null then
    raise exception 'A date and a number of nights are required' using errcode = 'invalid_parameter_value';
  end if;
  if p_nights < 1 or p_nights > v_max_nights then
    raise exception 'A stay is 1 to % nights, not %', v_max_nights, p_nights using errcode = 'invalid_parameter_value';
  end if;
  if p_nights > 1 and not v_nightly then
    raise exception 'Only an overnight slot can be booked for several nights' using errcode = 'invalid_parameter_value';
  end if;
  if p_check_in > v_today + v_max_advance then
    raise exception 'Bookings open % days ahead; % is too far', v_max_advance, p_check_in using errcode = 'invalid_parameter_value';
  end if;
  if lower(public.slot_range(p_check_in, v_start, v_duration, v_timezone)) <= now() then
    raise exception 'That date has already started or passed' using errcode = 'invalid_parameter_value';
  end if;

  v_units := coalesce(cardinality(p_unit_ids), 0);
  if v_units = 0 or v_units <> coalesce(cardinality(p_guests), 0) then
    raise exception 'Choose at least one unit, with a guest count for each' using errcode = 'invalid_parameter_value';
  end if;
  if array_position(p_unit_ids, null) is not null or array_position(p_guests, null) is not null
     or exists (select 1 from unnest(p_guests) g where g < 1) then
    raise exception 'Every unit needs a guest count of at least 1' using errcode = 'invalid_parameter_value';
  end if;
  -- D-133: a unit of another tenant (or none) is refused by name here, as the
  -- insert's composite FK refused it before: the room counts below would
  -- otherwise call it "no longer available".
  if exists (select 1 from unnest(p_unit_ids) as w(unit_id)
             where not exists (select 1 from public.units un where un.tenant_id = p_tenant_id and un.id = w.unit_id)) then
    raise exception 'No such room' using errcode = 'foreign_key_violation';
  end if;
  -- D-133: a type named twice is two rooms of it; never more than it has.
  select format('%s has %s room%s; %s were asked for', un.name, x.rooms, case when x.rooms = 1 then '' else 's' end, x.wanted)
    into v_short
  from (select w.unit_id, count(*) as wanted,
               (select count(*) from public.unit_rooms r
                where r.tenant_id = p_tenant_id and r.unit_id = w.unit_id and r.active) as rooms
        from unnest(p_unit_ids) as w(unit_id)
        group by w.unit_id) x
  join public.units un on un.tenant_id = p_tenant_id and un.id = x.unit_id
  where x.wanted > x.rooms
  order by un.sort_order, un.name
  limit 1;
  if v_short is not null then
    raise exception '%', v_short using errcode = 'invalid_parameter_value';
  end if;
  if public.booking_type_of(p_tenant_id) = 'whole_resort' and v_units <> 1 then
    raise exception 'A whole-resort booking is for the one property' using errcode = 'invalid_parameter_value';
  end if;
  if v_units * p_nights > c_max_rows then
    raise exception 'That is % room-nights; the limit is %', v_units * p_nights, c_max_rows using errcode = 'invalid_parameter_value';
  end if;

  v_name  := btrim(coalesce(p_name, ''));
  v_phone := regexp_replace(coalesce(p_phone, ''), '[\s().-]', '', 'g');
  if v_phone like '+63%' then v_phone := '0' || substr(v_phone, 4); end if;
  v_email := lower(btrim(coalesce(p_email, '')));
  v_notes := nullif(btrim(coalesce(p_notes, '')), '');
  v_code  := nullif(btrim(coalesce(p_promo_code, '')), '');
  if char_length(v_name) not between 2 and 100 then
    raise exception 'A name of 2 to 100 characters is required' using errcode = 'invalid_parameter_value';
  end if;
  if v_phone !~ '^09[0-9]{9}$' then
    raise exception 'A mobile number like 0917 123 4567 is required' using errcode = 'invalid_parameter_value';
  end if;
  if char_length(v_email) > 254 or v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'A valid email address is required' using errcode = 'invalid_parameter_value';
  end if;
  if char_length(v_notes) > 1000 then
    raise exception 'Notes are at most 1000 characters' using errcode = 'invalid_parameter_value';
  end if;
  if v_code is not null and v_code !~ '^[A-Za-z0-9_-]{3,32}$' then
    raise exception 'No such promo code' using errcode = 'invalid_parameter_value';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('request_booking:' || p_tenant_id::text, 0));

  select count(distinct b.group_id) into v_open
  from public.bookings b
  where b.tenant_id = p_tenant_id
    and b.source = 'web' and b.status = 'pending'
    and upper(b.during) > now()
    and (b.guest_phone = v_phone or b.guest_email = v_email);
  if v_open >= c_max_open then
    raise exception 'There are already % open requests for this contact; the resort will reply to those first', v_open
      using errcode = 'program_limit_exceeded';
  end if;

  -- D-133: each night, every type needs as many free rooms as this request
  -- names it; a room is free when no taking row overlaps it.
  if exists (
    select 1
    from (select w.unit_id, count(*) as wanted from unnest(p_unit_ids) as w(unit_id) group by w.unit_id) x
    cross join generate_series(0, p_nights - 1) as n
    where (select count(*) from public.unit_rooms r
           where r.tenant_id = p_tenant_id and r.unit_id = x.unit_id and r.active
             and not exists (
               select 1 from public.bookings b
               where b.tenant_id = p_tenant_id and b.room_id = r.id
                 and public.booking_takes(b.status, b.held, b.held_until)
                 and b.during && public.slot_range(p_check_in + n, v_start, v_duration, v_timezone))) < x.wanted
  ) then
    raise exception 'That date is no longer available' using errcode = 'exclusion_violation';
  end if;

  -- The promo (D-097), resolved under the lock so the usage count holds. The
  -- subtotal is the stay's price before any discount: what the automatic
  -- choice compares promos on (q3).
  select coalesce(sum(q.price), 0) into v_subtotal
  from unnest(p_unit_ids, p_guests) as u(unit_id, guests)
  cross join generate_series(0, p_nights - 1) as n
  cross join lateral public.unit_quote(p_tenant_id, u.unit_id, p_slot_id, p_check_in + n, u.guests) q;
  select f.* into v_promo
  from public.promo_for_request(p_tenant_id, v_code, p_check_in, p_check_in + p_nights - 1, v_subtotal) f;
  if v_code is not null and v_promo.id is null then
    raise exception 'No such promo code' using errcode = 'invalid_parameter_value';
  end if;
  if v_promo.reason = 'dates' then
    raise exception 'The promo "%" covers stays from % to %', v_promo.name, v_promo.valid_from, v_promo.valid_to
      using errcode = 'invalid_parameter_value';
  end if;
  if v_promo.reason = 'exhausted' then
    raise exception 'The promo "%" has reached its limit', v_promo.name using errcode = 'check_violation';
  end if;

  v_ref := public.booking_reference(p_tenant_id);   -- D-100: the ONE place the shape is written

  -- ONE insert, in DATE order, so the trigger's "first row of the stay" is
  -- the first night (§ 2.2). The trigger sets `during`, the price and the
  -- discount of every row, and refuses the promo if it stopped applying.
  insert into public.bookings
    (tenant_id, unit_id, slot_id, booked_date, status, source,
     guest_name, guest_phone, guest_email, guest_count, notes, group_id, reference, promo_id)
  select p_tenant_id, u.unit_id, p_slot_id, p_check_in + n, 'pending', 'web',
         v_name, v_phone, v_email, u.guests, v_notes, v_group, v_ref, v_promo.id
  from unnest(p_unit_ids, p_guests) with ordinality as u(unit_id, guests, ord)
  cross join generate_series(0, p_nights - 1) as n
  order by n, u.ord;

  if exists (select 1 from public.bookings b
              where b.tenant_id = p_tenant_id and b.group_id = v_group and b.price is null) then
    raise exception 'This slot has no price yet' using errcode = 'invalid_parameter_value';
  end if;

  return query
    select b.reference, b.booked_date, un.name, s.name, lower(b.during), upper(b.during),
           b.guest_count, b.base_price, b.extra_guest_price, b.surcharge, b.discount, b.price
    from public.bookings b
    join public.units un on un.tenant_id = b.tenant_id and un.id = b.unit_id
    join public.slots s  on s.tenant_id  = b.tenant_id and s.id  = b.slot_id
    where b.tenant_id = p_tenant_id and b.group_id = v_group
    order by b.booked_date, un.sort_order, un.name;
end;
$$;
$ddl$;
  end if;
end
$guard$;

-- 8. stay_taken(), from schema-stay-outcome.sql: a pending stay cannot go
--    ahead when, on some night, it needs more rooms of a type than other
--    stays leave free. The words are the old ones.
create or replace function public.stay_taken(p_tenant_id bigint, p_group_id uuid)
returns text
language sql
stable
set search_path = ''
as $$
  with need as (
    select b.unit_id, b.booked_date, b.during, count(*) as wanted
    from public.bookings b
    where b.tenant_id = p_tenant_id and b.group_id = p_group_id and b.status = 'pending'
    group by b.unit_id, b.booked_date, b.during
  ),
  short as (
    select n.*,
           (select count(*) from public.unit_rooms r
            where r.tenant_id = p_tenant_id and r.unit_id = n.unit_id and r.active
              and not exists (
                select 1 from public.bookings o
                where o.tenant_id = p_tenant_id and o.room_id = r.id
                  and o.group_id is distinct from p_group_id
                  and o.during && n.during
                  and public.booking_takes(o.status, o.held, o.held_until))) as free,
           exists (select 1 from public.bookings o
                   where o.tenant_id = p_tenant_id and o.unit_id = n.unit_id
                     and o.group_id is distinct from p_group_id
                     and o.during && n.during and o.status = 'confirmed') as by_confirmed
    from need n
  )
  select format('%s is no longer free on %s: %s.',
                u.name,
                to_char(s.booked_date, 'FMDy, FMDD Mon YYYY'),
                case when s.by_confirmed then 'another booking was confirmed for it'
                     else 'it is held for another guest' end)
  from short s
  join public.units u on u.tenant_id = p_tenant_id and u.id = s.unit_id
  where s.free < s.wanted
  order by s.booked_date, s.by_confirmed desc, u.name
  limit 1
$$;
revoke all on function public.stay_taken(bigint, uuid) from public, anon, authenticated;

notify pgrst, 'reload schema';

commit;
