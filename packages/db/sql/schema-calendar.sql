-- schema-calendar.sql — the staff calendar's four reads (plan/calendar.md, D-103).
--
-- Run after schema-staff-requests.sql. Idempotent. The 22nd file. No table,
-- no column, no row written, and NO existing function replaced: this file
-- only adds, so re-running an older file cannot undo it (trap 20).
--
--   calendar_pending(p_tenant_id, p_from, p_to, p_unit_id)
--     One row per (date, room, slot, pending stay) where a PENDING booking's
--     span overlaps that slot. The ONE place "pending on this slot" is
--     decided; the other two count it, by distinct group_id (a three-room
--     request is one stay, plan § 2.3).
--
--   calendar_slots(p_tenant_id, p_from, p_to, p_unit_id)
--     One row per (date, active room, active slot): `state` closed | taken |
--     open, and `pending`. "Taken" is check_availability()'s own answer,
--     CALLED, not copied (plan Rule 1): the chatbot, the Bookings screen and
--     the calendar read one test. A closed date (D-080) is closed for every
--     slot, whatever the bookings say (plan § 2.2).
--
--   calendar_days(p_tenant_id, p_from, p_to, p_unit_id)
--     One row per date in the range, every date present: the roll-up of
--     calendar_slots() into closed | none | full | partial | available, the
--     counts, the date's rate kind and label, and `bookable` (not past, not
--     beyond max_advance_days, not closed). Never re-derives a slot's state.
--
--   calendar_bookings(p_tenant_id, p_day, p_unit_id)   (§ 5, added later)
--     The Day view's bookings: which pending or confirmed booking overlaps
--     which (room, slot) on one date, by id, with the same overlap test.
--
-- All three are security INVOKER, like tenant_dashboard(): bookings are read
-- under the caller's own RLS, and each refuses a caller that is not a member
-- of that tenant (42501), so a chat token gets a refusal, not a calendar that
-- reads "everything available" (plan Rule 2, trap 12). service_role is
-- allowed, for the tools. At most 62 days per call (a month grid is 42).
-- Dates are the tenant's (trap 9). Every name qualified (trap 19).

-- 1. Pending stays per slot.
create or replace function public.calendar_pending(p_tenant_id bigint, p_from date, p_to date, p_unit_id bigint default null)
returns table (day date, unit_id bigint, slot_id bigint, group_id uuid)
language plpgsql stable
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_timezone text;
begin
  if coalesce(auth.jwt() ->> 'role', '') <> 'service_role'
     and (p_tenant_id is distinct from public.app_tenant_id() or not public.app_is_staff()) then
    raise exception 'calendar: not a member of tenant %', p_tenant_id using errcode = 'insufficient_privilege';
  end if;
  if p_to < p_from or p_to - p_from > 61 then
    raise exception 'A calendar range is 1 to 62 days; % to % is not', p_from, p_to using errcode = 'invalid_parameter_value';
  end if;

  select a.config->>'timezone' into v_timezone
  from public.tenant_applications a
  where a.tenant_id = p_tenant_id and a.application_key = 'bookings';
  if v_timezone is null then
    return;
  end if;

  return query
    select distinct d::date, u.id, s.id, b.group_id
    from generate_series(p_from, p_to, interval '1 day') as d
    cross join public.units u
    join public.slots s on s.tenant_id = u.tenant_id and s.active
    join public.bookings b
      on b.tenant_id = u.tenant_id
     and b.unit_id = u.id
     and b.status = 'pending'
     and b.during && public.slot_range(d::date, s.start_time, s.duration, v_timezone)
    where u.tenant_id = p_tenant_id
      and u.active
      and (p_unit_id is null or u.id = p_unit_id);
end;
$$;

-- 2. Every (date, room, slot) with its state.
create or replace function public.calendar_slots(p_tenant_id bigint, p_from date, p_to date, p_unit_id bigint default null)
returns table (day date, unit_id bigint, unit text, slot_id bigint, slot text, state text, pending int)
language plpgsql stable
set search_path = ''
as $$
#variable_conflict use_column
begin
  if coalesce(auth.jwt() ->> 'role', '') <> 'service_role'
     and (p_tenant_id is distinct from public.app_tenant_id() or not public.app_is_staff()) then
    raise exception 'calendar: not a member of tenant %', p_tenant_id using errcode = 'insufficient_privilege';
  end if;
  if p_to < p_from or p_to - p_from > 61 then
    raise exception 'A calendar range is 1 to 62 days; % to % is not', p_from, p_to using errcode = 'invalid_parameter_value';
  end if;

  -- check_availability() returns names; both are unique per tenant
  -- (units_tenant_name_key, slots_tenant_name_key), so the join back to ids
  -- is exact. It keeps retired slots, which the calendar leaves out, as
  -- listSlots() and checkAvailability() do.
  return query
    with pend as (
      select p.day, p.unit_id, p.slot_id, count(distinct p.group_id)::int as n
      from public.calendar_pending(p_tenant_id, p_from, p_to, p_unit_id) p
      group by 1, 2, 3
    )
    select
      av.booked_date,
      u.id,
      u.name,
      s.id,
      s.name,
      case when public.rate_kind(p_tenant_id, av.booked_date) = 'closed' then 'closed' else av.status end,
      coalesce(pend.n, 0)
    from public.check_availability(p_tenant_id, p_from, p_to) av
    join public.units u on u.tenant_id = p_tenant_id and u.name = av.unit
    join public.slots s on s.tenant_id = p_tenant_id and s.name = av.slot and s.active
    left join pend on pend.day = av.booked_date and pend.unit_id = u.id and pend.slot_id = s.id
    where p_unit_id is null or u.id = p_unit_id
    order by av.booked_date, u.sort_order, u.name, s.start_time, s.name;
