-- schema-promos.sql — promos: a discount the tenant defines, applied by the
-- database in the one place every price is made (plan/promos.md, D-097).
--
-- Run after schema-decision-note.sql. Idempotent. The 18th file.
--
-- What it adds, in order:
--   1. `promos`: name, kind ('fixed' | 'percent'), value (centavos, or
--      hundredths of a percent: 1250 = 12.50 %), a validity range over the
--      STAY dates, an optional code (unique per tenant, case-insensitive), an
--      optional usage limit, active. RLS: every member reads (the staff form
--      lists them), owners and admins write, a CHAT TOKEN READS NOTHING: a
--      customer reaches a promo only through promo_for_request() (Rule 2).
--   2. `bookings.promo_id` and `bookings.discount`: what a booking got.
--   3. promo_uses(): count(distinct request) pending or confirmed, computed,
--      never stored (§ 2.3). promo_discount(): ONE night's discount, the only
--      arithmetic (Rule 1): fixed on the first row of a stay, capped at the
--      night's price; percent rounded half up to the centavo (§ 2.1, q5).
--      promo_for_request(): the customer's one door, security definer: the
--      promo for a typed code, or the automatic one with the largest discount
--      for this stay, with a `reason` when it does not apply ('dates',
--      'exhausted'), and no rows for a wrong code or another tenant's.
--   4. bookings_compute_during(): with promo_id, the discount from
--      promo_discount() and `price` net of it; the promo must be the
--      tenant's, active, cover the night; the usage limit is checked UNDER
--      the tenant's request lock (Rule 3); the keep-old-price branch keeps
--      the discount (Rule 4). A forged `discount` is overwritten.
--   5. request_booking(): an 11th parameter, p_promo_code. The old 10-param
--      function is DROPPED (two overloads would be ambiguous to PostgREST);
--      schema-roles.sql's definition is now guarded on this table, so a
--      re-run of that file cannot put it back (trap 20). The code is
--      resolved under the lock, the stay's dates and the limit checked in
--      words, promo_id stored on every night, and `discount` returned.
--
-- Every function: search_path = '' and every name qualified (trap 19). The
-- definers check their caller themselves (D-042).

-- 1. The table. Created FIRST: its existence is the marker the older file's
--    guard reads (to_regclass('public.promos')).
create table if not exists promos (
  id          bigint      generated always as identity primary key,
  tenant_id   bigint      not null references tenants(id) on delete cascade,
  name        text        not null,
  kind        text        not null,
  value       bigint      not null,
  valid_from  date        not null,
  valid_to    date        not null,
  code        text,
  max_uses    int,
  active      boolean     not null default true,
  created_at  timestamptz not null default now(),
  constraint promos_kind        check (kind in ('fixed', 'percent')),
  constraint promos_value       check (value > 0 and (kind <> 'percent' or value <= 10000)),
  constraint promos_range       check (valid_to >= valid_from),
  constraint promos_max_uses    check (max_uses is null or max_uses > 0),
  constraint promos_code_shape  check (code is null or code ~ '^[A-Za-z0-9_-]{3,32}$'),
  constraint promos_name_length check (char_length(name) between 1 and 80)
);
create unique index if not exists promos_code_per_tenant on promos (tenant_id, lower(code)) where code is not null;
create index if not exists promos_tenant on promos (tenant_id);

alter table promos enable row level security;
drop policy if exists promos_select on promos;
drop policy if exists promos_insert on promos;
drop policy if exists promos_update on promos;
drop policy if exists promos_delete on promos;
-- Any MEMBER reads (the staff booking form offers them); a chat token has no
-- sub, app_is_staff() is false, and it reads nothing.
create policy promos_select on promos for select to authenticated
  using (tenant_id = (select public.app_tenant_id()) and (select public.app_is_staff()));
create policy promos_insert on promos for insert to authenticated
  with check (tenant_id = (select public.app_tenant_id()) and (select public.app_is_admin()));
create policy promos_update on promos for update to authenticated
  using      (tenant_id = (select public.app_tenant_id()) and (select public.app_is_admin()))
  with check (tenant_id = (select public.app_tenant_id()) and (select public.app_is_admin()));
create policy promos_delete on promos for delete to authenticated
  using (tenant_id = (select public.app_tenant_id()) and (select public.app_is_admin()));

-- 2. What a booking got. `discount` is part of `price` (price = quote − discount).
alter table bookings add column if not exists promo_id bigint references promos(id);
alter table bookings add column if not exists discount bigint;
alter table bookings drop constraint if exists bookings_discount_nonnegative;
alter table bookings add  constraint bookings_discount_nonnegative check (discount is null or discount >= 0);
create index if not exists bookings_promo on bookings (promo_id) where promo_id is not null;

