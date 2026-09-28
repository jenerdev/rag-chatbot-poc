-- schema-booking-types.sql — booking types: whole_resort or per_room (plan/booking-types.md).
--
-- Run in the Supabase SQL editor AFTER schema-auth.sql. Idempotent: every
-- step can run again harmlessly, so the file is re-run whole as it grows.
-- Also after schema-extra-guests.sql: the two definitions that file replaces
-- (steps 6 and 8) are guarded, and skipped once it has run. And after
-- schema-customer-booking.sql: steps 5 and 7 are guarded the same way.
--
-- THE ONE THING TO KNOW
-- ---------------------
-- A room is a `units` row. Nothing about availability changes: two live
-- bookings of one unit still may not overlap (bookings_no_overlap), per unit,
-- so two rooms on the same night never collide. What is new is a PRICE, and
-- it is decided HERE, by the insert trigger, from unit_rates. Whatever price
-- an insert sends is overwritten (plan Rule 2), the way `during` already is.
--
-- whole_resort (the default, and villa) sees no change: no price, the same
-- check_availability rows, the same tool text (plan Rule 1).
--
-- § 11 (the photo bucket) was run alone first, as the Storage spike of plan
-- § 2.8: 9/9 on 2026-09-27 (plan/baseline/storage-spike-booking-types-phase1.txt).

-- 1. The booking type, in the bookings application's config (plan § 2.1).
--
--    { "timezone": "Asia/Manila", "booking_type": "per_room",
--      "weekend_days": [5, 6, 7], "currency": "PHP" }
--
--    ABSENT booking_type means whole_resort, so villa's row needs no change
--    and "existing tenants default to whole-resort" is true by construction.
--    weekend_days are ISO weekdays (1 = Monday … 7 = Sunday); absent means
--    Friday to Sunday, villa's own definition. Read in ONE place in SQL:
--    public.booking_type_of() below.
create or replace function booking_type_of(p_tenant_id bigint) returns text
language sql stable
set search_path = ''
as $$
  select coalesce(
    (select config->>'booking_type' from public.tenant_applications
      where tenant_id = p_tenant_id and application_key = 'bookings'),
    'whole_resort')
$$;

--    The validate trigger from schema-bookings.sql, with the timezone check
--    unchanged and three more. The last one is plan § 2.4: switching type
--    while the tenant has a live booking that has not ended would leave a
--    whole-property booking that no room booking overlaps, or the reverse.
--    The operator CLI (Phase 5) refuses first; this is the second wall.
create or replace function tenant_applications_validate() returns trigger
language plpgsql
as $$
declare
  v_type     text;
  v_old_type text;
  v_live     int;
  v_active   int;
begin
  if new.application_key = 'bookings' then
    if new.config->>'timezone' is null then
      raise exception 'The bookings application needs config.timezone, e.g. {"timezone":"Asia/Manila"}'
        using errcode = 'check_violation';
    end if;
    perform now() at time zone (new.config->>'timezone');

    v_type := coalesce(new.config->>'booking_type', 'whole_resort');
    if v_type not in ('whole_resort', 'per_room') then
      raise exception 'config.booking_type must be "whole_resort" or "per_room", not "%"', v_type
        using errcode = 'check_violation';
    end if;

    if new.config ? 'weekend_days' and (
         jsonb_typeof(new.config->'weekend_days') <> 'array'
         or exists (select 1 from jsonb_array_elements(new.config->'weekend_days') e
                     where e::text !~ '^[1-7]$')) then
      raise exception 'config.weekend_days must be an array of ISO weekdays, 1 (Monday) to 7 (Sunday)'
        using errcode = 'check_violation';
    end if;

    if new.config ? 'currency' and coalesce(new.config->>'currency', '') !~ '^[A-Z]{3}$' then
      raise exception 'config.currency must be a three-letter code such as "PHP"'
        using errcode = 'check_violation';
    end if;

    if tg_op = 'UPDATE' then
      v_old_type := coalesce(old.config->>'booking_type', 'whole_resort');
      if v_type <> v_old_type then
        select count(*) into v_live from bookings
         where tenant_id = new.tenant_id and status <> 'cancelled' and upper(during) > now();
        if v_live > 0 then
          raise exception 'Tenant % has % live booking(s) that have not ended; its booking type cannot change', new.tenant_id, v_live
            using errcode = 'check_violation';
        end if;
        if v_type = 'whole_resort' then
          select count(*) into v_active from units where tenant_id = new.tenant_id and active;
          if v_active > 1 then
            raise exception 'Tenant % has % active units; a whole-resort tenant has at most one', new.tenant_id, v_active
              using errcode = 'check_violation';
          end if;
        end if;
      end if;
    end if;
  end if;
  return new;
