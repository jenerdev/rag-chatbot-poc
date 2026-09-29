-- schema-customer-booking.sql — the customer booking page, holiday pricing and
-- multi-night stays (plan/customer-booking.md).
--
-- Run in the Supabase SQL editor AFTER schema-extra-guests.sql. Idempotent:
-- every step can run again harmlessly. This file REPLACES five definitions
-- from earlier files (unit_price, unit_quote, bookings_compute_during,
-- check_availability, check_room_availability). Those files now skip them
-- once `rate_calendar` exists, so re-running an earlier file cannot put the
-- older definition back (the review-fix lesson of 2026-09-28).
--
-- THE ONE THING TO KNOW
-- ---------------------
-- A stranger can now create a booking row, and only through ONE function,
-- request_booking(). It inserts `pending` rows and nothing else, and a
-- pending row HOLDS NOTHING: bookings_no_overlap covers `confirmed` only
-- (plan § 2.5, D-070). So the worst a fake request can do is sit in a staff
-- list. The date belongs to whoever staff confirm first, and confirming a
-- second request for the same night fails with 23P01, the constraint's
-- answer, not a check's (CLAUDE.md trap 8).
--
-- Every price is still unit_quote(): holidays enter through unit_price(),
-- which unit_quote() already calls (plan Rule 3).

-- 1. The holiday calendar (plan § 2.3). A date, not a rule: Holy Week moves,
--    holidays are declared by proclamation, a fiesta is one town's. Staff
--    type them in. ONE row per (tenant, day); it applies to every unit.
--
--      kind       'holiday' or 'peak'. Both are priced at the holiday rate;
--                 the kind is what staff and customers are told.
--      surcharge  centavos added ONCE PER NIGHT PER UNIT booked on that day
--                 (villa: ₱4,000 on 24, 25 and 31 Dec). 0 for most holidays.
--
--    `day`, not `date`: a column named after a type reads badly in every
--    query that compares it with one.
--
--    Created FIRST: its existence is the marker the earlier files' guards
--    read (to_regclass('public.rate_calendar')).
create table if not exists rate_calendar (
  tenant_id  bigint      not null references tenants(id) on delete cascade,
  day        date        not null,
  kind       text        not null default 'holiday',
  label      text        not null,
  surcharge  bigint      not null default 0,
  created_at timestamptz not null default now(),
  primary key (tenant_id, day),
  constraint rate_calendar_kind check (kind in ('holiday', 'peak')),
  constraint rate_calendar_label_length check (char_length(btrim(label)) between 1 and 100),
  constraint rate_calendar_surcharge_nonnegative check (surcharge >= 0)
);

-- 2. An optional holiday rate per (unit, slot). NULL means "the weekend
--    rate", which is villa's own rule ("weekends and holidays"), so villa
--    sets none. Harbor's documents say only that holiday rates "may be
--    higher", which is what this column is for (plan § 8 q2).
alter table unit_rates add column if not exists holiday_price bigint;
alter table unit_rates drop constraint if exists unit_rates_holiday_price_nonnegative;
alter table unit_rates add  constraint unit_rates_holiday_price_nonnegative check (holiday_price is null or holiday_price >= 0);

-- 3. Which slot is "a night" (plan § 2.2). A stay of N nights is N rows of a
--    nightly slot on consecutive dates. Villa's Overnight and harbor's Night
--    are set true by plan/customer-booking-villa-rates.mjs; everything else
--    stays a single-date booking.
alter table slots add column if not exists nightly boolean not null default false;

-- 4. The booking columns a web request needs. All nullable or defaulted, so
--    every existing row is a 'staff' booking with no reference and no email.
--
--      source     'staff' (every row until now) or 'web' (request_booking)
--      reference  for people, e.g. VIL-7KQ4MX, shared by the rows of one
--                 request. It GRANTS NOTHING: no page or function takes it
--                 (plan § 3). Unique per request, not per row, so it is
--                 kept unique by request_booking() under a lock, not by an
--                 index (a stay has several rows with one reference).
--      surcharge  the calendar's part of `price`, stored beside base_price
--                 and extra_guest_price. price = base + extra + surcharge.
alter table bookings add column if not exists source      text not null default 'staff';
alter table bookings add column if not exists reference   text;
alter table bookings add column if not exists guest_email text;
alter table bookings add column if not exists surcharge   bigint;