-- 3a. Uses: distinct requests (group_id, or the row itself when a staff
--     booking has none), pending or confirmed. A cancelled or declined one
--     no longer counts (§ 2.3). The two `except` arguments let the trigger
--     leave the row or group being written out of the count.
create or replace function promo_uses(p_tenant_id bigint, p_promo_id bigint, p_except_group uuid default null, p_except_id bigint default null)
returns int
language sql stable
security definer
set search_path = ''
as $$
  select count(distinct coalesce(b.group_id::text, 'b' || b.id::text))::int
  from public.bookings b
  where b.tenant_id = p_tenant_id
    and b.promo_id = p_promo_id
    and b.status in ('pending', 'confirmed')
    and (p_except_group is null or b.group_id is distinct from p_except_group)
    and (p_except_id is null or b.id <> p_except_id)
$$;

-- 3b. ONE night's discount, the only arithmetic there is (Rule 1).
--     fixed:   the whole amount on the FIRST row of the stay, capped at that
--              night's price so no row goes negative; 0 on the others (§ 2.2)
--     percent: round half up to the centavo (q5): round() on numeric
--     Null when the promo is not this tenant's; callers coalesce to 0.
create or replace function promo_discount(p_tenant_id bigint, p_promo_id bigint, p_price bigint, p_first boolean)
returns bigint
language sql stable
security definer
set search_path = ''
as $$
  select case
           when p.kind = 'fixed' then case when p_first then least(p.value, greatest(p_price, 0)) else 0 end
           else least(greatest(p_price, 0), round(greatest(p_price, 0)::numeric * p.value / 10000)::bigint)
         end
  from public.promos p
  where p.tenant_id = p_tenant_id and p.id = p_promo_id
$$;

-- 3c. The customer's one door (Rule 2). For a typed code: that promo, with a
--     reason when it does not apply to this stay; no rows for a code that is
--     not this tenant's, or not there. With no code: the automatic promo
--     (code is null) that covers the stay and has uses left, the larger
--     discount for this stay first (q3). The tenant is the token's (wall 2);
--     p_tenant_id is what the route sends (wall 1).
create or replace function promo_for_request(p_tenant_id bigint, p_code text, p_from date, p_to date, p_subtotal bigint)
returns table (id bigint, name text, kind text, value bigint, valid_from date, valid_to date, reason text)
language plpgsql stable
security definer
set search_path = ''
as $$
declare
  v_code  text;
  v_promo public.promos%rowtype;
begin
  if coalesce(auth.jwt() ->> 'role', '') <> 'service_role'
     and p_tenant_id is distinct from public.app_tenant_id() then
    raise exception 'promo_for_request: tenant % is not the token''s tenant', p_tenant_id
      using errcode = 'insufficient_privilege';
  end if;
  if p_from is null or p_to is null or p_to < p_from then
    return;
  end if;

  v_code := nullif(btrim(coalesce(p_code, '')), '');
  if v_code is not null then
    select p.* into v_promo
    from public.promos p
    where p.tenant_id = p_tenant_id and p.active and p.code is not null and lower(p.code) = lower(v_code);
    if not found then
      return;
    end if;
    return query
      select v_promo.id, v_promo.name, v_promo.kind, v_promo.value, v_promo.valid_from, v_promo.valid_to,
             case
               when p_from < v_promo.valid_from or p_to > v_promo.valid_to then 'dates'
               when v_promo.max_uses is not null and public.promo_uses(p_tenant_id, v_promo.id) >= v_promo.max_uses then 'exhausted'
               else null
             end;
    return;
  end if;

  return query
    select p.id, p.name, p.kind, p.value, p.valid_from, p.valid_to, null::text
    from public.promos p
    where p.tenant_id = p_tenant_id and p.active and p.code is null
      and p.valid_from <= p_from and p.valid_to >= p_to
      and (p.max_uses is null or public.promo_uses(p_tenant_id, p.id) < p.max_uses)
    order by public.promo_discount(p_tenant_id, p.id, coalesce(p_subtotal, 0), true) desc, p.id
    limit 1;
end;
$$;

