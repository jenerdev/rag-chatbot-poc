-- schema-room-views.sql — the staff screens count rooms (D-133, plan/room-types.md
-- Phase 4). The 40th file.
--
-- Run AFTER schema-room-move.sql. Safe to re-run IN ORDER (trap 25). It
-- replaces two definitions, each now GUARDED on this file's marker,
-- active_rooms() (trap 20):
--   * calendar_slots() (schema-calendar.sql): two more columns at the END,
--     rooms_taken and rooms_total, so a cell can say "1 of 2". A new return
--     type is dropped and made again, with its grants;
--   * tenant_dashboard() (schema-dashboard.sql), copied with two changes:
--     occupancy is room-nights over active ROOMS (it divided by active room
--     types, so two Casa Uno booked read as 200 %), and "would clash on
--     Confirm" counts rooms (two pending stays on a type of two rooms both
--     fit). The JSON keeps its keys: `activeUnits` now counts rooms, which is
--     what the screen already called them ("active rooms").
-- calendar_days() is unchanged: it reads calendar_slots()' `state`, which
-- check_availability already counts in rooms (schema-room-counts.sql).

begin;

-- 1. The active rooms of a room type. Security invoker: any token of the
--    tenant reads unit_rooms. Also the marker the older files' guards ask.
create or replace function public.active_rooms(p_unit_id bigint) returns int
language sql stable
set search_path = ''
as $$
  select count(*)::int from public.unit_rooms r where r.unit_id = p_unit_id and r.active
$$;
revoke all on function public.active_rooms(bigint) from public, anon;
grant execute on function public.active_rooms(bigint) to authenticated, service_role;