alter table bookings drop constraint if exists bookings_source;
alter table bookings add  constraint bookings_source check (source in ('staff', 'web'));
-- A web request always has what staff need to call back and group it by.
alter table bookings drop constraint if exists bookings_web_request;
alter table bookings add  constraint bookings_web_request check (
  source <> 'web' or (reference is not null and group_id is not null and guest_email is not null and guest_phone is not null)
);
alter table bookings drop constraint if exists bookings_breakdown_nonnegative;
alter table bookings add  constraint bookings_breakdown_nonnegative check (
  (base_price is null or base_price >= 0)
  and (extra_guest_price is null or extra_guest_price >= 0)
  and (surcharge is null or surcharge >= 0)
);
create index if not exists bookings_tenant_reference_idx on bookings (tenant_id, reference) where reference is not null;

-- 5. A request does not hold the date; only `confirmed` does (plan § 2.5,
--    D-070). Villa's own words: "A date is only held once the reservation
--    fee is paid." Checked 2026-09-28: no `pending` row exists anywhere, so
--    re-adding the constraint changes nothing that exists, and it cannot
--    fail: the new condition covers fewer rows than the old one.
--    Dropped and re-added on every run; Postgres re-checks the confirmed
--    rows, which already satisfy it.
alter table bookings drop constraint if exists bookings_no_overlap;
alter table bookings add  constraint bookings_no_overlap exclude using gist (
  unit_id with =,
  during  with &&
) where (status = 'confirmed');

-- 6. unit_price(): the calendar first, then weekend/weekday as before. Same
--    signature, so `create or replace` keeps its grants.
create or replace function unit_price(p_tenant_id bigint, p_unit_id bigint, p_slot_id bigint, p_date date)
returns bigint
language sql stable
set search_path = ''
as $$
  select case
           when exists (select 1 from public.rate_calendar c
                         where c.tenant_id = p_tenant_id and c.day = p_date)
           then coalesce(r.holiday_price, r.weekend_price)
           when coalesce(
                  (select a.config->'weekend_days' from public.tenant_applications a
                    where a.tenant_id = p_tenant_id and a.application_key = 'bookings'),
                  '[5, 6, 7]'::jsonb)
                @> to_jsonb(extract(isodow from p_date)::int)
           then r.weekend_price
           else r.weekday_price
         end
  from public.unit_rates r
  where r.tenant_id = p_tenant_id and r.unit_id = p_unit_id and r.slot_id = p_slot_id
$$;

-- 7. unit_quote(), with the surcharge. Its return type gains a column, so it
--    is DROPPED and re-created, and its grants re-applied (step 12). Every
--    reader takes the columns by name (the trigger, check_room_availability,
--    @rag/bookings), so the new column in the middle moves nothing.
--    Still THE price arithmetic: no second copy anywhere (extra-guests Rule 1).
drop function if exists unit_quote(bigint, bigint, bigint, date, int);
create function unit_quote(p_tenant_id bigint, p_unit_id bigint, p_slot_id bigint, p_date date, p_guests int)
returns table (base_price bigint, extra_guests int, extra_guest_price bigint, surcharge bigint, price bigint)
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
  ), cal as (
    select coalesce((select c.surcharge from public.rate_calendar c
                      where c.tenant_id = p_tenant_id and c.day = p_date), 0) as surcharge
  )
  select base.amount,
         extra.guests,
         extra.guests * extra.rate,
         cal.surcharge,
         base.amount + extra.guests * extra.rate + cal.surcharge
  from base, extra, cal
  where base.amount is not null
$$;

-- 8. bookings_compute_during(), again. The schema-extra-guests.sql body with
--    two changes:
--      - whole_resort is PRICED when its unit has a rate for the slot (plan
--        § 2.4), and stays null when it has none. So every past villa
--        booking keeps `price null`, and a whole_resort tenant with no rates
--        is exactly as before. per_room still refuses a missing rate;
--      - the surcharge is stored beside the breakdown.
--    The keep-the-old-breakdown rule now applies to both types: a re-save
--    that does not move the booking or change its guests keeps what it was
--    charged, including an old null.
--    And `search_path = ''`, every name qualified: request_booking() runs
--    with an empty search_path, and a trigger fired from inside it inherits
--    that, so an unqualified `units` would be "relation does not exist".
create or replace function bookings_compute_during() returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_timezone text;
  v_start    time;
  v_duration interval;
  v_active   boolean;
  v_capacity int;
  v_per_room boolean;
  v_quote    record;
