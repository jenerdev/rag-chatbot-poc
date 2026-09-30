-- schema-rate-kind.sql — which rate a price is: weekday, weekend, holiday or peak (D-082).
--
-- Run AFTER schema-closed-days.sql. Safe to re-run: every step is `create or
-- replace` with an unchanged signature.
--
-- unit_price() already decided which rate a date gets, and returned only the
-- amount. The chatbot could say "₱20,000.00" but not that it was the WEEKEND
-- rate, and nothing else could tell it without deciding a second time. So the
-- decision moves into ONE function, rate_kind(), and unit_price() asks it.
-- The label and the amount then cannot disagree: they are the same branch.
--
-- It REPLACES unit_price() from schema-customer-booking.sql § 6, with the
-- same result for every date. That step is guarded on rate_kind(), so
-- re-running the older file cannot put the inline copy back (CLAUDE.md
-- trap 20).

-- 1. rate_kind(): the calendar first, then the tenant's weekend days, as
--    unit_price() has always done it.
--      'holiday' | 'peak' | 'closed'  a rate_calendar row's own kind (one row
--                                     per tenant and day); all three are
--                                     priced at the holiday rate
--      'weekend'                      the ISO weekday is in the bookings
--                                     config's weekend_days (default Fri–Sun)
--      'weekday'                      anything else
--    Invoker, like unit_price(): a token reads only its own tenant's calendar
--    and config (RLS, wall 2), and the caller passes its own tenant (wall 1).
create or replace function public.rate_kind(p_tenant_id bigint, p_date date)
returns text
language sql stable
set search_path = ''
as $$
  select coalesce(
           (select c.kind from public.rate_calendar c
             where c.tenant_id = p_tenant_id and c.day = p_date),
           case
             when coalesce(
                    (select a.config->'weekend_days' from public.tenant_applications a
                      where a.tenant_id = p_tenant_id and a.application_key = 'bookings'),
                    '[5, 6, 7]'::jsonb)
                  @> to_jsonb(extract(isodow from p_date)::int)
             then 'weekend'
             else 'weekday'
           end)
$$;

-- 2. unit_price(), asking rate_kind(). Same signature, so `create or replace`
--    keeps its grants, and the same amount for every date as § 6's body.
create or replace function public.unit_price(p_tenant_id bigint, p_unit_id bigint, p_slot_id bigint, p_date date)
returns bigint
language sql stable
set search_path = ''
as $$
  select case public.rate_kind(p_tenant_id, p_date)
           when 'weekday' then r.weekday_price
           when 'weekend' then r.weekend_price
           else coalesce(r.holiday_price, r.weekend_price)
         end
  from public.unit_rates r
  where r.tenant_id = p_tenant_id and r.unit_id = p_unit_id and r.slot_id = p_slot_id
$$;

-- 3. rate_kinds(): every date from p_from to p_to with its kind, for the
--    chatbot's tool (@rag/bookings pricedAvailability). The same bound as
--    check_room_availability: at most 366 days.
create or replace function public.rate_kinds(p_tenant_id bigint, p_from date, p_to date)
returns table (day date, kind text)
language sql stable
set search_path = ''
as $$
  select d::date, public.rate_kind(p_tenant_id, d::date)
  from generate_series(p_from, p_to, interval '1 day') as d
  where p_to - p_from between 0 and 366
$$;

-- 4. EXECUTE grants, as for unit_price(): tokens, never anon.
revoke all on function public.rate_kind(bigint, date)        from public, anon, authenticated;
revoke all on function public.rate_kinds(bigint, date, date) from public, anon, authenticated;
grant execute on function public.rate_kind(bigint, date)        to authenticated, service_role;
grant execute on function public.rate_kinds(bigint, date, date) to authenticated, service_role;