end;
$$;

-- 3. Every date with its roll-up.
create or replace function public.calendar_days(p_tenant_id bigint, p_from date, p_to date, p_unit_id bigint default null)
returns table (day date, state text, taken int, sellable int, pending int, rate_kind text, label text, bookable boolean)
language plpgsql stable
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_timezone text;
  v_advance  int;
  v_today    date;
begin
  if coalesce(auth.jwt() ->> 'role', '') <> 'service_role'
     and (p_tenant_id is distinct from public.app_tenant_id() or not public.app_is_staff()) then
    raise exception 'calendar: not a member of tenant %', p_tenant_id using errcode = 'insufficient_privilege';
  end if;
  if p_to < p_from or p_to - p_from > 61 then
    raise exception 'A calendar range is 1 to 62 days; % to % is not', p_from, p_to using errcode = 'invalid_parameter_value';
  end if;

  -- The booking page's own window (D-078): the same config, the same default.
  select a.config->>'timezone', coalesce((a.config->>'max_advance_days')::int, 365)
    into v_timezone, v_advance
  from public.tenant_applications a
  where a.tenant_id = p_tenant_id and a.application_key = 'bookings';
  v_today := (now() at time zone coalesce(v_timezone, 'Asia/Manila'))::date;

  return query
    with slots as (
      select * from public.calendar_slots(p_tenant_id, p_from, p_to, p_unit_id)
    ),
    agg as (
      select s.day, count(*)::int as sellable, (count(*) filter (where s.state = 'taken'))::int as taken
      from slots s
      group by s.day
    ),
    pend as (
      select p.day, count(distinct p.group_id)::int as n
      from public.calendar_pending(p_tenant_id, p_from, p_to, p_unit_id) p
      group by p.day
    )
    select
      d::date,
      -- Closed first (nothing can be sold); then 0 of 0 is "none", never
      -- "available" (plan § 2.1); then the counts.
      case
        when rk.kind = 'closed' then 'closed'
        when coalesce(agg.sellable, 0) = 0 then 'none'
        when agg.taken = agg.sellable then 'full'
        when agg.taken > 0 then 'partial'
        else 'available'
      end,
      coalesce(agg.taken, 0),
      coalesce(agg.sellable, 0),
      coalesce(pend.n, 0),
      rk.kind,
      rc.label,
      (rk.kind is distinct from 'closed' and d::date >= v_today and d::date <= v_today + v_advance and v_timezone is not null)
    from generate_series(p_from, p_to, interval '1 day') as d
    cross join lateral (select public.rate_kind(p_tenant_id, d::date) as kind) rk
    left join agg on agg.day = d::date
    left join pend on pend.day = d::date
    left join public.rate_calendar rc on rc.tenant_id = p_tenant_id and rc.day = d::date
    order by 1;
end;
$$;

-- 4. EXECUTE grants: tokens, never anon. The functions check the caller.
revoke all on function public.calendar_pending(bigint, date, date, bigint) from public, anon, authenticated;
revoke all on function public.calendar_slots(bigint, date, date, bigint)   from public, anon, authenticated;
revoke all on function public.calendar_days(bigint, date, date, bigint)    from public, anon, authenticated;
grant execute on function public.calendar_pending(bigint, date, date, bigint) to authenticated, service_role;
grant execute on function public.calendar_slots(bigint, date, date, bigint)   to authenticated, service_role;
grant execute on function public.calendar_days(bigint, date, date, bigint)    to authenticated, service_role;

-- 5. The Day view's bookings (added 2026-10-09, the user: "when slot is
--    taken, show booking details, show guest info"). One row per (active
--    room, active slot, booking) where a PENDING or CONFIRMED booking's span
--    overlaps that slot on p_day: the same overlap test that makes a slot
--    taken (check_availability) or pending (calendar_pending), so a stay that
--    began the night before is found too. Ids only, and the booking's own
--    date and status: @rag/bookings takes the guest details from
--    listBookings(), the staff list, so they are mapped in one place.
create or replace function public.calendar_bookings(p_tenant_id bigint, p_day date, p_unit_id bigint default null)
returns table (unit_id bigint, slot_id bigint, booking_id bigint, booked_date date, status text)
language plpgsql stable
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_timezone text;
begin
  if coalesce(auth.jwt() ->> 'role', '') <> 'service_role'
     and (p_tenant_id is distinct from public.app_tenant_id() or not public.app_is_staff()) then
    raise exception 'calendar: not a member of tenant %', p_tenant_id using errcode = 'insufficient_privilege';
  end if;

  select a.config->>'timezone' into v_timezone
  from public.tenant_applications a
  where a.tenant_id = p_tenant_id and a.application_key = 'bookings';
  if v_timezone is null then
    return;
  end if;

  return query
    select u.id, s.id, b.id, b.booked_date, b.status
    from public.units u
    join public.slots s on s.tenant_id = u.tenant_id and s.active
    join public.bookings b
      on b.tenant_id = u.tenant_id
     and b.unit_id = u.id
     and b.status in ('pending', 'confirmed')
     and b.during && public.slot_range(p_day, s.start_time, s.duration, v_timezone)
    where u.tenant_id = p_tenant_id
      and u.active
      and (p_unit_id is null or u.id = p_unit_id)
    order by u.sort_order, u.name, s.start_time, b.status desc, b.booked_date, b.id;
end;
$$;

revoke all on function public.calendar_bookings(bigint, date, bigint) from public, anon, authenticated;
grant execute on function public.calendar_bookings(bigint, date, bigint) to authenticated, service_role;