begin
  select config->>'timezone' into v_timezone
  from public.tenant_applications
  where tenant_id = new.tenant_id and application_key = 'bookings';
  if v_timezone is null then
    raise exception 'Tenant % does not have the bookings application', new.tenant_id
      using errcode = 'foreign_key_violation';
  end if;

  select start_time, duration into v_start, v_duration
  from public.slots
  where id = new.slot_id and tenant_id = new.tenant_id;
  if v_start is null then
    raise exception 'Slot % does not belong to tenant %', new.slot_id, new.tenant_id
      using errcode = 'foreign_key_violation';
  end if;

  select active, capacity into v_active, v_capacity
  from public.units
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

  new.during := public.slot_range(new.booked_date, v_start, v_duration, v_timezone);

  v_per_room := public.booking_type_of(new.tenant_id) = 'per_room';
  if v_per_room and new.guest_count is null then
    raise exception 'A room booking needs a guest count'
      using errcode = 'check_violation';
  end if;

  if tg_op = 'UPDATE'
     and new.unit_id = old.unit_id and new.slot_id = old.slot_id and new.booked_date = old.booked_date
     and new.guest_count is not distinct from old.guest_count then
    new.base_price        := old.base_price;
    new.extra_guest_price := old.extra_guest_price;
    new.surcharge         := old.surcharge;
    new.price             := old.price;
    return new;
  end if;

  select * into v_quote
  from public.unit_quote(new.tenant_id, new.unit_id, new.slot_id, new.booked_date, new.guest_count);
  if found then
    new.base_price        := v_quote.base_price;
    new.extra_guest_price := v_quote.extra_guest_price;
    new.surcharge         := v_quote.surcharge;
    new.price             := v_quote.price;
  elsif v_per_room then
    raise exception 'Unit % has no rate for slot %', new.unit_id, new.slot_id
      using errcode = 'check_violation';
  else
    new.base_price        := null;
    new.extra_guest_price := null;
    new.surcharge         := null;
    new.price             := null;
  end if;

  return new;
end;
$$;

drop trigger if exists bookings_compute_during on bookings;
create trigger bookings_compute_during
  before insert or update of tenant_id, unit_id, slot_id, booked_date, guest_count, price, base_price, extra_guest_price, surcharge on bookings
  for each row execute function bookings_compute_during();

