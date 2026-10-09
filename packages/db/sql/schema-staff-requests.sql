-- schema-staff-requests.sql — every stay is a group with ONE reference,
-- whoever made it (plan/staff-requests.md, D-100).
--
-- Run AFTER schema-taken-span.sql. The 21st file. Re-runnable: every step
-- creates or replaces, the backfill touches only rows still missing a
-- value, and the one definition it REPLACES (request_booking, from
-- schema-promos.sql) is guarded there on this file's marker,
-- booking_reference(), so re-running the promos file cannot put the inline
-- copy back (CLAUDE.md trap 20).
--
-- Before this file a reference existed for web requests only, made inside
-- request_booking(); a staff booking had none, and a single staff booking
-- had no group_id either, so the Requests section (which lists groups)
-- could not show it. After it:
--   * booking_reference(p_tenant_id) is the ONE place the shape is written
--     (plan Rule 1): three letters of the slug, six from a 30-letter
--     alphabet, retried while a row of that tenant has the result;
--   * a BEFORE INSERT trigger gives a row a group_id of its own when the
--     insert names none, and the group's reference when a row of the same
--     statement already has one, else a new one (plan Rule 2, § 2.1);
--   * request_booking() calls booking_reference() instead of its loop;
--   * every existing row is backfilled, counted.
-- Nothing about holding changes: D-070, D-095 and D-099 stand.

-- 1. The ONE reference maker. SECURITY DEFINER (the twelfth, D-042's shape):
--    `tenants` has no policy for a token, so the slug can only be read by a
--    definer, and it is read only after the caller is checked. A direct
--    database session (the SQL editor, psql: session_user 'postgres') is allowed too,
--    because that is where the backfill below runs, and such a session is
--    already the master key. random() is fine: a reference grants nothing
--    (customer-booking plan § 3).
create or replace function booking_reference(p_tenant_id bigint)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  c_alphabet constant text := 'ABCDEFGHJKMNPQRSTUVWXYZ2345679';   -- no 0 O 1 I L 8
  v_slug text;
  v_ref  text;
begin
  -- session_user is the LOGIN role: 'authenticator' behind PostgREST (then
  -- SET ROLE to anon/authenticated/service_role), 'postgres' in the SQL editor
  -- or psql. A definer's current_user is its owner, so it cannot be used here.
  if session_user <> 'postgres'
     and coalesce(auth.jwt() ->> 'role', '') <> 'service_role'
     and p_tenant_id is distinct from public.app_tenant_id() then
    raise exception 'booking_reference: tenant % is not the token''s tenant', p_tenant_id
      using errcode = 'insufficient_privilege';
  end if;
  select t.slug into v_slug from public.tenants t where t.id = p_tenant_id;
  if v_slug is null then
    raise exception 'booking_reference: no tenant %', p_tenant_id using errcode = 'invalid_parameter_value';
  end if;
  loop
    v_ref := upper(left(regexp_replace(v_slug, '[^a-zA-Z]', '', 'g') || 'XXX', 3)) || '-' ||
             (select string_agg(substr(c_alphabet, 1 + floor(random() * 30)::int, 1), '')
                from generate_series(1, 6));
    exit when not exists (select 1 from public.bookings b where b.tenant_id = p_tenant_id and b.reference = v_ref);
  end loop;
  return v_ref;
end;
$$;

-- 2. The fill trigger. BEFORE INSERT, for each row, as the CALLER (every
--    door that inserts can read its tenant's bookings; request_booking()
--    runs as its definer). A row of the same statement that already set
--    the group's reference IS visible here (Postgres: a row-level BEFORE
--    trigger sees the rows previously processed by the same command), so a
--    several-rooms staff booking gets ONE reference (plan § 2.1). Named to
--    sort first among the bookings triggers, so the later ones see the
--    filled columns.
create or replace function bookings_fill_group_and_reference() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.group_id := coalesce(new.group_id, gen_random_uuid());
  if new.reference is null then
    select b.reference into new.reference
    from public.bookings b
    where b.tenant_id = new.tenant_id and b.group_id = new.group_id and b.reference is not null
    limit 1;
  end if;
  new.reference := coalesce(new.reference, public.booking_reference(new.tenant_id));
  return new;
