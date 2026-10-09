-- schema-day-price.sql — the chatbot's price includes the holiday surcharge (D-083).
--
-- Run AFTER schema-rate-kind.sql. Safe to re-run: step 1 drops what step 2
-- creates.
--
-- check_room_availability() returned `price` = the BASE rate, and the
-- calendar's surcharge only inside `total`, which the chatbot's tool shows
-- only when a guest count is known. So villa's Overnight on 24 December was
-- quoted ₱20,000.00 where unit_quote(), the booking page and the stored row
-- all say ₱24,000.00 (weekend rate ₱20,000 + ₱4,000 surcharge).
--
-- It gains ONE column, `day_price`: what that slot costs on that date for
-- its included guests, surcharge in. It is unit_quote()'s own `price` with
-- no guest count, a second lateral call, so no sum is written anywhere but
-- unit_quote() (extra-guests Rule 1). `price` keeps its meaning (the base
-- rate) for every existing reader; with a guest count, `total` is still
-- day_price + extra_guest_price, from the same function.
--
-- It REPLACES check_room_availability() from schema-customer-booking.sql
-- § 10, whose `create or replace` would now fail on the changed return
-- type. That step is guarded on this column (CLAUDE.md trap 20).
--
-- Still security definer, still search_path = '', still the token-tenant
-- check: the body is § 10's with the column added. The definer count stays
-- ten (D-042): this is the same function.

-- 1. The return type changes, so the function is dropped and re-created.
-- GUARDED (manage-booking Phase 5, 2026-10-10): schema-holds.sql replaces
-- this with one that asks booking_takes() (a live hold takes a slot too).
-- Once that file has run, re-running THIS file must not put the
-- confirmed-only version back, so the step is skipped (trap 20).
do $guard$
begin
  if to_regprocedure('public.booking_takes(text, boolean, timestamptz)') is null then
    execute $ddl$
drop function if exists public.check_room_availability(bigint, date, date, text, text, int)
$ddl$;
  end if;
end
$guard$;

-- 2. § 10's body, with day_price.
do $guard$
begin
  if to_regprocedure('public.booking_takes(text, boolean, timestamptz)') is null then
    execute $ddl$
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
  day_price         bigint
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
      case when exists (
        select 1
        from public.bookings b
        where b.tenant_id = p_tenant_id
          and b.unit_id = u.id
          and b.status = 'confirmed'
          and b.during && public.slot_range(d::date, s.start_time, s.duration, v_timezone)
      ) then 'taken' else 'open' end,
      q.base_price,
      q.extra_guest_price,
      q.price,
      d0.price
    from generate_series(p_from, p_to, interval '1 day') as d
    cross join public.units u
    join public.slots s on s.tenant_id = u.tenant_id
    cross join lateral public.unit_quote(p_tenant_id, u.id, s.id, d::date, p_guests) q
    cross join lateral public.unit_quote(p_tenant_id, u.id, s.id, d::date, null) d0
    where u.tenant_id = p_tenant_id
      and u.active
      and (p_slot   is null or s.name = p_slot)
      and (p_unit   is null or u.name = p_unit)
      and (p_guests is null or u.capacity is null or u.capacity >= p_guests)
    order by d, u.sort_order, u.name, s.start_time, s.name;
end;
$$
$ddl$;
  end if;
end
$guard$;

-- 3. A dropped function loses its grants: re-applied, as schema-extra-guests.sql § 5 had them.
revoke all on function public.check_room_availability(bigint, date, date, text, text, int) from public, anon, authenticated;
grant execute on function public.check_room_availability(bigint, date, date, text, text, int) to authenticated, service_role;
