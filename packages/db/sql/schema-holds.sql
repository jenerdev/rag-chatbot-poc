-- schema-holds.sql — a stay may HOLD its dates while the guest pays
-- (plan/manage-booking.md Phase 5, § 2.4, § 9 q1; D-106).
--
-- Run AFTER schema-manage-booking.sql. The 24th file. Idempotent. A tenant
-- chooses in its payment settings, config.payments.hold:
--   none        (the default, and every tenant today) nothing changes: a
--               pending stay holds nothing (D-070), only `confirmed` blocks
--   on_proof    a stay holds its dates from the moment its guest sends a
--               proof, until staff decide it (review_by)
--   on_request  a WEB stay holds from the moment it is made, until its
--               payment deadline (pay_by); a proof extends it to review_by
--
-- How, without a time comparison inside a constraint (now() is not
-- immutable, § 2.4):
--   * bookings.held (a flag) and bookings.held_until (when it lapses);
--   * bookings_no_overlap becomes `where (status = 'confirmed' or held)`;
--   * READS ask booking_takes(status, held, held_until), the ONE "taken"
--     test: confirmed, or held and not lapsed. A read may use now();
--   * WRITES that could meet a hold release the lapsed ones first, under no
--     lock but the row's own (bookings_release_due_holds), so a lapsed hold
--     never blocks a write and no job is needed for correctness;
--   * a row that leaves `pending` drops its hold (bookings_clear_hold).
--
-- It REPLACES four definitions, each with ONE change, the taken test:
--   check_availability()        (schema-customer-booking.sql)
--   check_room_availability()   (schema-day-price.sql)
--   request_booking()           (schema-staff-requests.sql)
--   bookings_pending_not_taken() (schema-taken-span.sql; also: a hold's own words)
-- and re-creates bookings_no_overlap (schema-customer-booking.sql). Each of
-- those older steps is now GUARDED on this file's marker, booking_takes(),
-- so re-running an older file cannot put the confirmed-only version back
-- (CLAUDE.md trap 20).

-- 1. The columns. held_until is per row, so the taken test needs no join.
alter table bookings add column if not exists held boolean not null default false;
alter table bookings add column if not exists held_until timestamptz;
alter table bookings drop constraint if exists bookings_held_until;
alter table bookings add constraint bookings_held_until check (not held or held_until is not null);
create index if not exists bookings_held_idx on bookings (tenant_id, held_until) where held;

-- 2. The marker, and the ONE taken test every read asks.
create or replace function booking_takes(p_status text, p_held boolean, p_held_until timestamptz)
returns boolean
language sql
stable
set search_path = ''
as $$
  select p_status = 'confirmed' or (coalesce(p_held, false) and p_held_until > now())
$$;

-- 3. A row that leaves `pending` holds nothing any more: confirmed takes
--    the span on its own, cancelled and expired free it. BEFORE UPDATE.
create or replace function bookings_clear_hold() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.status <> 'pending' and (new.held or new.held_until is not null) then
    new.held := false;
    new.held_until := null;
  end if;
  return new;
end;
$$;
drop trigger if exists bookings_clear_hold on bookings;
create trigger bookings_clear_hold
  before update on bookings
  for each row execute function bookings_clear_hold();

-- 4. Release the tenant's lapsed holds before a write that could meet one:
--    an INSERT (a request, a staff booking) and a Confirm. SECURITY DEFINER:
--    the caller (a chat token inside request_booking(), a staff token) may
--    not be able to update every row it must release. It only ever clears
--    `held` on rows whose held_until has passed, which no one is owed.
--    The WHEN clauses keep it from firing on its own updates (no recursion:
--    a release changes no status).
create or replace function bookings_release_due_holds() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.bookings b
  set held = false, held_until = null
  where b.tenant_id = new.tenant_id and b.held and b.held_until <= now();
  return new;
end;
$$;
revoke all on function bookings_release_due_holds() from public, anon, authenticated;
drop trigger if exists bookings_aa0_release_due_holds on bookings;
create trigger bookings_aa0_release_due_holds
  before insert on bookings
  for each row execute function bookings_release_due_holds();
drop trigger if exists bookings_aa0_release_before_confirm on bookings;
create trigger bookings_aa0_release_before_confirm
  before update of status on bookings
  for each row when (new.status = 'confirmed' and old.status is distinct from 'confirmed')
  execute function bookings_release_due_holds();

-- 5. The constraint: a live hold blocks like a confirmed row. Re-created;
--    it can fail only if two held rows already overlap, and none is held
--    before this file runs (held defaults to false).
alter table bookings drop constraint if exists bookings_no_overlap;
alter table bookings add  constraint bookings_no_overlap exclude using gist (
  unit_id with =,
  during  with &&
) where (status = 'confirmed' or held);

-- 6. Taking a hold: ONE function. Sets `held` on the stay's PENDING rows
--    until p_until. A clash with a confirmed or held row is 23P01 from the
--    constraint; the callers decide what that means.
create or replace function hold_stay(p_tenant_id bigint, p_group_id uuid, p_until timestamptz)
returns int
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_count int;
begin
  update public.bookings b
  set held = true, held_until = greatest(coalesce(b.held_until, p_until), p_until)
  where b.tenant_id = p_tenant_id and b.group_id = p_group_id and b.status = 'pending';
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;
revoke all on function hold_stay(bigint, uuid, timestamptz) from public, anon, authenticated;

create or replace function release_stay(p_tenant_id bigint, p_group_id uuid)
returns void
language sql
volatile
security definer
set search_path = ''
as $$
  update public.bookings b set held = false, held_until = null
  where b.tenant_id = p_tenant_id and b.group_id = p_group_id and b.held
$$;
revoke all on function release_stay(bigint, uuid) from public, anon, authenticated;

-- 7. on_request: a WEB stay holds from birth until pay_by. AFTER INSERT,
--    per statement (pay_by was set by bookings_set_terms, which sorts
--    before this by name). A clash here is the constraint's 23P01, and the
--    whole request fails: request_booking() answers "That date is no
--    longer available", which is true: someone holds it.
create or replace function bookings_hold_on_request() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  r record;
begin
  for r in
    select distinct n.tenant_id, n.group_id, s.pay_by
    from born n
    join public.stays s on s.tenant_id = n.tenant_id and s.group_id = n.group_id
    join public.tenant_applications a on a.tenant_id = n.tenant_id and a.application_key = 'bookings'
    where n.source = 'web' and n.status = 'pending' and s.pay_by is not null
      and a.config->'payments'->>'hold' = 'on_request'
  loop
    perform public.hold_stay(r.tenant_id, r.group_id, r.pay_by);
  end loop;
  return null;
end;
$$;
revoke all on function bookings_hold_on_request() from public, anon, authenticated;
drop trigger if exists bookings_zz_hold_on_request on bookings;
create trigger bookings_zz_hold_on_request
  after insert on bookings
  referencing new table as born
  for each statement execute function bookings_hold_on_request();

-- 8. on_proof (and on_request): a proof holds the stay until review_by.
--    submit_payment() inserts the payment and THEN sets stays.review_by, so
--    the hold is taken on that update. A clash does NOT refuse the proof:
--    the money may already be sent, so the proof is kept and the stay simply
--    holds nothing (staff see it in the queue and decide). The exception
--    block is a subtransaction.

create or replace function stays_hold_on_review() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_hold text;
begin
  if new.review_by is null or new.review_by is not distinct from old.review_by then
    return null;
  end if;
  select a.config->'payments'->>'hold' into v_hold from public.tenant_applications a
  where a.tenant_id = new.tenant_id and a.application_key = 'bookings';
  if coalesce(v_hold, 'none') = 'none' then
    return null;
  end if;
  begin
    perform public.hold_stay(new.tenant_id, new.group_id, new.review_by);
  exception when exclusion_violation then
    raise notice 'stay %: could not be held, another booking takes its dates', new.group_id;
  end;
  return null;
end;
$$;
revoke all on function stays_hold_on_review() from public, anon, authenticated;
drop trigger if exists stays_hold_on_review on stays;
create trigger stays_hold_on_review
  after update of review_by on stays
  for each row execute function stays_hold_on_review();

-- 9. A REJECTED proof ends the hold it started, unless the stay's own
--    payment window (on_request) is still open: then it holds until pay_by.
create or replace function payments_release_on_reject() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_hold   text;
  v_pay_by timestamptz;
begin
  if new.kind <> 'payment' or new.status <> 'rejected' or old.status = 'rejected' then
    return null;
  end if;
  select a.config->'payments'->>'hold' into v_hold from public.tenant_applications a
  where a.tenant_id = new.tenant_id and a.application_key = 'bookings';
  select s.pay_by into v_pay_by from public.stays s where s.tenant_id = new.tenant_id and s.group_id = new.group_id;
  perform public.release_stay(new.tenant_id, new.group_id);
  if v_hold = 'on_request' and v_pay_by > now() then
    begin
      perform public.hold_stay(new.tenant_id, new.group_id, v_pay_by);
    exception when exclusion_violation then
      null;
    end;
  end if;
  return null;
end;
$$;
revoke all on function payments_release_on_reject() from public, anon, authenticated;
drop trigger if exists payments_release_on_reject on payments;
create trigger payments_release_on_reject
  after update of status on payments
  for each row execute function payments_release_on_reject();

-- 10–13. The four reads and checks, each with ONE change: the taken test is
--        booking_takes(). Everything else is the older file's text.

-- 10. check_availability(), from schema-customer-booking.sql.
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
          and public.booking_takes(b.status, b.held, b.held_until)
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

-- 11. check_room_availability(), from schema-day-price.sql (create OR
--     REPLACE here: same signature, its grants are kept).
create or replace function public.check_room_availability (
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
          and public.booking_takes(b.status, b.held, b.held_until)
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
$$;

-- 12. request_booking(), from schema-staff-requests.sql.
create or replace function request_booking (
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
  if (select count(distinct u) from unnest(p_unit_ids) u) <> v_units then
    raise exception 'A unit appears twice' using errcode = 'invalid_parameter_value';
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

  if exists (
    select 1
    from unnest(p_unit_ids) as u(unit_id)
    cross join generate_series(0, p_nights - 1) as n
    join public.bookings b
      on b.tenant_id = p_tenant_id and b.unit_id = u.unit_id and public.booking_takes(b.status, b.held, b.held_until)
     and b.during && public.slot_range(p_check_in + n, v_start, v_duration, v_timezone)
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

-- 13. bookings_pending_not_taken(), from schema-taken-span.sql, plus a
--     hold's own words ("is held for another guest"), which taken.ts passes
--     through like the confirmed ones.
create or replace function bookings_pending_not_taken() returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_unit text;
begin
  if new.status <> 'pending' then
    return new;   -- a confirmed insert is the constraint's to judge; a cancelled one holds nothing
  end if;
  if new.during is null then
    raise exception 'booking on % has no span to check', new.booked_date using errcode = 'exclusion_violation';
  end if;
  select u.name into v_unit from public.units u where u.tenant_id = new.tenant_id and u.id = new.unit_id;
  if exists (
    select 1 from public.bookings c
    where c.tenant_id = new.tenant_id
      and c.unit_id   = new.unit_id
      and c.status    = 'confirmed'
      and c.during && new.during
  ) then
    raise exception 'taken on %: % is already confirmed for that slot', new.booked_date, coalesce(v_unit, 'that unit')
      using errcode = 'exclusion_violation';
  end if;
  -- schema-holds.sql: a live hold blocks a new pending row too, in its own words.
  if exists (
    select 1 from public.bookings c
    where c.tenant_id = new.tenant_id
      and c.unit_id   = new.unit_id
      and public.booking_takes(c.status, c.held, c.held_until)
      and c.during && new.during
  ) then
    raise exception 'taken on %: % is held for another guest for that slot', new.booked_date, coalesce(v_unit, 'that unit')
      using errcode = 'exclusion_violation';
  end if;
  return new;
end;
$$;

notify pgrst, 'reload schema';