end;
$$;
drop trigger if exists bookings_aa_fill_group_and_reference on bookings;
create trigger bookings_aa_fill_group_and_reference
  before insert on bookings
  for each row execute function bookings_fill_group_and_reference();

-- 3. request_booking(): schema-promos.sql's body, with the inline reference
--    loop replaced by booking_reference(). Everything else is byte-for-byte
--    the same: the lock, the limits, the promo, the one insert in date order.
-- GUARDED (manage-booking Phase 5, 2026-10-10): schema-holds.sql replaces
-- this with one that asks booking_takes() (a live hold takes a slot too).
-- Once that file has run, re-running THIS file must not put the
-- confirmed-only version back, so the step is skipped (trap 20).
do $guard$
begin
  if to_regprocedure('public.booking_takes(text, boolean, timestamptz)') is null then
    execute $ddl$
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
$$
$ddl$;
  end if;
end
$guard$;


-- 4. The backfill, counted. Rows with no group are single bookings: each
--    gets its own. Then one reference per (tenant, group) still without one.
--    Printed before and after; after must be 0 / 0.
do $backfill$
declare
  v_no_group int;
  v_no_ref   int;
  v_group    record;
  v_ref      text;
begin
  select count(*) filter (where group_id is null), count(*) filter (where reference is null)
    into v_no_group, v_no_ref from public.bookings;
  raise notice 'backfill before: % rows without a group, % without a reference', v_no_group, v_no_ref;

  update public.bookings set group_id = gen_random_uuid() where group_id is null;

  -- ONE call per group, into a variable, THEN the update. The first version
  -- put the call in the UPDATE's SET, and a volatile function in SET is
  -- evaluated once per ROW: harbor's 2-room staff booking (#926, #927) got
  -- two references (found by the Phase 2 HTTP smoke; repaired in step 4b).
  for v_group in
    select distinct b.tenant_id, b.group_id from public.bookings b where b.reference is null
  loop
    v_ref := public.booking_reference(v_group.tenant_id);
    update public.bookings b
       set reference = v_ref
     where b.tenant_id = v_group.tenant_id and b.group_id = v_group.group_id and b.reference is null;
  end loop;

  select count(*) filter (where group_id is null), count(*) filter (where reference is null)
    into v_no_group, v_no_ref from public.bookings;
  raise notice 'backfill after: % rows without a group, % without a reference', v_no_group, v_no_ref;
end
$backfill$;

-- 4b. The repair for the first run's defect, idempotent: a group whose rows
--     carry more than one reference keeps the one on its lowest id, and the
--     count of such groups is printed before (must be 0 after).
do $repair$
declare
  v_split int;
  v_group record;
  v_keep  text;
begin
  select count(*) into v_split from (
    select b.tenant_id, b.group_id from public.bookings b
    group by b.tenant_id, b.group_id having count(distinct b.reference) > 1
  ) s;
  raise notice 'repair: % group(s) with more than one reference', v_split;
  for v_group in
    select b.tenant_id, b.group_id from public.bookings b
    group by b.tenant_id, b.group_id having count(distinct b.reference) > 1
  loop
    select b.reference into v_keep from public.bookings b
     where b.tenant_id = v_group.tenant_id and b.group_id = v_group.group_id order by b.id limit 1;
    update public.bookings b set reference = v_keep
     where b.tenant_id = v_group.tenant_id and b.group_id = v_group.group_id and b.reference is distinct from v_keep;
  end loop;
end
$repair$;

-- 5. EXECUTE grants: revoke from all three, grant back exactly who needs it.
--    booking_reference is called by the trigger as the caller (a staff
--    token, authenticated) and by request_booking (a definer), never from
--    the browser on its own: it checks its tenant either way.
revoke all on function booking_reference(bigint) from public, anon, authenticated;
grant execute on function booking_reference(bigint) to authenticated, service_role;
revoke all on function request_booking(bigint, bigint, bigint[], int[], date, int, text, text, text, text, text) from public, anon, authenticated;
grant execute on function request_booking(bigint, bigint, bigint[], int[], date, int, text, text, text, text, text) to authenticated, service_role;

notify pgrst, 'reload schema';

-- Verify:  pnpm --filter @rag/bookings rooms        (plan § 5 Phase 1's checks)
--   and the two NOTICE lines above: "backfill after: 0 rows without a group, 0 without a reference".