end;
$$;
-- The trigger itself (tenant_applications_validate, before insert or update)
-- already exists from schema-bookings.sql and now runs this body.

-- 2. Units become accommodations. Every new column is nullable or defaulted,
--    so villa's "Whole property" row is untouched: active, no capacity, no
--    description. There is no DELETE policy for tokens (step 9): a room is
--    deactivated, so the bookings that name it keep their unit.
alter table units add column if not exists description text;
alter table units add column if not exists capacity    int;
alter table units add column if not exists active      boolean not null default true;
alter table units add column if not exists sort_order  int     not null default 0;
alter table units drop constraint if exists units_capacity_positive;
alter table units add  constraint units_capacity_positive check (capacity is null or capacity > 0);
alter table units drop constraint if exists units_description_length;
alter table units add  constraint units_description_length check (description is null or char_length(description) <= 2000);
alter table units drop constraint if exists units_name_length;
alter table units add  constraint units_name_length check (char_length(name) between 1 and 100);

--    A whole-resort tenant has EXACTLY one active unit (plan § 2.4): a second
--    active one would be a second thing to sell that does not overlap the
--    first. A constraint trigger, DEFERRED, so deactivating one unit and
--    activating another in the same transaction is allowed. A tenant with no
--    bookings application counts as whole_resort, which is also what the
--    verify and isolation probes are (one unit each).
create or replace function units_whole_resort_one_active() returns trigger
language plpgsql
as $$
declare
  v_active int;
begin
  if public.booking_type_of(new.tenant_id) = 'whole_resort' then
    select count(*) into v_active from public.units where tenant_id = new.tenant_id and active;
    if v_active <> 1 then
      raise exception 'A whole-resort tenant has exactly one active unit; tenant % would have %', new.tenant_id, v_active
        using errcode = 'check_violation';
    end if;
  end if;
  return null;
end;
$$;

drop trigger if exists units_whole_resort_one_active on units;
create constraint trigger units_whole_resort_one_active
  after insert or update of active, tenant_id on units
  deferrable initially deferred
  for each row execute function units_whole_resort_one_active();

-- 3. Prices: one row per (unit, slot). No row means "not bookable yet" for a
--    per_room tenant (the trigger in step 6 refuses the booking). Centavos in
--    a bigint, never a float peso (plan § 2.3). Weekday and weekend only: the
--    user decided holidays and surcharges are not modelled (§ 8 q2, R-24).
create table if not exists unit_rates (
  tenant_id     bigint not null references tenants(id) on delete cascade,
  unit_id       bigint not null,
  slot_id       bigint not null,
  weekday_price bigint not null,
  weekend_price bigint not null,
  updated_at    timestamptz not null default now(),
  primary key (tenant_id, unit_id, slot_id),
  -- Composite FKs: a rate cannot name another tenant's unit or slot.
  constraint unit_rates_unit_tenant_fk foreign key (unit_id, tenant_id)
    references units (id, tenant_id) on delete cascade,
  constraint unit_rates_slot_tenant_fk foreign key (slot_id, tenant_id)
    references slots (id, tenant_id) on delete cascade,
  constraint unit_rates_prices_nonnegative check (weekday_price >= 0 and weekend_price >= 0)
);

