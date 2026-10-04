-- schema-dashboard.sql — the dashboard's two functions (plan/dashboard.md, D-098).
--
-- Run after schema-promos.sql. Idempotent. The 19th file. No table, no
-- column, no row written: two READS that aggregate what the tenant already
-- holds, in ONE round trip each, in the tenant's day.
--
--   tenant_dashboard(p_tenant_id, p_days)  security INVOKER: every read runs
--     under the RLS the caller's token already has. But a chat token can read
--     conversations and messages by policy, so the function refuses any
--     caller that is not a MEMBER of that tenant (app_is_staff()), and the
--     `money` key is null unless app_is_admin() (plan Rule 2; § 7 q2).
--     service_role is allowed, for the tools. p_days is clamped to 7..90.
--     Every bucket is cut in the tenant's timezone (CLAUDE.md trap 9), from
--     tenant_applications.config, Asia/Manila for a tenant without bookings.
--     A "stay" is a distinct request (group_id, or the row itself), the same
--     expression promo_uses() counts (§ 2b.1); room-nights sum ROWS.
--
--   platform_dashboard()  security DEFINER, search_path = '', app_is_super()
--     checked first (the D-042 shape, the eleventh definer function): one row
--     per tenant, COUNTS ONLY, no content, no guest, no money (§ 2.4).
--
-- Every name qualified (trap 19). Nothing here is the chat's: no prompt,
-- no tool (plan Rule 4).

-- 1. The tenant's page.
create or replace function tenant_dashboard(p_tenant_id bigint, p_days int default 30)
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
    select count(*) into v_units from public.units u where u.tenant_id = p_tenant_id and u.active;

    select jsonb_build_object(
      'attention', jsonb_build_object(
        'pendingRequests', (select count(distinct b.group_id) from public.bookings b
                            where b.tenant_id = p_tenant_id and b.source = 'web' and b.status = 'pending' and upper(b.during) > now()),
        'pendingStaff',    (select count(distinct coalesce(b.group_id::text, 'b' || b.id::text)) from public.bookings b
                            where b.tenant_id = p_tenant_id and b.source = 'staff' and b.status = 'pending' and upper(b.during) > now()),
        -- A pending row whose span is already CONFIRMED for the same unit: Confirm would be the 409 (D-070).
        'clashing',        (select count(distinct coalesce(p.group_id::text, 'b' || p.id::text)) from public.bookings p
                            where p.tenant_id = p_tenant_id and p.status = 'pending' and upper(p.during) > now()
                              and exists (select 1 from public.bookings c
                                          where c.tenant_id = p.tenant_id and c.unit_id = p.unit_id and c.status = 'confirmed' and c.during && p.during))
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

-- 2. The platform's strip: counts only, one row per tenant.
create or replace function platform_dashboard()
returns table (
  tenant_id           bigint,
  slug                text,
  business_name       text,
  archived_at         timestamptz,
  members             int,
  documents           int,
  conversations_30d   int,
  refusals_30d        int,
  open_unanswered     int,
  pending_requests    int,
  confirmed_stays_30d int
)
language plpgsql stable
security definer
set search_path = ''
as $$
begin
  if coalesce(auth.jwt() ->> 'role', '') <> 'service_role' and not public.app_is_super() then
    raise exception 'platform_dashboard: not a super user' using errcode = 'insufficient_privilege';
  end if;
  return query
    select t.id, t.slug, t.business_name, t.archived_at,
      (select count(*)::int from public.memberships m where m.tenant_id = t.id),
      (select count(*)::int from public.documents d where d.tenant_id = t.id),
      (select count(*)::int from public.conversations c where c.tenant_id = t.id and c.created_at >= now() - interval '30 days'),
      (select count(*)::int from public.messages m where m.tenant_id = t.id and m.role = 'assistant'
         and m.content = 'I don''t know based on the documents I have.' and m.created_at >= now() - interval '30 days'),
      (select count(*)::int from public.messages m
         left join public.unanswered_resolutions r on r.message_id = m.id and r.tenant_id = m.tenant_id
         where m.tenant_id = t.id and m.role = 'assistant'
           and m.content = 'I don''t know based on the documents I have.' and r.message_id is null),
      (select count(distinct b.group_id)::int from public.bookings b
         where b.tenant_id = t.id and b.source = 'web' and b.status = 'pending' and upper(b.during) > now()),
      (select count(distinct coalesce(b.group_id::text, 'b' || b.id::text))::int from public.bookings b
         where b.tenant_id = t.id and b.status = 'confirmed' and b.created_at >= now() - interval '30 days')
    from public.tenants t
    order by t.archived_at nulls first, t.created_at;
end;
$$;

-- 3. EXECUTE grants: revoke from all three, grant back exactly who needs it.
revoke all on function tenant_dashboard(bigint, int) from public, anon, authenticated;
revoke all on function platform_dashboard()         from public, anon, authenticated;
grant execute on function tenant_dashboard(bigint, int) to authenticated, service_role;
grant execute on function platform_dashboard()         to authenticated, service_role;

notify pgrst, 'reload schema';

-- Verify:  pnpm --filter @rag/db verify        (dashboard checks, plan § 5 Phase 1)