-- 9. check_availability: the schema-booking-types.sql body with ONE change,
--    `status = 'confirmed'`, to match the constraint (step 5). A date with
--    only requests on it is open, which is true: nobody has it yet. Same
--    signature, so `create or replace` keeps its grants.
create or replace function check_availability (
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
      case when exists (
        select 1
        from public.bookings b
        where b.tenant_id = p_tenant_id
          and b.unit_id = u.id
          and b.status = 'confirmed'
          and b.during && public.slot_range(d::date, s.start_time, s.duration, v_timezone)
      ) then 'taken' else 'open' end
    from generate_series(p_from, p_to, interval '1 day') as d
    cross join public.units u
    join public.slots s on s.tenant_id = u.tenant_id
    where u.tenant_id = p_tenant_id
      and u.active
    order by d, u.name, s.start_time, s.name;
end;
$$;

-- 10. check_room_availability: the schema-extra-guests.sql body with the same
--     one change. Same signature and return type, so `create or replace`
--     keeps its grants. `total` now includes the surcharge, because it is
--     unit_quote()'s price; `price` stays the BASE price.
--
--     VILLA PRICES (2026-09-28, D-074): the `booking_type_of() <> 'per_room'`
--     gate is gone. Rows come for ANY tenant whose active units have a rate
--     for a slot: villa's one unit now does, so its chatbot tool can carry a
--     price from the database instead of the documents. A tenant with no
--     rates still gets zero rows (the lateral unit_quote() yields none), the
--     same answer as before, so a whole_resort tenant with prices only in
--     its documents is unchanged.
create or replace function check_room_availability (
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
      q.price
    from generate_series(p_from, p_to, interval '1 day') as d
    cross join public.units u
    join public.slots s on s.tenant_id = u.tenant_id
    cross join lateral public.unit_quote(p_tenant_id, u.id, s.id, d::date, p_guests) q
    where u.tenant_id = p_tenant_id
      and u.active
      and (p_slot   is null or s.name = p_slot)
      and (p_unit   is null or u.name = p_unit)
      and (p_guests is null or u.capacity is null or u.capacity >= p_guests)
    order by d, u.sort_order, u.name, s.start_time, s.name;
end;
$$;

-- 11. request_booking(): THE public write (plan Rule 2, § 2.1). A fourth
--     security definer function (D-071, amending D-042 and D-054), with the
--     same five properties as the other three: definer, search_path = '',
--     the token-tenant check, bounded input, and nothing returned about any
--     other booking.
--
--     What the caller can choose: the slot, the units and a guest count
--     each, the check-in date, the number of nights, and the contact
--     details. What it cannot: the status ('pending'), the source ('web'),
--     the price (the trigger's), the group or the reference (made here).
--     The unit and slot ids come from a FORM, not from the model: the model
--     has no tool that reaches this function (D-037 stands).
--
--     The limits are policy, not measurements (plan § 8 q8). They are
--     enforced HERE, so they hold whoever calls; packages/bookings/src/
--     constants.ts mirrors them for the page, and verify checks that 14
--     nights is accepted and 15 refused, so the two cannot drift silently.
--       14 nights · 365 days ahead · 3 open requests per phone or email ·
--       70 rows (units × nights)
--
--     Errors, mapped once in @rag/bookings:
--       22023 invalid_parameter_value → 400, the message says what is wrong
--       23P01 exclusion_violation     → 409, "no longer available"
--       54000 program_limit_exceeded  → 429, too many open requests
--       42501 insufficient_privilege  → another tenant's id
--       23503 / 23514 from the trigger → a unit that is not this tenant's,
--         inactive, over capacity, or unpriced: the same answer as "not there"
-- GUARDED (tenant management Phase 1, 2026-09-29): schema-roles.sql replaces
-- this (the two limits read from the tenant's config).
-- Once that file has run (platform_admins exists), re-running THIS file must
-- not put the older definition back, so it is skipped.
do $guard$
begin
  if to_regclass('public.platform_admins') is null then
    execute $ddl$
create or replace function request_booking (
  p_tenant_id bigint,
  p_slot_id   bigint,
  p_unit_ids  bigint[],
  p_guests    int[],
  p_check_in  date,
  p_nights    int,
  p_name      text,
  p_phone     text,
  p_email     text,
  p_notes     text
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
  price             bigint
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  c_max_nights    constant int := 14;
  c_max_advance   constant int := 365;
  c_max_open      constant int := 3;
  c_max_rows      constant int := 70;
  c_alphabet      constant text := 'ABCDEFGHJKMNPQRSTUVWXYZ2345679';   -- no 0 O 1 I L 8
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
begin
  -- The tenant is the token's (wall 2); p_tenant_id is what the code sends
  -- (wall 1). service_role is allowed for the tools, as in the other three.
  if coalesce(auth.jwt() ->> 'role', '') <> 'service_role'
     and p_tenant_id is distinct from public.app_tenant_id() then
    raise exception 'request_booking: tenant % is not the token''s tenant', p_tenant_id
      using errcode = 'insufficient_privilege';
  end if;

  select a.config->>'timezone', t.slug into v_timezone, v_slug
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

  -- Dates: the tenant's today (CLAUDE.md trap 9), and the first night must
  -- not have started yet.
  v_today := (now() at time zone v_timezone)::date;
  if p_check_in is null or p_nights is null then
    raise exception 'A date and a number of nights are required' using errcode = 'invalid_parameter_value';
  end if;
  if p_nights < 1 or p_nights > c_max_nights then
    raise exception 'A stay is 1 to % nights, not %', c_max_nights, p_nights using errcode = 'invalid_parameter_value';
  end if;
  if p_nights > 1 and not v_nightly then
    raise exception 'Only an overnight slot can be booked for several nights' using errcode = 'invalid_parameter_value';
  end if;
  if p_check_in > v_today + c_max_advance then
    raise exception 'Bookings open % days ahead; % is too far', c_max_advance, p_check_in using errcode = 'invalid_parameter_value';
  end if;
  if lower(public.slot_range(p_check_in, v_start, v_duration, v_timezone)) <= now() then
    raise exception 'That date has already started or passed' using errcode = 'invalid_parameter_value';
  end if;

  -- Units: one guest count each, no repeats, and bounded rows. Whether each
  -- unit is this tenant's, active and big enough is the trigger's job.
  v_units := coalesce(cardinality(p_unit_ids), 0);
  if v_units = 0 or v_units <> coalesce(cardinality(p_guests), 0) then
    raise exception 'Choose at least one unit, with a guest count for each' using errcode = 'invalid_parameter_value';
  end if;
  if array_position(p_unit_ids, null) is not null or array_position(p_guests, null) is not null
     or exists (select 1 from unnest(p_guests) g where g < 1) then
    raise exception 'Every unit needs a guest count of at least 1' using errcode = 'invalid_parameter_value';
  end if;
  if (select count(distinct u) from unnest(p_unit_ids) u) <> v_units then
    raise exception 'A unit appears twice' using errcode = 'invalid_parameter_value';
  end if;
  if public.booking_type_of(p_tenant_id) = 'whole_resort' and v_units <> 1 then
    raise exception 'A whole-resort booking is for the one property' using errcode = 'invalid_parameter_value';
  end if;
  if v_units * p_nights > c_max_rows then
    raise exception 'That is % room-nights; the limit is %', v_units * p_nights, c_max_rows using errcode = 'invalid_parameter_value';
  end if;

  -- Contact details: FORMAT only. A form cannot prove a phone or an email is
  -- real (plan § 2.7); staff contact the guest before confirming.
  v_name  := btrim(coalesce(p_name, ''));
  v_phone := regexp_replace(coalesce(p_phone, ''), '[\s().-]', '', 'g');
  if v_phone like '+63%' then v_phone := '0' || substr(v_phone, 4); end if;
  v_email := lower(btrim(coalesce(p_email, '')));
  v_notes := nullif(btrim(coalesce(p_notes, '')), '');
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

  -- Serialises requests per tenant from here to commit: the limit count and
  -- the reference's uniqueness are both read-then-write, and this lock is
  -- what makes them safe under concurrency. It does NOT decide who gets a
  -- date; the constraint does that at confirmation.
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

  -- A courtesy check, not the guard: a night already CONFIRMED for one of
  -- these units is refused now, so nobody requests what is visibly gone.
  -- The guard is the constraint, when staff confirm.
  if exists (
    select 1
    from unnest(p_unit_ids) as u(unit_id)
    cross join generate_series(0, p_nights - 1) as n
    join public.bookings b
      on b.tenant_id = p_tenant_id and b.unit_id = u.unit_id and b.status = 'confirmed'
     and b.during && public.slot_range(p_check_in + n, v_start, v_duration, v_timezone)
  ) then
    raise exception 'That date is no longer available' using errcode = 'exclusion_violation';
  end if;

  -- The reference: 3 letters of the slug and 6 from a 30-letter alphabet.
  -- random() is fine here: the reference grants nothing (plan § 3).
  loop
    v_ref := upper(left(regexp_replace(v_slug, '[^a-zA-Z]', '', 'g') || 'XXX', 3)) || '-' ||
             (select string_agg(substr(c_alphabet, 1 + floor(random() * 30)::int, 1), '')
                from generate_series(1, 6));
    exit when not exists (select 1 from public.bookings b where b.tenant_id = p_tenant_id and b.reference = v_ref);
  end loop;

  -- ONE insert, so a stay that fails on any row saves none (booking-types
  -- § 2.5). The trigger sets `during` and the price of every row.
  insert into public.bookings
    (tenant_id, unit_id, slot_id, booked_date, status, source,
     guest_name, guest_phone, guest_email, guest_count, notes, group_id, reference)
  select p_tenant_id, u.unit_id, p_slot_id, p_check_in + n, 'pending', 'web',
         v_name, v_phone, v_email, u.guests, v_notes, v_group, v_ref
  from unnest(p_unit_ids, p_guests) as u(unit_id, guests)
  cross join generate_series(0, p_nights - 1) as n;

  -- A page with no price is what this plan exists to avoid: a whole_resort
  -- unit with no rate for this slot is refused, and the insert rolls back.
  if exists (select 1 from public.bookings b
              where b.tenant_id = p_tenant_id and b.group_id = v_group and b.price is null) then
    raise exception 'This slot has no price yet' using errcode = 'invalid_parameter_value';
  end if;

  return query
    select b.reference, b.booked_date, un.name, s.name, lower(b.during), upper(b.during),
           b.guest_count, b.base_price, b.extra_guest_price, b.surcharge, b.price
    from public.bookings b
    join public.units un on un.tenant_id = b.tenant_id and un.id = b.unit_id
    join public.slots s  on s.tenant_id  = b.tenant_id and s.id  = b.slot_id
    where b.tenant_id = p_tenant_id and b.group_id = v_group
    order by b.booked_date, un.sort_order, un.name;
end;
$$;
    $ddl$;
  end if;
end $guard$;

-- 12. The booking page's settings, in the bookings application's config
--     (plan § 3 step 9). A SEPARATE trigger, so tenant_applications_validate
--     (schema-booking-types.sql) is not redefined here. Both run.
--
--       "booking_page": { "instructions": "...", "guest_hint": "..." }
--
--     instructions: what a customer reads after sending a request (villa's
--     GCash steps). guest_hint: shown by the guest-count field ("do not count
--     children aged 3 and below"). Plain text, rendered as text, never HTML.
create or replace function tenant_applications_booking_page() returns trigger
language plpgsql
as $$
declare
  v_page jsonb;
begin
  if new.application_key = 'bookings' and new.config ? 'booking_page' then
    v_page := new.config->'booking_page';
    if jsonb_typeof(v_page) <> 'object'
       or exists (select 1 from jsonb_object_keys(v_page) k where k not in ('instructions', 'guest_hint')) then
      raise exception 'config.booking_page is an object with "instructions" and "guest_hint" only'
        using errcode = 'check_violation';
    end if;
    if v_page ? 'instructions' and (jsonb_typeof(v_page->'instructions') <> 'string'
                                    or char_length(v_page->>'instructions') > 2000) then
      raise exception 'config.booking_page.instructions is text of at most 2000 characters'
        using errcode = 'check_violation';
    end if;
    if v_page ? 'guest_hint' and (jsonb_typeof(v_page->'guest_hint') <> 'string'
                                  or char_length(v_page->>'guest_hint') > 200) then
      raise exception 'config.booking_page.guest_hint is text of at most 200 characters'
        using errcode = 'check_violation';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists tenant_applications_booking_page on tenant_applications;
create trigger tenant_applications_booking_page
  before insert or update on tenant_applications
  for each row execute function tenant_applications_booking_page();

-- 13. RLS on rate_calendar: any token of the tenant READS (the page shows
--     which dates are holidays, and unit_price() reads it as whoever asks);
--     only its admins write. Both the tenant and admin, as everywhere.
--     bookings gains NO policy: a chat token still cannot insert into it
--     directly, so request_booking() is the only way in (plan Rule 2).
alter table rate_calendar enable row level security;

drop policy if exists rate_calendar_read   on rate_calendar;
drop policy if exists rate_calendar_insert on rate_calendar;
drop policy if exists rate_calendar_update on rate_calendar;
drop policy if exists rate_calendar_delete on rate_calendar;
create policy rate_calendar_read on rate_calendar for select to authenticated
  using (tenant_id = (select public.app_tenant_id()));
create policy rate_calendar_insert on rate_calendar for insert to authenticated
  with check (tenant_id = (select public.app_tenant_id()) and (select public.app_is_admin()));
create policy rate_calendar_update on rate_calendar for update to authenticated
  using      (tenant_id = (select public.app_tenant_id()) and (select public.app_is_admin()))
  with check (tenant_id = (select public.app_tenant_id()) and (select public.app_is_admin()));
create policy rate_calendar_delete on rate_calendar for delete to authenticated
  using (tenant_id = (select public.app_tenant_id()) and (select public.app_is_admin()));

-- 14. EXECUTE grants. unit_quote was re-created, so its grants are re-applied.
--     request_booking: tokens only, never anon (the page always has a chat
--     token, minted by the server).
revoke all on function unit_quote(bigint, bigint, bigint, date, int) from public, anon, authenticated;
grant execute on function unit_quote(bigint, bigint, bigint, date, int) to authenticated, service_role;
revoke all on function request_booking(bigint, bigint, bigint[], int[], date, int, text, text, text, text) from public, anon, authenticated;
grant execute on function request_booking(bigint, bigint, bigint[], int[], date, int, text, text, text, text) to authenticated, service_role;

notify pgrst, 'reload schema';

-- Then:  (cd packages/rag && node --conditions=react-server --env-file=../../.env ../../plan/customer-booking-villa-rates.mjs)
-- Verify:  pnpm --filter @rag/db verify
