-- schema-free-guests.sql — the 45th file (D-147, plan/free-guests.md): a
-- tenant's children up to an age stay free, and every booking counts them
-- apart from the guests it charges for.
--
-- The rule is ONE number in the bookings config, free_up_to_age (the oldest
-- age that stays free; absent = nobody is free), set by a super user on the
-- platform form beside max stay and the horizon (D-078). A booking row gets
-- a SECOND count, free_guests, written at birth by every door. The price
-- does not change: unit_quote() is still called with guest_count, the
-- PAYING count, so the trigger, the quotes and the chatbot's tool agree as
-- extra-guests Rule 1 demands, and no age is ever stored (D-129: no more
-- guest detail than the stay needs). A free guest does not count toward a
-- unit's capacity (the user's choice, plan § 7 q1): the capacity test in
-- bookings_compute_during still reads guest_count alone, and is untouched.
--
-- Idempotent, and safe to re-run IN ORDER (trap 25). It REPLACES four
-- definitions from older files, each now GUARDED on this file's marker, the
-- column bookings.free_guests (trap 20):
--   * request_booking()              from schema-room-counts.sql (step 7)
--   * request_booking_with_consent() from schema-legal.sql
--   * guest_stay()                   from schema-stay-outcome.sql
--   * tenant_applications_validate() from schema-roles.sql
-- Re-run after this file, each skips its step instead of putting back a
-- body with no free count. The OLD request_booking signatures are dropped
-- here (as schema-promos.sql dropped the 10-parameter one), because with
-- both a call that omits p_free would match both.

begin;

-- 1. The column. Every existing row is 0: every stay to date was priced on
--    the one count, which is now the paying count. No backfill.
alter table public.bookings add column if not exists free_guests int not null default 0;
alter table public.bookings drop constraint if exists bookings_free_guests_range;
alter table public.bookings add  constraint bookings_free_guests_range check (free_guests between 0 and 50);

-- 2. The config check: free_up_to_age, when present, is a whole number of
--    years from 0 to 17. The rest of the body is schema-roles.sql's.
create or replace function public.tenant_applications_validate() returns trigger
language plpgsql
security definer
set search_path = ''
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

    -- Tenant management Phase 1 (plan/tenant-management.md § 2.4): the two
    -- limits request_booking() used to hold as constants. Whole numbers,
    -- 1–60 nights and 1–730 days; absent means 14 and 365.
    -- A case, not an or-chain: SQL does not promise short-circuit evaluation, and a
    -- cast of "3.5" would raise 22P02 before the check could say why.
    if new.config ? 'max_stay_nights' and (
         case when jsonb_typeof(new.config->'max_stay_nights') <> 'number' then true
              else (new.config->>'max_stay_nights')::numeric not between 1 and 60
                   or (new.config->>'max_stay_nights')::numeric <> floor((new.config->>'max_stay_nights')::numeric)
         end) then
      raise exception 'config.max_stay_nights is a whole number of nights from 1 to 60'
        using errcode = 'check_violation';
    end if;
    if new.config ? 'max_advance_days' and (
         case when jsonb_typeof(new.config->'max_advance_days') <> 'number' then true
              else (new.config->>'max_advance_days')::numeric not between 1 and 730
                   or (new.config->>'max_advance_days')::numeric <> floor((new.config->>'max_advance_days')::numeric)
         end) then
      raise exception 'config.max_advance_days is a whole number of days from 1 to 730'
        using errcode = 'check_violation';
    end if;

    -- D-147: the oldest age that stays free, a whole number from 0 to 17;
    -- absent means nobody is free. The same case shape as the two above.
    if new.config ? 'free_up_to_age' and (
         case when jsonb_typeof(new.config->'free_up_to_age') <> 'number' then true
              else (new.config->>'free_up_to_age')::numeric not between 0 and 17
                   or (new.config->>'free_up_to_age')::numeric <> floor((new.config->>'free_up_to_age')::numeric)
         end) then
      raise exception 'config.free_up_to_age is a whole number of years from 0 to 17'
        using errcode = 'check_violation';
    end if;

    if tg_op = 'UPDATE' then
      v_old_type := coalesce(old.config->>'booking_type', 'whole_resort');
      if v_type <> v_old_type then
        select count(*) into v_live from public.bookings
         where tenant_id = new.tenant_id and status <> 'cancelled' and upper(during) > now();
        if v_live > 0 then
          raise exception 'Tenant % has % live booking(s) that have not ended; its booking type cannot change', new.tenant_id, v_live
            using errcode = 'check_violation';
        end if;
        if v_type = 'whole_resort' then
          select count(*) into v_active from public.units where tenant_id = new.tenant_id and active;
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