-- 4. Bookings: the stored price, and the group a multi-room booking shares
--    (plan § 2.5: one array insert, one statement, all or nothing). Both null
--    on every existing row, and price stays null for whole_resort.
alter table bookings add column if not exists price    bigint;
alter table bookings add column if not exists group_id uuid;
alter table bookings drop constraint if exists bookings_price_nonnegative;
alter table bookings add  constraint bookings_price_nonnegative check (price is null or price >= 0);
create index if not exists bookings_tenant_group_idx on bookings (tenant_id, group_id) where group_id is not null;
create index if not exists bookings_tenant_unit_date_idx on bookings (tenant_id, unit_id, booked_date);

-- 5. The ONE place a price is computed. The insert trigger and the staff
--    quote route both call it, so a preview cannot drift from what is stored
--    (plan Rule 2). `p_date` is the date the slot STARTS on, which is already
--    a calendar date in the tenant's timezone (booked_date), so its weekday
--    needs no timezone. Null means "no rate": not bookable.
--    GUARDED (customer booking Phase 1, 2026-09-28): schema-customer-booking.sql
--    replaces this. Once that file has run (rate_calendar exists), re-running
--    THIS file must not put the older definition back, so it is skipped.
do $guard$
begin
  if to_regclass('public.rate_calendar') is null then
    execute $ddl$
create or replace function unit_price(p_tenant_id bigint, p_unit_id bigint, p_slot_id bigint, p_date date)
returns bigint
language sql stable
set search_path = ''
as $$
  select case
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
$$
    $ddl$;
  end if;
end
$guard$;

-- 6. bookings_compute_during(), extended. Same trigger, same timing. What it
--    adds, in order:
--      - the unit must be this tenant's AND active       → 23503, the same
--        code (and, in @rag/bookings, the same message) as "not there"
--      - guest_count <= capacity, when both are set       → 23514
--      - per_room: price := unit_price(), or refuse       → 23514 "no rate"
--      - whole_resort: price := null. There is no pricing to apply (Rule 1).
--    The price an insert or update SENDS is never kept. On an update that
--    does not move the booking (same unit, slot and date), the OLD price is
--    kept, so a later rate change never reprices history.
--    GUARDED (code review, 2026-09-28): schema-extra-guests.sql replaces this
--    with a newer version. Once that file has run (unit_quote() exists),
--    re-running THIS file must not put the older one back, so the definition
--    is skipped. On a fresh database, before extra-guests, it runs as normal.
do $guard$
begin
  if to_regprocedure('public.unit_quote(bigint, bigint, bigint, date, int)') is null then
    execute $ddl$
create or replace function bookings_compute_during() returns trigger
language plpgsql
as $$
declare
  v_timezone text;
  v_start    time;
  v_duration interval;
  v_active   boolean;
  v_capacity int;
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
    if tg_op = 'UPDATE'
       and new.unit_id = old.unit_id and new.slot_id = old.slot_id and new.booked_date = old.booked_date then
      new.price := old.price;
    else
      new.price := public.unit_price(new.tenant_id, new.unit_id, new.slot_id, new.booked_date);
      if new.price is null then
        raise exception 'Unit % has no rate for slot %', new.unit_id, new.slot_id
          using errcode = 'check_violation';
      end if;
    end if;
  else
    new.price := null;
  end if;

  return new;
end;
$$
    $ddl$;
    -- Now also fires when the unit, the guest count or the price is written.
    -- A status change alone (cancelling) still fires nothing.
    execute 'drop trigger if exists bookings_compute_during on bookings';
    execute $ddl$
create trigger bookings_compute_during
  before insert or update of tenant_id, unit_id, slot_id, booked_date, guest_count, price on bookings
  for each row execute function bookings_compute_during()
    $ddl$;
  end if;
end
$guard$;

-- 7. check_availability: the schema-auth.sql body, with ONE change, `and
--    u.active`. An inactive room must not be offered as open. Villa's one
--    unit is active, so villa's rows are unchanged (Phase 1's done-when diffs
--    them). Same signature, so `create or replace` keeps its grants.
--    GUARDED (customer booking Phase 1, 2026-09-28): schema-customer-booking.sql
--    replaces this. Once that file has run (rate_calendar exists), re-running
--    THIS file must not put the older definition back, so it is skipped.
do $guard$
begin
  if to_regclass('public.rate_calendar') is null then
    execute $ddl$
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
          and b.status <> 'cancelled'
          and b.during && public.slot_range(d::date, s.start_time, s.duration, v_timezone)
      ) then 'taken' else 'open' end
    from generate_series(p_from, p_to, interval '1 day') as d
    cross join public.units u
    join public.slots s on s.tenant_id = u.tenant_id
    where u.tenant_id = p_tenant_id
      and u.active
    order by d, u.name, s.start_time, s.name;
