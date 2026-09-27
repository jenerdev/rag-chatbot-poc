-- schema-extra-guests.sql — standard capacity, maximum capacity, and a per-guest fee (plan/extra-guests.md).
--
-- Run in the Supabase SQL editor AFTER schema-booking-types.sql. Idempotent.
--
-- THE ONE THING TO KNOW
-- ---------------------
-- ONE function makes every price: unit_quote(). The insert trigger stores its
-- base, extra and total; the staff quote and the chatbot's tool call it. There
-- is no second copy of the arithmetic anywhere (plan Rule 1), so the booking
-- system and the chatbot cannot disagree.
--
--   base_price        = the slot's weekday/weekend rate (unit_price(), unchanged)
--   extra_guests      = greatest(0, guests − standard_capacity)
--   extra_guest_price = extra_guests × extra_person_rate   (0 when either is null)
--   price             = base_price + extra_guest_price
--
-- `capacity` stays what it already was: the MAXIMUM, refused above by the
-- trigger (D-065). whole_resort tenants (villa) are unchanged: no price, no
-- breakdown, the same availability rows (plan Rule 3).

-- 1. The two room properties. Null means "no extra-guest pricing", which is
--    every existing room until staff (or harbor's fixture) set them: nothing
--    changes price by accident (plan § 2.1). New rooms get the defaults 2 / 4
--    / ₱250 from @rag/bookings' createAccommodation, not from a column
--    default, for the same reason.
alter table units add column if not exists standard_capacity int;
alter table units add column if not exists extra_person_rate bigint;   -- centavos per extra guest, per booking
alter table units drop constraint if exists units_standard_capacity_range;
alter table units add  constraint units_standard_capacity_range check (
  standard_capacity is null or (standard_capacity >= 1 and (capacity is null or standard_capacity <= capacity))
);
alter table units drop constraint if exists units_extra_person_rate_nonnegative;
alter table units add  constraint units_extra_person_rate_nonnegative check (extra_person_rate is null or extra_person_rate >= 0);

-- 2. The breakdown, stored beside the total, so a booking shows what it was
--    charged even after a rate or fee edit (D-068). Null for whole_resort and
--    for every booking made before this file.
alter table bookings add column if not exists base_price bigint;
alter table bookings add column if not exists extra_guest_price bigint;
alter table bookings drop constraint if exists bookings_breakdown_nonnegative;
alter table bookings add  constraint bookings_breakdown_nonnegative check (
  (base_price is null or base_price >= 0) and (extra_guest_price is null or extra_guest_price >= 0)
);

-- 3. THE price function (plan Rule 1). Stable, search_path = ''. No row when
--    the room has no rate for that slot: "not bookable", as unit_price() says
--    with null. p_guests null prices the standard number of guests (no fee):
--    what an availability row shows before the party size is known.
create or replace function unit_quote(p_tenant_id bigint, p_unit_id bigint, p_slot_id bigint, p_date date, p_guests int)
returns table (base_price bigint, extra_guests int, extra_guest_price bigint, price bigint)
language sql stable
set search_path = ''
as $$
  with base as (
    select public.unit_price(p_tenant_id, p_unit_id, p_slot_id, p_date) as amount
  ), room as (
    select u.standard_capacity, u.extra_person_rate
    from public.units u
    where u.tenant_id = p_tenant_id and u.id = p_unit_id
  ), extra as (
    select case
             when p_guests is null or room.standard_capacity is null or room.extra_person_rate is null then 0
             else greatest(0, p_guests - room.standard_capacity)
           end as guests,
           coalesce(room.extra_person_rate, 0) as rate
    from room
  )
  select base.amount, extra.guests, extra.guests * extra.rate, base.amount + extra.guests * extra.rate
  from base, extra
  where base.amount is not null
$$;

-- 4. bookings_compute_during(), again. The schema-booking-types.sql body, with
--    three changes, all per_room only:
--      - a guest count is REQUIRED (§ 7 q2): no count, no price  → 23514
--      - base_price, extra_guest_price and price come from unit_quote()
--      - a re-save keeps the old breakdown only if it did not MOVE and the
--        guest count is the same: 2 → 4 guests reprices (plan § 2.2)
--    Whatever an insert or update sends for any of the three is overwritten.
create or replace function bookings_compute_during() returns trigger
language plpgsql
as $$
declare
  v_timezone text;
  v_start    time;
  v_duration interval;
  v_active   boolean;
  v_capacity int;
  v_quote    record;
begin
  select config->>'timezone' into v_timezone
  from tenant_applications
  where tenant_id = new.tenant_id and application_key = 'bookings';
  if v_timezone is null then
    raise exception 'Tenant % does not have the bookings application', new.tenant_id
      using errcode = 'foreign_key_violation';
  end if;

  select start_time, duration into v_start, v_duration
  from slots
  where id = new.slot_id and tenant_id = new.tenant_id;
  if v_start is null then
    raise exception 'Slot % does not belong to tenant %', new.slot_id, new.tenant_id
      using errcode = 'foreign_key_violation';
  end if;

  select active, capacity into v_active, v_capacity
  from units
  where id = new.unit_id and tenant_id = new.tenant_id;
  if v_active is null then
    raise exception 'Unit % does not belong to tenant %', new.unit_id, new.tenant_id
      using errcode = 'foreign_key_violation';
  end if;
  if not v_active then
    raise exception 'Unit % is not active', new.unit_id
      using errcode = 'foreign_key_violation';
  end if;

  if new.guest_count is not null and v_capacity is not null and new.guest_count > v_capacity then
    raise exception 'Unit % holds at most % guests, not %', new.unit_id, v_capacity, new.guest_count
      using errcode = 'check_violation';
  end if;

  new.during := slot_range(new.booked_date, v_start, v_duration, v_timezone);

  if public.booking_type_of(new.tenant_id) = 'per_room' then
    if new.guest_count is null then
      raise exception 'A room booking needs a guest count'
        using errcode = 'check_violation';
    end if;
    if tg_op = 'UPDATE'
       and new.unit_id = old.unit_id and new.slot_id = old.slot_id and new.booked_date = old.booked_date
       and new.guest_count is not distinct from old.guest_count then
      new.base_price        := old.base_price;
      new.extra_guest_price := old.extra_guest_price;
      new.price             := old.price;
    else
      select * into v_quote
      from public.unit_quote(new.tenant_id, new.unit_id, new.slot_id, new.booked_date, new.guest_count);
      if not found then
        raise exception 'Unit % has no rate for slot %', new.unit_id, new.slot_id
          using errcode = 'check_violation';
      end if;
      new.base_price        := v_quote.base_price;
      new.extra_guest_price := v_quote.extra_guest_price;
      new.price             := v_quote.price;
    end if;
  else
    new.base_price        := null;
    new.extra_guest_price := null;
    new.price             := null;
  end if;

  return new;
end;
$$;

drop trigger if exists bookings_compute_during on bookings;
create trigger bookings_compute_during
  before insert or update of tenant_id, unit_id, slot_id, booked_date, guest_count, price, base_price, extra_guest_price on bookings
  for each row execute function bookings_compute_during();

-- 5. check_room_availability, with the fee. The return type changes, so the
--    function is DROPPED and re-created, and its grants re-applied (step 6).
--    New columns: standard_capacity, extra_person_rate, and, from
--    unit_quote() for p_guests, extra_guest_price and total. `price` stays
--    the BASE price, as before, so every existing reader of it still reads
--    the same number. Still: definer, search_path = '', the token-tenant
--    check, a range cap, no guest data (D-054).
drop function if exists check_room_availability(bigint, date, date, text, text, int);
create function check_room_availability (
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
  total             bigint
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
  if v_timezone is null or public.booking_type_of(p_tenant_id) <> 'per_room' then
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
          and b.status <> 'cancelled'
          and b.during && public.slot_range(d::date, s.start_time, s.duration, v_timezone)
      ) then 'taken' else 'open' end,
      q.base_price,
      q.extra_guest_price,
      q.price
    from generate_series(p_from, p_to, interval '1 day') as d
    cross join public.units u
    join public.slots s on s.tenant_id = u.tenant_id
    cross join lateral public.unit_quote(p_tenant_id, u.id, s.id, d::date, p_guests) q
    where u.tenant_id = p_tenant_id
      and u.active
      and (p_slot   is null or s.name = p_slot)
      and (p_unit   is null or u.name = p_unit)
      and (p_guests is null or u.capacity >= p_guests)
    order by d, u.sort_order, u.name, s.start_time, s.name;
end;
$$;

-- 6. EXECUTE grants, as schema-booking-types.sql step 9.
revoke all on function unit_quote(bigint, bigint, bigint, date, int)                from public, anon, authenticated;
revoke all on function check_room_availability(bigint, date, date, text, text, int) from public, anon, authenticated;
grant execute on function unit_quote(bigint, bigint, bigint, date, int)             to authenticated, service_role;
grant execute on function check_room_availability(bigint, date, date, text, text, int) to authenticated, service_role;

notify pgrst, 'reload schema';

-- Verify:  pnpm --filter @rag/db verify