-- 3. request_booking(), from schema-room-counts.sql, with p_free: one count
--    per unit (null = every unit 0), written into free_guests, returned as
--    free. The 11-parameter function is dropped first (see the head).
drop function if exists public.request_booking(bigint, bigint, bigint[], int[], date, int, text, text, text, text, text);
create or replace function public.request_booking (
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
  p_promo_code text default null,
  p_free       int[]  default null
)
returns table (
  reference         text,
  booked_date       date,
  unit              text,
  slot              text,
  starts_at         timestamptz,
  ends_at           timestamptz,
  guests            int,
  free              int,
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
  v_short    text;
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
  -- Free guests (D-147): one count per unit, 0 to 50 each; null means none.
  -- The price never reads it: unit_quote() below is called with p_guests,
  -- the PAYING count, exactly as before.
  if p_free is not null and (
       cardinality(p_free) <> v_units
       or array_position(p_free, null) is not null
       or exists (select 1 from unnest(p_free) f where f < 0 or f > 50)) then
    raise exception 'Free guests are a count from 0 to 50 for each unit' using errcode = 'invalid_parameter_value';
  end if;
  -- D-133: a unit of another tenant (or none) is refused by name here, as the
  -- insert's composite FK refused it before: the room counts below would
  -- otherwise call it "no longer available".
  if exists (select 1 from unnest(p_unit_ids) as w(unit_id)
             where not exists (select 1 from public.units un where un.tenant_id = p_tenant_id and un.id = w.unit_id)) then
    raise exception 'No such room' using errcode = 'foreign_key_violation';
  end if;
  -- D-133: a type named twice is two rooms of it; never more than it has.
  select format('%s has %s room%s; %s were asked for', un.name, x.rooms, case when x.rooms = 1 then '' else 's' end, x.wanted)
    into v_short
  from (select w.unit_id, count(*) as wanted,
               (select count(*) from public.unit_rooms r
                where r.tenant_id = p_tenant_id and r.unit_id = w.unit_id and r.active) as rooms
        from unnest(p_unit_ids) as w(unit_id)
        group by w.unit_id) x
  join public.units un on un.tenant_id = p_tenant_id and un.id = x.unit_id
  where x.wanted > x.rooms
  order by un.sort_order, un.name
  limit 1;
  if v_short is not null then
    raise exception '%', v_short using errcode = 'invalid_parameter_value';
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

  -- D-133: each night, every type needs as many free rooms as this request
  -- names it; a room is free when no taking row overlaps it.
  if exists (
    select 1
    from (select w.unit_id, count(*) as wanted from unnest(p_unit_ids) as w(unit_id) group by w.unit_id) x
    cross join generate_series(0, p_nights - 1) as n
    where (select count(*) from public.unit_rooms r
           where r.tenant_id = p_tenant_id and r.unit_id = x.unit_id and r.active
             and not exists (
               select 1 from public.bookings b
               where b.tenant_id = p_tenant_id and b.room_id = r.id
                 and public.booking_takes(b.status, b.held, b.held_until)
                 and b.during && public.slot_range(p_check_in + n, v_start, v_duration, v_timezone))) < x.wanted
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
     guest_name, guest_phone, guest_email, guest_count, free_guests, notes, group_id, reference, promo_id)
  select p_tenant_id, u.unit_id, p_slot_id, p_check_in + n, 'pending', 'web',
         v_name, v_phone, v_email, u.guests, coalesce(u.free, 0), v_notes, v_group, v_ref, v_promo.id
  from unnest(p_unit_ids, p_guests, coalesce(p_free, array_fill(0, array[v_units]))) with ordinality as u(unit_id, guests, free, ord)
  cross join generate_series(0, p_nights - 1) as n
  order by n, u.ord;

  if exists (select 1 from public.bookings b
              where b.tenant_id = p_tenant_id and b.group_id = v_group and b.price is null) then
    raise exception 'This slot has no price yet' using errcode = 'invalid_parameter_value';
  end if;

  return query
    select b.reference, b.booked_date, un.name, s.name, lower(b.during), upper(b.during),
           b.guest_count, b.free_guests, b.base_price, b.extra_guest_price, b.surcharge, b.discount, b.price
    from public.bookings b
    join public.units un on un.tenant_id = b.tenant_id and un.id = b.unit_id
    join public.slots s  on s.tenant_id  = b.tenant_id and s.id  = b.slot_id
    where b.tenant_id = p_tenant_id and b.group_id = v_group
    order by b.booked_date, un.sort_order, un.name;
end;
$$;
revoke all on function public.request_booking(bigint, bigint, bigint[], int[], date, int, text, text, text, text, text, int[]) from public, anon, authenticated;
grant execute on function public.request_booking(bigint, bigint, bigint[], int[], date, int, text, text, text, text, text, int[]) to authenticated, service_role;

-- 4. The consent wrapper (D-129), with p_free passed through. Its own
--    12-parameter signature is dropped first, for the same reason.
drop function if exists public.request_booking_with_consent(bigint, bigint, bigint[], int[], date, int, text, text, text, text, text, text);
create or replace function public.request_booking_with_consent (
  p_tenant_id       bigint,
  p_slot_id         bigint,
  p_unit_ids        bigint[],
  p_guests          int[],
  p_check_in        date,
  p_nights          int,
  p_name            text,
  p_phone           text,
  p_email           text,
  p_notes           text,
  p_promo_code      text,
  p_consent_version text,
  p_free            int[] default null
)
returns table (
  reference         text,
  booked_date       date,
  unit              text,
  slot              text,
  starts_at         timestamptz,
  ends_at           timestamptz,
  guests            int,
  free              int,
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
  v_current text;
begin
  if coalesce(auth.jwt() ->> 'role', '') <> 'service_role' and p_tenant_id is distinct from public.app_tenant_id() then
    raise exception 'This request is not for this workspace.' using errcode = 'insufficient_privilege';
  end if;
  select t.policy_version into v_current from public.tenants t where t.id = p_tenant_id;
  if p_consent_version is null or p_consent_version is distinct from v_current then
    raise exception 'Please read and agree to the current Privacy Policy and Terms.' using errcode = 'check_violation';
  end if;
  perform set_config('app.consent_version', p_consent_version, true);
  return query
    select * from public.request_booking(p_tenant_id, p_slot_id, p_unit_ids, p_guests, p_check_in, p_nights,
                                         p_name, p_phone, p_email, p_notes, p_promo_code, p_free);
end;
$$;
revoke all on function public.request_booking_with_consent(bigint, bigint, bigint[], int[], date, int, text, text, text, text, text, text, int[]) from public, anon;
grant execute on function public.request_booking_with_consent(bigint, bigint, bigint[], int[], date, int, text, text, text, text, text, text, int[]) to authenticated, service_role;

-- 5. guest_stay(): each room line carries 'free' too, so the guest sees
--    their own party on Manage booking. The rest is schema-stay-outcome.sql's.
create or replace function public.guest_stay(p_tenant_id bigint, p_reference text, p_contact text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_group   uuid;
  v_status  text;
  v_config  jsonb;
  v_out     jsonb;
begin
  if coalesce(auth.jwt() ->> 'role', '') <> 'service_role'
     and p_tenant_id is distinct from public.app_tenant_id() then
    raise exception 'guest_stay: tenant % is not the token''s tenant', p_tenant_id
      using errcode = 'insufficient_privilege';
  end if;

  v_group := public.guest_group(p_tenant_id, p_reference, p_contact);
  if v_group is null then
    return null;
  end if;
  v_status := public.stay_status(p_tenant_id, v_group);
  select a.config into v_config from public.tenant_applications a
  where a.tenant_id = p_tenant_id and a.application_key = 'bookings';

  select jsonb_build_object(
    'reference',   min(s.reference),
    -- 'expired' the moment it is due, before any sweep writes it (§ 2.5).
    'status',      case when public.stay_is_due(p_tenant_id, v_group) then 'expired' else v_status end,
    -- schema-stay-outcome.sql: why a stay ended, in the staff's words (a
    -- decline's or cancel's note, "Not paid in time"); null while it is live.
    'decision_note', case when public.stay_is_due(p_tenant_id, v_group) then 'Not paid in time'
                          when v_status in ('cancelled', 'expired') then max(b.decision_note) end,
    -- cancelled before it was ever confirmed: the guest reads "Declined".
    'declined',    v_status = 'cancelled' and not exists (
                     select 1 from public.booking_events e
                     where e.tenant_id = p_tenant_id and e.group_id = v_group and e.to_value = 'confirmed'),
    -- a pending stay whose dates another stay has taken since (stay_taken()):
    -- it can no longer be confirmed, so it takes no payment. Null otherwise.
    'taken',       case when v_status = 'pending' and not public.stay_is_due(p_tenant_id, v_group)
                        then public.stay_taken(p_tenant_id, v_group) end,
    'pay_by',      min(s.pay_by),
    'review_by',   min(s.review_by),
    -- schema-holds.sql's columns: when the stay's live hold lapses, or null.
    'held_until',  max(b.held_until) filter (where b.held and b.held_until > now()),
    'source',      min(b.source),
    'guest_name',  min(b.guest_name),
    'check_in',    min(b.booked_date),
    'starts_at',   min(lower(b.during)),
    'ends_at',     max(upper(b.during)),
    'ended',       max(upper(b.during)) < now(),
    'nights',      count(distinct b.booked_date),
    'created_at',  min(b.created_at),
    'price',       jsonb_build_object(
                     'base',         sum(b.base_price),
                     'extra_guests', sum(b.extra_guest_price),
                     'surcharge',    sum(b.surcharge),
                     'discount',     sum(b.discount),
                     'total',        sum(b.price)),
    'rooms',       (select jsonb_agg(r order by r ->> 'unit', r ->> 'slot')
                    from (select distinct jsonb_build_object('unit', u.name, 'slot', sl.name, 'guests', b2.guest_count, 'free', b2.free_guests) as r
                          from public.bookings b2
                          join public.units u on u.tenant_id = b2.tenant_id and u.id = b2.unit_id
                          join public.slots sl on sl.tenant_id = b2.tenant_id and sl.id = b2.slot_id
                          where b2.tenant_id = p_tenant_id and b2.group_id = v_group and b2.status = v_status) x),
    'timezone',    v_config ->> 'timezone',
    'currency',    coalesce(v_config ->> 'currency', 'PHP'),
    'payment',     public.stay_payment(p_tenant_id, v_group),
    'payments',    coalesce((select jsonb_agg(jsonb_build_object(
                                'kind', p.kind, 'method', p.method, 'claimed_amount', p.claimed_amount,
                                'verified_amount', p.verified_amount, 'paid_on', p.paid_on, 'status', p.status,
                                'rejection_reason', p.rejection_reason, 'created_at', p.created_at)
                              order by p.created_at, p.id)
                             from public.payments p where p.tenant_id = p_tenant_id and p.group_id = v_group), '[]'::jsonb),
    'pay',         case when v_config ? 'payments' then jsonb_build_object(
                     'methods', v_config->'payments'->'methods',
                     'terms',   v_config->'payments'->'terms') end,
    -- Phase 6: what a change would mean today, and the request in flight.
    'change',      public.change_terms(p_tenant_id, v_group),
    'changes',     coalesce((select jsonb_agg(jsonb_build_object(
                                'kind', c.kind, 'status', c.status, 'new_check_in', c.new_check_in,
                                'quoted_difference', c.quoted_difference, 'refund_due', c.refund_due,
                                'decision_note', case when c.status = 'rejected' then c.decision_note end,
                                'created_at', c.created_at)
                              order by c.created_at, c.id)
                             from public.change_requests c where c.tenant_id = p_tenant_id and c.group_id = v_group), '[]'::jsonb)
  ) into v_out
  from public.bookings b
  join public.stays s on s.tenant_id = b.tenant_id and s.group_id = b.group_id
  where b.tenant_id = p_tenant_id and b.group_id = v_group and b.status = v_status;

  return v_out;
end;
$$;

commit;

-- PostgREST caches the schema: without this the new column and the new
-- signatures stay invisible to .from() and .rpc().
notify pgrst, 'reload schema';