end;
$$
    $ddl$;
  end if;
end
$guard$;

-- 8. Room availability, for per_room tenants (plan § 3 step 8, D-054).
--
--    A SEPARATE function, so check_availability's four columns, and so villa's
--    tool result and prompt, stay byte-identical (Rule 1). The same five
--    properties as check_availability: security definer, search_path = '',
--    the token-tenant check, a range cap, and NO guest data. It adds only
--    what a resort publishes anyway: capacity and price (plan Rule 4). Not
--    the description: tenant-written free text in a tool result is a
--    prompt-injection surface.
--
--    Only rooms that could actually be booked: active, and with a rate for
--    that slot. A room with no rate would be "open" here and refused by the
--    insert trigger, so it is left out rather than offered.
--
--    p_slot, p_unit and p_guests narrow the result (plan § 2.6: rooms × slots
--    × days grows fast). They are NOT tenant parameters and have no defaults
--    either; pass null for "any".
--
--    Zero rows for a whole_resort tenant, the same answer as a tenant with no
--    rooms, so the result says nothing about how another tenant is set up.
--    GUARDED (code review, 2026-09-28): schema-extra-guests.sql replaces this
--    with a newer version. Once that file has run (unit_quote() exists),
--    re-running THIS file must not put the older one back, so the definition
--    is skipped. On a fresh database, before extra-guests, it runs as normal.
do $guard$
begin
  if to_regprocedure('public.unit_quote(bigint, bigint, bigint, date, int)') is null then
    execute $ddl$