-- 4. The trigger, with the discount in it. Everything before the price is as
--    schema-customer-booking.sql wrote it.
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
  v_promo    public.promos%rowtype;
  v_first    boolean;
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

  -- A booking that did not move, with the same promo, keeps its stored price
  -- AND its stored discount (Rule 4): a promo edited later changes nothing here.
  if tg_op = 'UPDATE'
     and new.unit_id = old.unit_id and new.slot_id = old.slot_id and new.booked_date = old.booked_date
     and new.guest_count is not distinct from old.guest_count
     and new.promo_id is not distinct from old.promo_id then
    new.base_price        := old.base_price;
    new.extra_guest_price := old.extra_guest_price;
    new.surcharge         := old.surcharge;
    new.discount          := old.discount;
    new.price             := old.price;
    return new;
  end if;

  select * into v_quote
  from public.unit_quote(new.tenant_id, new.unit_id, new.slot_id, new.booked_date, new.guest_count);
  if found then
    new.base_price        := v_quote.base_price;
    new.extra_guest_price := v_quote.extra_guest_price;
    new.surcharge         := v_quote.surcharge;
    if new.promo_id is null then
      new.discount := null;
      new.price    := v_quote.price;
    else
      -- The promo must be this tenant's, offered, and cover this night. The
      -- same words a customer gets from request_booking().
      select p.* into v_promo from public.promos p where p.id = new.promo_id and p.tenant_id = new.tenant_id;
      if not found then
        raise exception 'Promo % does not belong to tenant %', new.promo_id, new.tenant_id
          using errcode = 'foreign_key_violation';
      end if;
      if not v_promo.active then
        raise exception 'The promo "%" is no longer offered', v_promo.name using errcode = 'check_violation';
      end if;
      if new.booked_date < v_promo.valid_from or new.booked_date > v_promo.valid_to then
        raise exception 'The promo "%" covers stays from % to %', v_promo.name, v_promo.valid_from, v_promo.valid_to
          using errcode = 'check_violation';
      end if;
      -- The usage limit, under the tenant's request lock (Rule 3): the same
      -- key request_booking() takes, so both doors are serialised together.
      -- This row's own group is left out of the count: a stay is ONE use.
      if v_promo.max_uses is not null then
        perform pg_advisory_xact_lock(hashtextextended('request_booking:' || new.tenant_id::text, 0));
        if public.promo_uses(new.tenant_id, new.promo_id, new.group_id, new.id) >= v_promo.max_uses then
          raise exception 'The promo "%" has reached its limit', v_promo.name using errcode = 'check_violation';
        end if;
      end if;
      -- The first row of a stay: no sibling earlier by date, then by id. A
      -- request's rows are inserted in date order (step 5), so the first
      -- night's first room carries a fixed amount; a lone booking is first.
      v_first := new.group_id is null or not exists (
        select 1 from public.bookings b
        where b.tenant_id = new.tenant_id and b.group_id = new.group_id and b.id <> new.id
          and (b.booked_date < new.booked_date or (b.booked_date = new.booked_date and b.id < new.id))
      );
      new.discount := coalesce(public.promo_discount(new.tenant_id, new.promo_id, v_quote.price, v_first), 0);
      new.price    := v_quote.price - new.discount;
    end if;
  elsif v_per_room then
    raise exception 'Unit % has no rate for slot %', new.unit_id, new.slot_id
      using errcode = 'check_violation';
  else
    new.base_price        := null;
    new.extra_guest_price := null;
    new.surcharge         := null;
    new.discount          := null;
    new.price             := null;
  end if;

  return new;
end;
$$;

drop trigger if exists bookings_compute_during on bookings;
create trigger bookings_compute_during
  before insert or update of tenant_id, unit_id, slot_id, booked_date, guest_count, price, base_price, extra_guest_price, surcharge, promo_id, discount on bookings
  for each row execute function bookings_compute_during();

-- 5. request_booking() with p_promo_code. The 10-parameter function is
--    dropped: with both, a call that omits the code would match both.
drop function if exists request_booking(bigint, bigint, bigint[], int[], date, int, text, text, text, text);

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
      on b.tenant_id = p_tenant_id and b.unit_id = u.unit_id and b.status = 'confirmed'
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

  loop
    v_ref := upper(left(regexp_replace(v_slug, '[^a-zA-Z]', '', 'g') || 'XXX', 3)) || '-' ||
             (select string_agg(substr(c_alphabet, 1 + floor(random() * 30)::int, 1), '')
                from generate_series(1, 6));
    exit when not exists (select 1 from public.bookings b where b.tenant_id = p_tenant_id and b.reference = v_ref);
  end loop;

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

-- 6. EXECUTE grants: revoke from all three, grant back exactly who needs it.
revoke all on function promo_uses(bigint, bigint, uuid, bigint)                 from public, anon, authenticated;
revoke all on function promo_discount(bigint, bigint, bigint, boolean)          from public, anon, authenticated;
revoke all on function promo_for_request(bigint, text, date, date, bigint)      from public, anon, authenticated;
revoke all on function request_booking(bigint, bigint, bigint[], int[], date, int, text, text, text, text, text) from public, anon, authenticated;
grant execute on function promo_uses(bigint, bigint, uuid, bigint)              to authenticated, service_role;
grant execute on function promo_discount(bigint, bigint, bigint, boolean)       to authenticated, service_role;
grant execute on function promo_for_request(bigint, text, date, date, bigint)   to authenticated, service_role;
grant execute on function request_booking(bigint, bigint, bigint[], int[], date, int, text, text, text, text, text) to authenticated, service_role;

-- PostgREST caches the schema: without this, promos and the new columns stay
-- invisible to .from() and .rpc().
notify pgrst, 'reload schema';

-- Verify:  pnpm --filter @rag/db verify        (promos checks, plan § 5 Phase 1)