-- 2. calendar_slots(), from schema-calendar.sql, with the rooms taken (distinct
--    rooms of a taking row on the slot's span) and the type's active rooms.
drop function if exists public.calendar_slots(bigint, date, date, bigint);
create function public.calendar_slots(p_tenant_id bigint, p_from date, p_to date, p_unit_id bigint default null)
returns table (day date, unit_id bigint, unit text, slot_id bigint, slot text, state text, pending int, rooms_taken int, rooms_total int)
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
      coalesce(pend.n, 0),
      (select count(distinct b.room_id)::int
       from public.bookings b
       where b.tenant_id = p_tenant_id and b.unit_id = u.id
         and public.booking_takes(b.status, b.held, b.held_until)
         and b.during && public.slot_range(av.booked_date, s.start_time, s.duration, v_timezone)),
      public.active_rooms(u.id)
    from public.check_availability(p_tenant_id, p_from, p_to) av
    join public.units u on u.tenant_id = p_tenant_id and u.name = av.unit
    join public.slots s on s.tenant_id = p_tenant_id and s.name = av.slot and s.active
    left join pend on pend.day = av.booked_date and pend.unit_id = u.id and pend.slot_id = s.id
    where p_unit_id is null or u.id = p_unit_id
    order by av.booked_date, u.sort_order, u.name, s.start_time, s.name;
end;
$$;
revoke all on function public.calendar_slots(bigint, date, date, bigint) from public, anon, authenticated;
grant execute on function public.calendar_slots(bigint, date, date, bigint) to authenticated, service_role;

-- 3. tenant_dashboard(), from schema-dashboard.sql: same signature, so its
--    grants are kept; occupancy and "clashing" in rooms (see the header).
create or replace function public.tenant_dashboard(p_tenant_id bigint, p_days int default 30)
returns jsonb
language plpgsql stable
set search_path = ''
as $$
declare
  v_service  boolean := coalesce(auth.jwt() ->> 'role', '') = 'service_role';
  v_admin    boolean;
  v_days     int := least(greatest(coalesce(p_days, 30), 7), 90);
  v_timezone text;
  v_today    date;
  v_from_ts  timestamptz;   -- the window's start, as an instant
  v_ahead_to date;          -- the forward window's last day
  v_per_room boolean;
  v_units    int;
  v_chat     jsonb;
  v_know     jsonb;
  v_team     jsonb;
  v_book     jsonb;
  v_money    jsonb;
begin
  if not v_service and (p_tenant_id is distinct from public.app_tenant_id() or not public.app_is_staff()) then
    raise exception 'tenant_dashboard: not a member of tenant %', p_tenant_id using errcode = 'insufficient_privilege';
  end if;
  v_admin := v_service or public.app_is_admin();

  select coalesce(a.config->>'timezone', 'Asia/Manila') into v_timezone
  from public.tenant_applications a
  where a.tenant_id = p_tenant_id and a.application_key = 'bookings';
  v_timezone := coalesce(v_timezone, 'Asia/Manila');
  v_today    := (now() at time zone v_timezone)::date;
  v_from_ts  := ((v_today - v_days + 1)::timestamp at time zone v_timezone);
  v_ahead_to := v_today + 29;

  -- Chat: conversations per day in the window (every day present, zeros
  -- included, so the chart's x axis is the calendar), visitor messages,
  -- refusals (content = the NO_ANSWER marker, D-045) and the rate, and the
  -- open unanswered count over all time (the number staff act on).
  select jsonb_build_object(
    'conversations',   (select count(*) from public.conversations c where c.tenant_id = p_tenant_id and c.created_at >= v_from_ts),
    'visitorMessages', (select count(*) from public.messages m where m.tenant_id = p_tenant_id and m.role = 'user' and m.created_at >= v_from_ts),
    'refusals',        (select count(*) from public.messages m where m.tenant_id = p_tenant_id and m.role = 'assistant'
                          and m.content = 'I don''t know based on the documents I have.' and m.created_at >= v_from_ts),
    'assistantMessages', (select count(*) from public.messages m where m.tenant_id = p_tenant_id and m.role = 'assistant' and m.created_at >= v_from_ts),
    'openUnanswered',  (select count(*) from public.messages m
                          left join public.unanswered_resolutions r on r.message_id = m.id and r.tenant_id = m.tenant_id
                          where m.tenant_id = p_tenant_id and m.role = 'assistant'
                            and m.content = 'I don''t know based on the documents I have.' and r.message_id is null),
    'perDay', (select coalesce(jsonb_agg(jsonb_build_object('day', d.day::date, 'conversations', coalesce(c.n, 0)) order by d.day), '[]'::jsonb)
               from generate_series(v_today - v_days + 1, v_today, interval '1 day') as d(day)
               left join (
                 select (c.created_at at time zone v_timezone)::date as day, count(*) as n
                 from public.conversations c
                 where c.tenant_id = p_tenant_id and c.created_at >= v_from_ts
                 group by 1
               ) c on c.day = d.day::date)
  ) into v_chat;
  v_chat := v_chat || jsonb_build_object(
    'refusalRate', case when (v_chat->>'assistantMessages')::int = 0 then 0
                        else round((v_chat->>'refusals')::numeric * 100 / (v_chat->>'assistantMessages')::numeric, 1) end
  );

  -- Knowledge base and team.
  select jsonb_build_object(
    'documents', (select count(*) from public.documents d where d.tenant_id = p_tenant_id),
    'chunks',    (select count(*) from public.chunks k where k.tenant_id = p_tenant_id),
    'newest',    (select jsonb_build_object('title', d.title, 'createdAt', d.created_at)
                  from public.documents d where d.tenant_id = p_tenant_id order by d.created_at desc limit 1)
  ) into v_know;
  select jsonb_build_object(
    'owners', count(*) filter (where m.role = 'owner'),
    'admins', count(*) filter (where m.role = 'admin'),
    'staff',  count(*) filter (where m.role = 'staff')
  ) into v_team
  from public.memberships m where m.tenant_id = p_tenant_id;

  -- Bookings, only for a tenant with the application.
  if exists (select 1 from public.tenant_applications a where a.tenant_id = p_tenant_id and a.application_key = 'bookings') then
    v_per_room := public.booking_type_of(p_tenant_id) = 'per_room';
    -- D-133: occupancy is ROOM-nights over ROOMS: the active rooms of the active types.
    select count(*) into v_units from public.unit_rooms r join public.units u on u.id = r.unit_id
    where r.tenant_id = p_tenant_id and r.active and u.active;

    select jsonb_build_object(
      'attention', jsonb_build_object(
        'pendingRequests', (select count(distinct b.group_id) from public.bookings b
                            where b.tenant_id = p_tenant_id and b.source = 'web' and b.status = 'pending' and upper(b.during) > now()),
        'pendingStaff',    (select count(distinct coalesce(b.group_id::text, 'b' || b.id::text)) from public.bookings b
                            where b.tenant_id = p_tenant_id and b.source = 'staff' and b.status = 'pending' and upper(b.during) > now()),
        -- A pending stay that would clash on Confirm: its span is already CONFIRMED
        -- for the same unit (the 409, D-070), OR another PENDING stay wants the
        -- same unit and span (2026-10-05, D-098 amended: confirming either one
        -- makes the other the 409, so both count; since D-099 the first kind is
        -- rare, the second is the one staff see every day).
        'clashing',        (select count(distinct coalesce(p.group_id::text, 'b' || p.id::text)) from public.bookings p
                            where p.tenant_id = p_tenant_id and p.status = 'pending' and upper(p.during) > now()
                              -- D-133: counted in ROOMS. The rooms confirmed on the span, the
                              -- other pending stays that want the type then, and this one: more
                              -- than the type has, and confirming one makes another the 409.
                              and (select count(distinct c.room_id) from public.bookings c
                                   where c.tenant_id = p.tenant_id and c.unit_id = p.unit_id and c.during && p.during and c.status = 'confirmed')
                                + (select count(distinct coalesce(c.group_id::text, 'b' || c.id::text)) from public.bookings c
                                   where c.tenant_id = p.tenant_id and c.unit_id = p.unit_id and c.during && p.during and c.status = 'pending'
                                     and coalesce(c.group_id::text, 'b' || c.id::text) <> coalesce(p.group_id::text, 'b' || p.id::text))
                                + 1 > public.active_rooms(p.unit_id))
      ),
      'today', jsonb_build_object(
        'checkIns',  (select count(*) from public.bookings b where b.tenant_id = p_tenant_id and b.status = 'confirmed' and b.booked_date = v_today),
        'checkOuts', (select count(*) from public.bookings b where b.tenant_id = p_tenant_id and b.status = 'confirmed'
                        and (upper(b.during) at time zone v_timezone)::date = v_today),
        -- The next 7 days' confirmed check-ins: date, unit and the guest's NAME (staff see it on every row already; no phone, no email).
        'next7', (select coalesce(jsonb_agg(jsonb_build_object('date', b.booked_date, 'unit', u.name, 'guest', b.guest_name, 'slot', s.name) order by b.booked_date, u.sort_order, u.name), '[]'::jsonb)
                  from public.bookings b
                  join public.units u on u.tenant_id = b.tenant_id and u.id = b.unit_id
                  join public.slots s on s.tenant_id = b.tenant_id and s.id = b.slot_id
                  where b.tenant_id = p_tenant_id and b.status = 'confirmed' and b.booked_date between v_today and v_today + 6)
      ),
      -- Stays MADE in the window, by status and by source: distinct requests.
      'window', (select jsonb_build_object(
          'days',      v_days,
          'confirmed', count(distinct coalesce(b.group_id::text, 'b' || b.id::text)) filter (where b.status = 'confirmed'),
          'pending',   count(distinct coalesce(b.group_id::text, 'b' || b.id::text)) filter (where b.status = 'pending'),
          'cancelled', count(distinct coalesce(b.group_id::text, 'b' || b.id::text)) filter (where b.status = 'cancelled'),
          'web',       count(distinct coalesce(b.group_id::text, 'b' || b.id::text)) filter (where b.source = 'web'),
          'staff',     count(distinct coalesce(b.group_id::text, 'b' || b.id::text)) filter (where b.source = 'staff'))
        from public.bookings b where b.tenant_id = p_tenant_id and b.created_at >= v_from_ts),
      -- Confirmed stays per week, by the night's DATE, the last ceil(days/7) weeks ending today.
      'stays', (select jsonb_build_object('weeks', w.weeks, 'perWeek', w.rows) from (
          select count(*) as weeks,
                 coalesce(jsonb_agg(jsonb_build_object('weekOf', g.week_of::date, 'stays', coalesce(x.n, 0)) order by g.week_of), '[]'::jsonb) as rows
          from generate_series(v_today - 7 * ceil(v_days / 7.0)::int + 1, v_today, interval '7 days') as g(week_of)
          left join (
            select v_today - 7 * ceil(v_days / 7.0)::int + 1 + 7 * ((b.booked_date - (v_today - 7 * ceil(v_days / 7.0)::int + 1)) / 7) as week_of,
                   count(distinct coalesce(b.group_id::text, 'b' || b.id::text)) as n
            from public.bookings b
            where b.tenant_id = p_tenant_id and b.status = 'confirmed'
              and b.booked_date between v_today - 7 * ceil(v_days / 7.0)::int + 1 and v_today
            group by 1
          ) x on x.week_of = g.week_of::date) w),
      -- Occupancy over the next 30 days, per_room only: confirmed room-nights over active units × days.
      'occupancy', case when not v_per_room or v_units = 0 then null else (
        select jsonb_build_object(
          'from', v_today, 'to', v_ahead_to, 'activeUnits', v_units,
          'roomNights', o.nights,
          'percent', round(o.nights::numeric * 100 / (v_units * 30), 1),
          'perWeek', o.per_week)
        from (
          select count(*) as nights,
                 (select coalesce(jsonb_agg(jsonb_build_object('weekOf', g.week_of::date,
                           'percent', round(coalesce(x.n, 0)::numeric * 100 / (v_units * least(7, v_ahead_to - g.week_of::date + 1)), 1)) order by g.week_of), '[]'::jsonb)
                  from generate_series(v_today, v_ahead_to, interval '7 days') as g(week_of)
                  left join (
                    select v_today + 7 * ((b.booked_date - v_today) / 7) as week_of, count(*) as n
                    from public.bookings b
                    where b.tenant_id = p_tenant_id and b.status = 'confirmed' and b.booked_date between v_today and v_ahead_to
                    group by 1
                  ) x on x.week_of = g.week_of::date) as per_week
          from public.bookings b
          where b.tenant_id = p_tenant_id and b.status = 'confirmed' and b.booked_date between v_today and v_ahead_to
        ) o) end,
      -- Promos: each active promo's uses of its limit, and the discount it gave on stays made in the window.
      'promos', (select coalesce(jsonb_agg(jsonb_build_object(
          'id', p.id, 'name', p.name, 'uses', public.promo_uses(p_tenant_id, p.id), 'maxUses', p.max_uses,
          'discount', coalesce((select sum(b.discount) from public.bookings b
                                where b.tenant_id = p_tenant_id and b.promo_id = p.id and b.status in ('pending', 'confirmed') and b.created_at >= v_from_ts), 0)
        ) order by p.created_at desc), '[]'::jsonb)
        from public.promos p where p.tenant_id = p_tenant_id and p.active)
    ) into v_book;

    -- Money (owners and admins): the STORED price, net of discounts, of the
    -- nights in the window, and per week on the same weeks as the stays chart.
    if v_admin then
      select jsonb_build_object(
        'confirmed', coalesce(sum(b.price) filter (where b.status = 'confirmed'), 0),
        'pending',   coalesce(sum(b.price) filter (where b.status = 'pending'), 0),
        'discounts', coalesce(sum(b.discount) filter (where b.status = 'confirmed'), 0)
      ) into v_money
      from public.bookings b
      where b.tenant_id = p_tenant_id and b.booked_date between v_today - v_days + 1 and v_today;
      v_money := v_money || jsonb_build_object('perWeek', (
        select coalesce(jsonb_agg(jsonb_build_object('weekOf', g.week_of::date, 'confirmed', coalesce(x.n, 0)) order by g.week_of), '[]'::jsonb)
        from generate_series(v_today - 7 * ceil(v_days / 7.0)::int + 1, v_today, interval '7 days') as g(week_of)
        left join (
          select v_today - 7 * ceil(v_days / 7.0)::int + 1 + 7 * ((b.booked_date - (v_today - 7 * ceil(v_days / 7.0)::int + 1)) / 7) as week_of,
                 sum(b.price) as n
          from public.bookings b
          where b.tenant_id = p_tenant_id and b.status = 'confirmed'
            and b.booked_date between v_today - 7 * ceil(v_days / 7.0)::int + 1 and v_today
          group by 1
        ) x on x.week_of = g.week_of::date));
      v_book := v_book || jsonb_build_object('money', v_money);
    else
      v_book := v_book || jsonb_build_object('money', null);
    end if;
  end if;

  return jsonb_build_object(
    'timezone', v_timezone,
    'today', v_today,
    'days', v_days,
    'chat', v_chat,
    'knowledge', v_know,
    'team', v_team,
    'bookings', v_book
  );
end;
$$;

notify pgrst, 'reload schema';

commit;