create or replace function check_room_availability (
  p_tenant_id bigint,
  p_from      date,
  p_to        date,
  p_slot      text,
  p_unit      text,
  p_guests    int
)
returns table (
  booked_date date,
  unit        text,
  capacity    int,
  slot        text,
  status      text,
  price       bigint
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
      s.name,
      case when exists (
        select 1
        from public.bookings b
        where b.tenant_id = p_tenant_id
          and b.unit_id = u.id
          and b.status <> 'cancelled'
          and b.during && public.slot_range(d::date, s.start_time, s.duration, v_timezone)
      ) then 'taken' else 'open' end,
      r.price
    from generate_series(p_from, p_to, interval '1 day') as d
    cross join public.units u
    join public.slots s on s.tenant_id = u.tenant_id
    cross join lateral (select public.unit_price(p_tenant_id, u.id, s.id, d::date) as price) r
    where u.tenant_id = p_tenant_id
      and u.active
      and r.price is not null
      and (p_slot   is null or s.name = p_slot)
      and (p_unit   is null or u.name = p_unit)
      -- A null capacity is "no maximum", so it fits any party. `capacity >=
      -- p_guests` alone is null for it, and dropped the room (code review,
      -- 2026-09-28).
      and (p_guests is null or u.capacity is null or u.capacity >= p_guests)
    order by d, u.sort_order, u.name, s.start_time, s.name;
end;
$$
    $ddl$;
  end if;
end
$guard$;

-- 9. RLS, and EXECUTE grants.
--
--    unit_rates: any token of the tenant READS (a resort publishes its
--    rates, and the insert trigger reads them as whoever inserts); only its
--    admins write. units gains insert and update for admins; its read policy
--    is schema-auth.sql's. Still no delete policy on units.
--
--    Write policies check BOTH the tenant and admin, as in schema-auth.sql:
--    admin alone would let an admin insert a row carrying another tenant's id.
alter table unit_rates enable row level security;

drop policy if exists unit_rates_read   on unit_rates;
drop policy if exists unit_rates_insert on unit_rates;
drop policy if exists unit_rates_update on unit_rates;
drop policy if exists unit_rates_delete on unit_rates;
create policy unit_rates_read on unit_rates for select to authenticated
  using (tenant_id = (select public.app_tenant_id()));
create policy unit_rates_insert on unit_rates for insert to authenticated
  with check (tenant_id = (select public.app_tenant_id()) and (select public.app_is_admin()));
create policy unit_rates_update on unit_rates for update to authenticated
  using      (tenant_id = (select public.app_tenant_id()) and (select public.app_is_admin()))
  with check (tenant_id = (select public.app_tenant_id()) and (select public.app_is_admin()));
create policy unit_rates_delete on unit_rates for delete to authenticated
  using (tenant_id = (select public.app_tenant_id()) and (select public.app_is_admin()));

drop policy if exists units_insert on units;
drop policy if exists units_update on units;
create policy units_insert on units for insert to authenticated
  with check (tenant_id = (select public.app_tenant_id()) and (select public.app_is_admin()));
create policy units_update on units for update to authenticated
  using      (tenant_id = (select public.app_tenant_id()) and (select public.app_is_admin()))
  with check (tenant_id = (select public.app_tenant_id()) and (select public.app_is_admin()));

-- Belt and braces, as for memberships: Supabase grants every privilege on a
-- new table to anon by default. anon has no policy, but it has no reason to
-- hold the privilege either.
revoke all on unit_rates from anon;

-- Postgres grants EXECUTE to PUBLIC on every new function, and Supabase adds
-- anon and authenticated. Revoke all three, then grant back exactly who needs
-- it (schema-auth.sql step 6 does the same for the older functions).
revoke all on function booking_type_of(bigint)                                    from public, anon, authenticated;
revoke all on function unit_price(bigint, bigint, bigint, date)                   from public, anon, authenticated;
revoke all on function check_room_availability(bigint, date, date, text, text, int) from public, anon, authenticated;
grant execute on function booking_type_of(bigint)                                 to authenticated, service_role;
grant execute on function unit_price(bigint, bigint, bigint, date)                to authenticated, service_role;
grant execute on function check_room_availability(bigint, date, date, text, text, int) to authenticated, service_role;

-- 10. Photos: one row per stored object (plan § 2.8). `path` is the object's
--     name in the bucket, always '<tenant_id>/<unit_id>/<uuid>.<ext>'. The
--     check makes a row pointing into another tenant's folder impossible, and
--     the composite FK a row naming another tenant's unit.
create table if not exists unit_images (
  id         bigint generated always as identity primary key,
  tenant_id  bigint not null references tenants(id) on delete cascade,
  unit_id    bigint not null,
  path       text   not null unique,
  sort_order int    not null default 0,
  created_at timestamptz not null default now(),
  constraint unit_images_unit_tenant_fk foreign key (unit_id, tenant_id)
    references units (id, tenant_id) on delete cascade,
  constraint unit_images_path_tenant check (path like tenant_id::text || '/' || unit_id::text || '/%')
);
create index if not exists unit_images_tenant_unit_idx on unit_images (tenant_id, unit_id, sort_order);

--     At most 6 photos per room (MAX_IMAGES_PER_UNIT in @rag/bookings). A
--     count checked in TypeScript races, like "check, then insert", so it is
--     checked here, under a per-unit advisory lock that serialises two
--     concurrent uploads to the same room for the rest of the transaction.
create or replace function unit_images_cap() returns trigger
language plpgsql
as $$
declare
  v_count int;
begin
  perform pg_advisory_xact_lock(hashtext('unit_images'), new.unit_id::int);
  select count(*) into v_count from public.unit_images where tenant_id = new.tenant_id and unit_id = new.unit_id;
  if v_count >= 6 then
    raise exception 'Unit % already has % photos; the limit is 6', new.unit_id, v_count
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists unit_images_cap on unit_images;
create trigger unit_images_cap
  before insert on unit_images
  for each row execute function unit_images_cap();

--     Any token of the tenant reads (the photos are public anyway); admins
--     add, reorder and remove. The only column an update may touch is
--     sort_order (the column grant below): a row never starts pointing at a
--     different object, the same rule as the bucket's missing update policy.
alter table unit_images enable row level security;
drop policy if exists unit_images_read   on unit_images;
drop policy if exists unit_images_insert on unit_images;
drop policy if exists unit_images_update on unit_images;
drop policy if exists unit_images_delete on unit_images;
create policy unit_images_read on unit_images for select to authenticated
  using (tenant_id = (select public.app_tenant_id()));
create policy unit_images_insert on unit_images for insert to authenticated
  with check (tenant_id = (select public.app_tenant_id()) and (select public.app_is_admin()));
create policy unit_images_update on unit_images for update to authenticated
  using      (tenant_id = (select public.app_tenant_id()) and (select public.app_is_admin()))
  with check (tenant_id = (select public.app_tenant_id()) and (select public.app_is_admin()));
create policy unit_images_delete on unit_images for delete to authenticated
  using (tenant_id = (select public.app_tenant_id()) and (select public.app_is_admin()));
revoke all on unit_images from anon;
revoke update on unit_images from authenticated;
grant update (sort_order) on unit_images to authenticated;

-- 11. Room photos: the bucket, and who may write to it.
--
-- PUBLIC for reads (plan § 2.8): room photos are the tenant's marketing, a
-- public URL needs no token to display, and object names are random UUIDs, so
-- there is nothing to enumerate. `public` only opens the public-URL endpoint;
-- the API's list/select still goes through the policies below.
--
-- file_size_limit and allowed_mime_types are the SECOND wall. The upload
-- route checks size and type first; the bucket still refuses if the route has
-- a bug. 2 MiB is provisional: Phase 4 measures a real phone photo after the
-- browser resize and sets MAX_IMAGE_BYTES (and this) from that. No SVG: it
-- can carry script.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('unit-images', 'unit-images', true, 2097152, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update
  set public             = excluded.public,
      file_size_limit    = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- Objects are named '<tenant_id>/<unit_id>/<uuid>.<ext>'. Every policy
-- compares the FIRST folder with the token's tenant: that is wall 2.
-- Wall 1 is @rag/bookings building the path from tenant.id itself.
--
-- Staff only, for all three. A chat token has app_is_admin() = false, so it
-- can neither upload nor delete. `select` is needed because Storage reads
-- the object's row to delete it, and for the staff screen's listing; public
-- reads of the image itself do not go through it.
--
-- No UPDATE policy: a photo is replaced by delete + upload, so a path never
-- starts showing a different picture. (It also means upload with
-- `upsert: true` is refused, which is intended.)
--
-- The helpers are wrapped as `(select …)`, the same InitPlan form as every
-- policy in schema-auth.sql.
drop policy if exists unit_images_objects_insert on storage.objects;
drop policy if exists unit_images_objects_select on storage.objects;
drop policy if exists unit_images_objects_delete on storage.objects;

create policy unit_images_objects_insert on storage.objects for insert to authenticated
  with check (
    bucket_id = 'unit-images'
    and (storage.foldername(name))[1] = (select public.app_tenant_id())::text
    and (select public.app_is_admin())
  );

create policy unit_images_objects_select on storage.objects for select to authenticated
  using (
    bucket_id = 'unit-images'
    and (storage.foldername(name))[1] = (select public.app_tenant_id())::text
    and (select public.app_is_admin())
  );

create policy unit_images_objects_delete on storage.objects for delete to authenticated
  using (
    bucket_id = 'unit-images'
    and (storage.foldername(name))[1] = (select public.app_tenant_id())::text
    and (select public.app_is_admin())
  );

-- The spike that proved § 11: plan/booking-types-phase1-storage.mjs
--   (cd packages/db && node --conditions=react-server --env-file=../../.env ../../plan/booking-types-phase1-storage.mjs)

-- PostgREST caches the schema. Without this the new table, columns and
-- functions stay invisible to .from() and .rpc() until it refreshes itself.
notify pgrst, 'reload schema';

-- Verify:
--   pnpm --filter @rag/db verify     (the booking-types checks, with positive twins)
