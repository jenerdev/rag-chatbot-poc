-- schema-manage-booking.sql — the guest's Manage booking page and what
-- stands behind it (plan/manage-booking.md).
--
-- Run AFTER schema-calendar.sql. The 23rd file. Idempotent. Phase 1:
-- stays, the `expired` status, booking_events, the guest's one read
-- (sections 1–11). Phase 3: payment settings, the required amount, payments,
-- stay_payment(), the proof bucket and submit_payment() (12–18), and
-- guest_stay() redefined IN PLACE with the stay's payment (16). Phase 4:
-- review_payment(), record_refund(), set_payment_settings() and the
-- confirm-needs-a-note rule (19–23). Phase 5: the deadlines (pay_by,
-- review_by, stay_is_due(), expire_due_stays(), 19a–19b; the hold itself is
-- schema-holds.sql). Phase 6: change requests, change_terms(),
-- request_change(), withdraw_change(), decide_change() (24–28). NO existing function is
-- replaced: everything below is added beside what is there, so re-running
-- an older file cannot undo it (trap 20).
--
--   stays                 one row per stay (a bookings group, D-100): the
--                         reference, and later its payment terms (plan § 2.1)
--   bookings.status       gains 'expired' (plan § 2.5; nothing writes it yet)
--   booking_events        every creation and every status change, written by
--                         a trigger, readable by staff, writable by nobody
--                         (plan Rule 2)
--   guest_lookup_failures the misses per reference, for the lockout (§ 2.2)
--   guest_stay()          the guest's ONE read: reference + email or phone →
--                         this stay's guest-facing columns, or null (Rule 4)
--
-- Nothing about holding changes: D-070, D-095, D-099 and D-100 stand.

-- 1. stays. One row per (tenant, group). The reference is the group's, so
--    it is unique per tenant here, which is also the index guest_stay()
--    finds a stay by. Payment terms join it in Phase 3.
create table if not exists stays (
  tenant_id   bigint      not null references tenants(id) on delete cascade,
  group_id    uuid        not null,
  reference   text        not null,
  created_at  timestamptz not null default now(),
  primary key (tenant_id, group_id),
  constraint stays_reference_unique unique (tenant_id, reference)
);

alter table stays enable row level security;
drop policy if exists stays_read on stays;
-- Staff of the tenant read. Nobody writes through a policy: the row is made
-- by the trigger below (definer) and removed by the delete trigger.
create policy stays_read on stays for select to authenticated
  using (tenant_id = (select public.app_tenant_id()) and (select public.app_is_staff()));

-- 2. The stay row is made with the stay's first booking. BEFORE INSERT,
--    named to run right after bookings_aa_fill_group_and_reference (name
--    order), so group_id and reference are already filled. SECURITY DEFINER
--    (D-042's shape) so that no token needs an insert policy on `stays`; it
--    writes only the row's own tenant, group and reference, and if the
--    booking itself is then refused (RLS, a constraint), the statement rolls
--    back and this row with it.
create or replace function bookings_ensure_stay() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.stays (tenant_id, group_id, reference)
  values (new.tenant_id, new.group_id, new.reference)
  on conflict (tenant_id, group_id) do nothing;
  return new;
end;
$$;
drop trigger if exists bookings_ab_ensure_stay on bookings;
create trigger bookings_ab_ensure_stay
  before insert on bookings
  for each row execute function bookings_ensure_stay();

-- 3. A stay whose last booking is hard-deleted goes too (the tools' fixtures
--    are seeded and deleted on every run). Without this, the orphan keeps
--    its reference, and a later booking_reference() that draws it would
--    fail stays_reference_unique. Tokens have no delete policy on bookings,
--    so this runs for service_role and the SQL editor only.
create or replace function bookings_drop_empty_stays() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  delete from public.stays s
  using (select distinct o.tenant_id, o.group_id from gone o) g
  where s.tenant_id = g.tenant_id and s.group_id = g.group_id
    and not exists (select 1 from public.bookings b where b.tenant_id = g.tenant_id and b.group_id = g.group_id);
  return null;
end;
$$;
drop trigger if exists bookings_drop_empty_stays on bookings;
create trigger bookings_drop_empty_stays
  after delete on bookings
  referencing old table as gone
  for each statement execute function bookings_drop_empty_stays();

-- 4. Backfill, counted. Every group already has one reference (D-100's
--    repair); if any has two, or a row lacks either, stop rather than guess.
do $backfill$
declare
  v_split   int;
  v_missing int;
  v_before  int;
  v_after   int;
  v_groups  int;
begin
  select count(*) into v_missing from public.bookings where group_id is null or reference is null;
  select count(*) into v_split from (
    select 1 from public.bookings group by tenant_id, group_id having count(distinct reference) > 1
  ) x;
  if v_missing > 0 or v_split > 0 then
    raise exception 'stays backfill: % rows without group or reference, % groups with two references', v_missing, v_split;
  end if;
  select count(*) into v_before from public.stays;
  insert into public.stays (tenant_id, group_id, reference, created_at)
  select b.tenant_id, b.group_id, min(b.reference), min(b.created_at)
  from public.bookings b
  group by b.tenant_id, b.group_id
  on conflict (tenant_id, group_id) do nothing;
  select count(*) into v_after from public.stays;
  select count(*) into v_groups from (select distinct tenant_id, group_id from public.bookings) g;
  raise notice 'stays backfill: % before, % after, % groups in bookings', v_before, v_after, v_groups;
end;
$backfill$;

-- 5. Every booking belongs to a stay. After the backfill this cannot fail.
alter table bookings drop constraint if exists bookings_stay_fk;
alter table bookings add constraint bookings_stay_fk
  foreign key (tenant_id, group_id) references stays (tenant_id, group_id);

-- 6. 'expired': pending, past its payment deadline, nothing verified (plan
--    § 2.5). Nothing writes it until Phase 5; the guest page and the screens
--    must already know the word. Re-created, looser, so it cannot fail.
alter table bookings drop constraint if exists bookings_status;
alter table bookings add constraint bookings_status
  check (status in ('pending', 'confirmed', 'cancelled', 'expired'));

-- 7. booking_events. Append-only: staff read, no token writes, no update or
--    delete policy for anyone. Written by the triggers below, which are
--    SECURITY DEFINER for that reason alone. Phases 3, 4 and 6 add kinds.
create table if not exists booking_events (
  id          bigint      generated always as identity primary key,
  tenant_id   bigint      not null,
  group_id    uuid        not null,
  at          timestamptz not null default now(),
  actor_kind  text        not null,
  actor_user  uuid,
  kind        text        not null,
  from_value  text,
  to_value    text,
  row_count   int,
  note        text,
  constraint booking_events_stay_fk foreign key (tenant_id, group_id)
    references stays (tenant_id, group_id) on delete cascade,
  constraint booking_events_actor check (actor_kind in ('guest', 'staff', 'system')),
  constraint booking_events_kind check (kind in ('created', 'status'))
);
create index if not exists booking_events_stay_idx on booking_events (tenant_id, group_id, at);

alter table booking_events enable row level security;
drop policy if exists booking_events_read on booking_events;
create policy booking_events_read on booking_events for select to authenticated
  using (tenant_id = (select public.app_tenant_id()) and (select public.app_is_staff()));

-- Who did it, from the request's own claims. A staff token carries `sub`; a
-- chat token is `authenticated` with none (a guest, through a definer such
-- as request_booking()); service_role and a direct session are the system.
-- A definer that acts for someone else names it with set_config('app.actor').
create or replace function app_actor() returns text
language sql
stable
set search_path = ''
as $$
  select case
    when coalesce(current_setting('app.actor', true), '') in ('guest', 'staff', 'system') then current_setting('app.actor', true)
    when auth.uid() is not null then 'staff'
    when coalesce(auth.jwt() ->> 'role', '') = 'authenticated' then 'guest'
    else 'system'
  end
$$;

-- 8. The two event triggers: statement-level with transition tables, so a
--    three-night group confirmed in one statement is ONE event (row_count = 3),
--    not three. (A transition table cannot sit on an UPDATE OF column
--    trigger, so the update one compares the statuses itself.)
create or replace function bookings_log_created() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.booking_events (tenant_id, group_id, actor_kind, actor_user, kind, to_value, row_count, note)
  select n.tenant_id, n.group_id, public.app_actor(), auth.uid(), 'created', n.status, count(*), min(n.source)
  from born n
  group by n.tenant_id, n.group_id, n.status;
  return null;
end;
$$;
drop trigger if exists bookings_log_created on bookings;
create trigger bookings_log_created
  after insert on bookings
  referencing new table as born
  for each statement execute function bookings_log_created();

create or replace function bookings_log_status() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.booking_events (tenant_id, group_id, actor_kind, actor_user, kind, from_value, to_value, row_count, note)
  select n.tenant_id, n.group_id, public.app_actor(), auth.uid(), 'status', o.status, n.status, count(*), max(n.decision_note)
  from after_rows n
  join before_rows o on o.id = n.id
  where o.status is distinct from n.status
  group by n.tenant_id, n.group_id, o.status, n.status;
  return null;
end;
$$;
drop trigger if exists bookings_log_status on bookings;
create trigger bookings_log_status
  after update on bookings
  referencing old table as before_rows new table as after_rows
  for each statement execute function bookings_log_status();

-- Trigger functions are not callable through PostgREST, but say so anyway.
revoke all on function bookings_ensure_stay()    from public, anon, authenticated;
revoke all on function bookings_log_created()    from public, anon, authenticated;
revoke all on function bookings_log_status()     from public, anon, authenticated;
revoke all on function bookings_drop_empty_stays() from public, anon, authenticated;

-- 9. The lockout's memory. No policy for any token: only guest_stay()
--    (definer) reads and writes it.
create table if not exists guest_lookup_failures (
  id         bigint      generated always as identity primary key,
  tenant_id  bigint      not null references tenants(id) on delete cascade,
  reference  text        not null,
  at         timestamptz not null default now()
);
create index if not exists guest_lookup_failures_ref_idx on guest_lookup_failures (tenant_id, reference, at);
alter table guest_lookup_failures enable row level security;

-- 10. A phone as a key: request_booking()'s normalisation (spaces, dots,
--     dashes and brackets out; +63 → 0), so a staff row typed "0917 845
--     2290" matches a guest typing "+639178452290".
create or replace function phone_key(p_phone text) returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when v like '+63%' then '0' || substr(v, 4)
    else v
  end
  from (select regexp_replace(coalesce(p_phone, ''), '[\s().-]', '', 'g') as v) x
$$;

-- 11. The guest's match, ONE function for every guest door (plan § 2.3):
--     guest_stay() reads with it and submit_payment() writes with it, so the
--     two can never disagree about who a guest is. It returns the stay's
--     group, or null for every kind of miss, and it counts the misses: after
--     5 in an hour a reference answers null even to the right contact, for
--     the rest of that hour (§ 2.2). Not callable through the API: only the
--     definers below call it, and they have checked the token's tenant.
create or replace function guest_group(p_tenant_id bigint, p_reference text, p_contact text)
returns uuid
language plpgsql
volatile
set search_path = ''
as $$
declare
  c_max_misses constant int := 5;
  c_window     constant interval := interval '1 hour';
  v_ref     text := upper(regexp_replace(coalesce(p_reference, ''), '\s', '', 'g'));
  v_contact text := btrim(coalesce(p_contact, ''));
  v_email   text;
  v_phone   text;
  v_group   uuid;
begin
  -- Nothing that cannot be a reference or a contact is looked up or counted.
  if v_ref !~ '^[A-Z]{3}-[A-Z0-9]{6}$' or char_length(v_contact) not between 5 and 254 then
    return null;
  end if;
  if position('@' in v_contact) > 0 then
    v_email := lower(v_contact);
  else
    v_phone := public.phone_key(v_contact);
    if v_phone !~ '^09[0-9]{9}$' then
      return null;
    end if;
  end if;

  if (select count(*) from public.guest_lookup_failures f
      where f.tenant_id = p_tenant_id and f.reference = v_ref and f.at > now() - c_window) >= c_max_misses then
    return null;
  end if;

  select s.group_id into v_group
  from public.stays s
  where s.tenant_id = p_tenant_id and s.reference = v_ref
    and exists (
      select 1 from public.bookings b
      where b.tenant_id = s.tenant_id and b.group_id = s.group_id
        and ((v_email is not null and lower(btrim(b.guest_email)) = v_email)
          or (v_phone is not null and public.phone_key(b.guest_phone) = v_phone))
    );

  if v_group is null then
    delete from public.guest_lookup_failures f
    where f.tenant_id = p_tenant_id and f.reference = v_ref and f.at < now() - interval '1 day';
    insert into public.guest_lookup_failures (tenant_id, reference) values (p_tenant_id, v_ref);
  end if;
  return v_group;
end;
$$;
revoke all on function guest_group(bigint, text, text) from public, anon, authenticated;

-- The stay's status: confirmed if any row is, else pending, else expired,
-- else cancelled. Its "live" rows are the ones in that status (a reschedule,
-- in Phase 6, leaves cancelled rows beside the live ones). ONE place, read by
-- guest_stay() and stay_payment().
create or replace function stay_status(p_tenant_id bigint, p_group_id uuid)
returns text
language sql
stable
set search_path = ''
as $$
  select b.status from public.bookings b
  where b.tenant_id = p_tenant_id and b.group_id = p_group_id
  order by array_position(array['confirmed', 'pending', 'expired', 'cancelled'], b.status)
  limit 1
$$;

-- 12. Payment settings, in the bookings application's config (plan § 3):
--
--       "payments": {
--         "methods": [{ "kind": "gcash"|"bank"|"other", "label": "GCash",
--                       "account_name": "...", "account_number": "...",
--                       "instructions": "..." }],                       1–5, labels unique
--         "fee": { "kind": "full" } | { "kind": "fixed", "value": 200000 }
--              | { "kind": "percent", "value": 3000 },   centavos / hundredths of a percent
--         "pay_within_hours": 24, "review_within_hours": 24,          1–168 (Phase 5 reads them)
--         "terms": "...",                                               ≤ 4000, shown to guests
--         "hold": "none" | "on_proof" | "on_request",                   Phase 5; absent = none
--         "cancellation": [{ "days_before": 7, "refund_percent": 100 }],  Phase 6; absent = no refund
--         "reschedule_until_days_before": 3                             Phase 6; absent = no rescheduling
--       }
--
--     No "payments" key = the tenant takes no payment through the page. A
--     SEPARATE trigger, as booking_page's is, so no older validator is
--     redefined (trap 20). Plain text everywhere: shown as text, never HTML.
--     Any token of the tenant reads it (guests are shown the account to pay).
create or replace function tenant_applications_payments() returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_pay  jsonb;
  v_fee  jsonb;
  v_m    jsonb;
  v_key  text;
begin
  if new.application_key <> 'bookings' or not (new.config ? 'payments') then
    return new;
  end if;
  v_pay := new.config->'payments';
  if jsonb_typeof(v_pay) <> 'object' then
    raise exception 'config.payments is an object' using errcode = 'check_violation';
  end if;
  for v_key in select jsonb_object_keys(v_pay) loop
    if v_key not in ('methods', 'fee', 'pay_within_hours', 'review_within_hours', 'terms', 'hold', 'cancellation', 'reschedule_until_days_before') then
      raise exception 'config.payments has no key "%"', v_key using errcode = 'check_violation';
    end if;
  end loop;

  if jsonb_typeof(v_pay->'methods') is distinct from 'array'
     or jsonb_array_length(v_pay->'methods') not between 1 and 5 then
    raise exception 'config.payments.methods is a list of 1 to 5 ways to pay' using errcode = 'check_violation';
  end if;
  for v_m in select * from jsonb_array_elements(v_pay->'methods') loop
    if jsonb_typeof(v_m) <> 'object'
       or exists (select 1 from jsonb_object_keys(v_m) k where k not in ('kind', 'label', 'account_name', 'account_number', 'instructions'))
       or coalesce(v_m->>'kind', '') not in ('gcash', 'bank', 'other')
       or jsonb_typeof(v_m->'label') is distinct from 'string' or char_length(btrim(v_m->>'label')) not between 1 and 40
       or (v_m ? 'account_name' and (jsonb_typeof(v_m->'account_name') <> 'string' or char_length(v_m->>'account_name') > 100))
       or (v_m ? 'account_number' and (jsonb_typeof(v_m->'account_number') <> 'string' or char_length(v_m->>'account_number') > 60))
       or (v_m ? 'instructions' and (jsonb_typeof(v_m->'instructions') <> 'string' or char_length(v_m->>'instructions') > 500)) then
      raise exception 'each payment method has a kind (gcash, bank or other), a label of 1–40 characters, and optionally account_name (≤ 100), account_number (≤ 60) and instructions (≤ 500)'
        using errcode = 'check_violation';
    end if;
  end loop;
  if (select count(distinct lower(btrim(m->>'label'))) from jsonb_array_elements(v_pay->'methods') m)
     <> jsonb_array_length(v_pay->'methods') then
    raise exception 'payment method labels must be different from each other' using errcode = 'check_violation';
  end if;

  v_fee := v_pay->'fee';
  if jsonb_typeof(v_fee) is distinct from 'object' or coalesce(v_fee->>'kind', '') not in ('full', 'fixed', 'percent') then
    raise exception 'config.payments.fee is {"kind":"full"}, {"kind":"fixed","value":centavos} or {"kind":"percent","value":hundredths of a percent}'
      using errcode = 'check_violation';
  end if;
  if v_fee->>'kind' <> 'full' and (
       case when jsonb_typeof(v_fee->'value') is distinct from 'number' then true
            else (v_fee->>'value')::numeric <> floor((v_fee->>'value')::numeric)
                 or (v_fee->>'value')::numeric < 1
                 or (v_fee->>'kind' = 'percent' and (v_fee->>'value')::numeric > 10000)
                 or (v_fee->>'value')::numeric > 10000000000
       end) then
    raise exception 'a fixed fee is a whole number of centavos from 1; a percent fee is 1 to 10000 hundredths of a percent'
      using errcode = 'check_violation';
  end if;

  foreach v_key in array array['pay_within_hours', 'review_within_hours'] loop
    if v_pay ? v_key and (
         case when jsonb_typeof(v_pay->v_key) <> 'number' then true
              else (v_pay->>v_key)::numeric not between 1 and 168
                   or (v_pay->>v_key)::numeric <> floor((v_pay->>v_key)::numeric)
         end) then
      raise exception 'config.payments.% is a whole number of hours from 1 to 168', v_key using errcode = 'check_violation';
    end if;
  end loop;
  if v_pay ? 'terms' and (jsonb_typeof(v_pay->'terms') <> 'string' or char_length(v_pay->>'terms') > 4000) then
    raise exception 'config.payments.terms is text of at most 4000 characters' using errcode = 'check_violation';
  end if;
  -- Phase 5 (plan § 2.4, § 9 q1): when a stay holds its dates. Absent = none.
  if v_pay ? 'hold' and coalesce(v_pay->>'hold', '') not in ('none', 'on_proof', 'on_request') then
    raise exception 'config.payments.hold is "none", "on_proof" or "on_request"' using errcode = 'check_violation';
  end if;
  -- Phase 6: the cancellation policy, tiers by days before check-in, and
  -- the reschedule cutoff. [{ "days_before": 7, "refund_percent": 100 },
  -- { "days_before": 2, "refund_percent": 50 }]: cancelling 7+ days ahead
  -- refunds all received, 2–6 days half, less than 2 nothing.
  if v_pay ? 'cancellation' and (
       jsonb_typeof(v_pay->'cancellation') <> 'array'
       or jsonb_array_length(v_pay->'cancellation') > 5
       or exists (select 1 from jsonb_array_elements(v_pay->'cancellation') t
                  where jsonb_typeof(t) <> 'object'
                     or jsonb_typeof(t->'days_before') is distinct from 'number'
                     or jsonb_typeof(t->'refund_percent') is distinct from 'number'
                     or (t->>'days_before')::numeric not between 0 and 365
                     or (t->>'days_before')::numeric <> floor((t->>'days_before')::numeric)
                     or (t->>'refund_percent')::numeric not between 0 and 100
                     or (t->>'refund_percent')::numeric <> floor((t->>'refund_percent')::numeric))) then
    raise exception 'config.payments.cancellation is up to 5 tiers of {"days_before": 0–365, "refund_percent": 0–100}, whole numbers'
      using errcode = 'check_violation';
  end if;
  if v_pay ? 'reschedule_until_days_before' and (
       case when jsonb_typeof(v_pay->'reschedule_until_days_before') <> 'number' then true
            else (v_pay->>'reschedule_until_days_before')::numeric not between 0 and 365
                 or (v_pay->>'reschedule_until_days_before')::numeric <> floor((v_pay->>'reschedule_until_days_before')::numeric)
       end) then
    raise exception 'config.payments.reschedule_until_days_before is a whole number of days from 0 to 365'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
drop trigger if exists tenant_applications_payments on tenant_applications;
create trigger tenant_applications_payments
  before insert or update on tenant_applications
  for each row execute function tenant_applications_payments();

-- 13. The amount a stay must have verified before it may be confirmed
--     (plan Rule 3, § 2.7 of payments.md). ONE function. A percentage rounds
--     UP to the centavo: rounding down would confirm on a centavo short. A
--     fixed fee larger than the stay is the stay.
create or replace function stay_required(p_total bigint, p_fee jsonb)
returns bigint
language sql
immutable
set search_path = ''
as $$
  select case
    when p_total is null or p_fee is null then null
    when p_fee->>'kind' = 'full' then p_total
    when p_fee->>'kind' = 'fixed' then least((p_fee->>'value')::bigint, p_total)
    when p_fee->>'kind' = 'percent' then (p_total * (p_fee->>'value')::bigint + 9999) / 10000
  end
$$;

-- Stored with the stay, so a settings change never moves a guest's goalposts.
-- Null = not tracked: a staff stay, a tenant with no payment settings, a row
-- with no price.
alter table stays add column if not exists required_amount bigint;
alter table stays drop constraint if exists stays_required_amount;
alter table stays add constraint stays_required_amount check (required_amount is null or required_amount >= 0);
-- Phase 5 (plan § 2.5): the deadlines. pay_by: a WEB stay with nothing
-- verified by then expires (unless a proof sent before it is still being
-- checked). review_by: set when a proof arrives, the time staff have to
-- decide it. Null = no deadline (every older stay, every staff stay).
alter table stays add column if not exists pay_by timestamptz;
alter table stays add column if not exists review_by timestamptz;

-- Set when a WEB stay is born, from the tenant's settings then and the
-- stored prices. AFTER INSERT, per statement, so a several-rooms stay is
-- priced once over all its rows. Definer, like the stay row itself: no token
-- has an update policy on stays.
create or replace function bookings_set_terms() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.stays s
  set required_amount = public.stay_required(t.total, a.config->'payments'->'fee'),
      pay_by = case when a.config->'payments' ? 'pay_within_hours'
                    then now() + make_interval(hours => (a.config->'payments'->>'pay_within_hours')::int) end
  from (
    select n.tenant_id, n.group_id, sum(b.price)::bigint as total
    from (select distinct tenant_id, group_id from born where source = 'web') n
    join public.bookings b on b.tenant_id = n.tenant_id and b.group_id = n.group_id
    group by n.tenant_id, n.group_id
  ) t
  join public.tenant_applications a on a.tenant_id = t.tenant_id and a.application_key = 'bookings'
  where s.tenant_id = t.tenant_id and s.group_id = t.group_id
    and s.required_amount is null
    and a.config ? 'payments';
  return null;
end;
$$;
drop trigger if exists bookings_set_terms on bookings;
create trigger bookings_set_terms
  after insert on bookings
  referencing new table as born
  for each statement execute function bookings_set_terms();
revoke all on function bookings_set_terms() from public, anon, authenticated;

-- 14. payments: one row per proof a guest sends (and, in Phase 4, per refund
--     staff record). A history, never overwritten: a rejected proof stays,
--     and the next one is a new row. Staff read; nobody writes through a
--     policy (submit_payment() is the guest's door, Phase 4's review
--     functions the staff's).
create table if not exists payments (
  id               bigint      generated always as identity primary key,
  tenant_id        bigint      not null,
  group_id         uuid        not null,
  kind             text        not null default 'payment',
  method           text        not null,
  payer_reference  text,
  claimed_amount   bigint      not null,
  paid_on          date        not null,
  proof_path       text,
  idempotency_key  uuid        not null,
  status           text        not null default 'submitted',
  verified_amount  bigint,
  account_checked  boolean     not null default false,
  reviewed_by      uuid,
  reviewed_at      timestamptz,
  rejection_reason text,
  created_at       timestamptz not null default now(),
  constraint payments_stay_fk foreign key (tenant_id, group_id)
    references stays (tenant_id, group_id) on delete cascade,
  constraint payments_kind check (kind in ('payment', 'refund')),
  constraint payments_status check (status in ('submitted', 'verified', 'rejected')),
  constraint payments_claimed check (claimed_amount > 0),
  constraint payments_verified check (status <> 'verified' or (verified_amount > 0 and account_checked and reviewed_by is not null and reviewed_at is not null)),
  constraint payments_rejected check (status <> 'rejected' or char_length(btrim(coalesce(rejection_reason, ''))) between 1 and 500),
  constraint payments_proof check (kind <> 'payment' or proof_path is not null),
  constraint payments_payer_reference check (payer_reference is null or char_length(payer_reference) <= 60),
  constraint payments_idempotent unique (tenant_id, group_id, idempotency_key),
  constraint payments_proof_once unique (proof_path)
);
-- One proof under review per stay at a time (§ 2.7 of the old plan, kept).
create unique index if not exists payments_one_open_idx on payments (tenant_id, group_id)
  where status = 'submitted' and kind = 'payment';
create index if not exists payments_stay_idx on payments (tenant_id, group_id, created_at);

alter table payments enable row level security;
drop policy if exists payments_read on payments;
create policy payments_read on payments for select to authenticated
  using (tenant_id = (select public.app_tenant_id()) and (select public.app_is_staff()));

-- The log learns payments: a proof sent, and later its review. Same rule
-- as bookings: written by the change itself, definer, nobody else.
alter table booking_events add column if not exists payment_id bigint;
alter table booking_events add column if not exists amount bigint;
alter table booking_events drop constraint if exists booking_events_kind;
alter table booking_events add constraint booking_events_kind check (kind in ('created', 'status', 'payment'));

create or replace function payments_log() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    insert into public.booking_events (tenant_id, group_id, actor_kind, actor_user, kind, to_value, payment_id, amount, note)
    values (new.tenant_id, new.group_id, public.app_actor(), auth.uid(), 'payment', new.kind || ':' || new.status,
            new.id, new.claimed_amount, new.method);
  elsif new.status is distinct from old.status then
    insert into public.booking_events (tenant_id, group_id, actor_kind, actor_user, kind, from_value, to_value, payment_id, amount, note)
    values (new.tenant_id, new.group_id, public.app_actor(), auth.uid(), 'payment', old.kind || ':' || old.status, new.kind || ':' || new.status,
            new.id, coalesce(new.verified_amount, new.claimed_amount), new.rejection_reason);
  end if;
  return null;
end;
$$;
drop trigger if exists payments_log on payments;
create trigger payments_log
  after insert or update on payments
  for each row execute function payments_log();
revoke all on function payments_log() from public, anon, authenticated;

-- 15. stay_payment(): the stay's money, DERIVED, never stored (plan Rule 3).
--     ONE function; guest_stay() and the staff screens read it.
--       price        the sum of the live rows' stored prices
--       required     stays.required_amount (null = not tracked)
--       received     verified payments minus verified refunds
--       outstanding  price - received
--       enough       received >= required: the stay may be confirmed
--       status       not_tracked | submitted | paid | partially_paid | refunded | rejected | unpaid
--     INVOKER: staff read it under their own RLS; guest_stay() calls it as
--     its definer, after the guest's match.
create or replace function stay_payment(p_tenant_id bigint, p_group_id uuid)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_status   text := public.stay_status(p_tenant_id, p_group_id);
  v_price    bigint;
  v_required bigint;
  v_paid     bigint;
  v_refunded bigint;
  v_open     boolean;
  v_last     text;
  v_any      boolean;
  v_word     text;
begin
  select sum(b.price)::bigint into v_price
  from public.bookings b where b.tenant_id = p_tenant_id and b.group_id = p_group_id and b.status = v_status;
  select s.required_amount into v_required from public.stays s where s.tenant_id = p_tenant_id and s.group_id = p_group_id;
  select coalesce(sum(p.verified_amount) filter (where p.kind = 'payment' and p.status = 'verified'), 0),
         coalesce(sum(p.verified_amount) filter (where p.kind = 'refund' and p.status = 'verified'), 0),
         coalesce(bool_or(p.status = 'submitted' and p.kind = 'payment'), false),
         count(*) > 0
    into v_paid, v_refunded, v_open, v_any
  from public.payments p where p.tenant_id = p_tenant_id and p.group_id = p_group_id;
  select p.status into v_last from public.payments p
  where p.tenant_id = p_tenant_id and p.group_id = p_group_id and p.kind = 'payment'
  order by p.created_at desc, p.id desc limit 1;

  v_word := case
    when v_required is null and not v_any then 'not_tracked'
    when v_open then 'submitted'
    when v_refunded > 0 and v_paid - v_refunded <= 0 then 'refunded'
    when v_price is not null and v_paid - v_refunded >= v_price then 'paid'
    when v_paid - v_refunded > 0 then 'partially_paid'
    when v_last = 'rejected' then 'rejected'
    else 'unpaid'
  end;
  return jsonb_build_object(
    'status',      v_word,
    'price',       v_price,
    'required',    v_required,
    'received',    v_paid - v_refunded,
    'outstanding', case when v_price is null then null else v_price - (v_paid - v_refunded) end,
    'enough',      v_required is not null and v_paid - v_refunded >= v_required,
    'open',        v_open
  );
end;
$$;
revoke all on function stay_payment(bigint, uuid) from public, anon;
grant execute on function stay_payment(bigint, uuid) to authenticated, service_role;

-- 16. guest_stay(): the guest's ONE read (plan Rule 4). SECURITY DEFINER,
--     D-042's shape: a chat token has no read policy on bookings or
--     payments, and this returns one stay's guest-facing columns only. It
--     checks its caller (the token's tenant, or service_role for the tools)
--     before anything, then matches with guest_group(). Since Phase 3 it
--     also carries the stay's payment (stay_payment()), its submission
--     history (amounts, method, dates, status, the rejection reason; never
--     the proof's path or the reviewer), and how to pay (the settings).
-- Guarded (trap 20): schema-stay-outcome.sql replaces this definition with
-- three keys more. Once it has run (stay_taken() exists), re-running THIS
-- file skips it.
do $guard$
begin
  if to_regprocedure('public.stay_taken(bigint, uuid)') is null then
    execute $ddl$
create or replace function guest_stay(p_tenant_id bigint, p_reference text, p_contact text)
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
                    from (select distinct jsonb_build_object('unit', u.name, 'slot', sl.name, 'guests', b2.guest_count) as r
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
$ddl$;
  end if;
end
$guard$;
revoke all on function guest_stay(bigint, text, text) from public, anon;
grant execute on function guest_stay(bigint, text, text) to authenticated, service_role;

-- 17. The proof bucket (plan § 2.7; Phase 0's spike, 14/14). PRIVATE: no
--     public URL; staff read an object by a 5-minute signed URL. A token of
--     the tenant may INSERT under '<tenant>/incoming/' and nothing else: no
--     read, list, update or delete, so a guest cannot read back, overwrite
--     or enumerate. The route matches the guest's stay BEFORE it uploads
--     (wall 1); these policies are wall 2. The size and type limits are the
--     second wall behind the route's own checks.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('payment-proofs', 'payment-proofs', false, 5242880,
        array['image/jpeg', 'image/png', 'image/webp', 'application/pdf'])
on conflict (id) do update
  set public             = excluded.public,
      file_size_limit    = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists payment_proofs_insert on storage.objects;
drop policy if exists payment_proofs_select on storage.objects;
create policy payment_proofs_insert on storage.objects for insert to authenticated
  with check (
    bucket_id = 'payment-proofs'
    and (storage.foldername(name))[1] = (select public.app_tenant_id())::text
    and (storage.foldername(name))[2] = 'incoming'
  );
create policy payment_proofs_select on storage.objects for select to authenticated
  using (
    bucket_id = 'payment-proofs'
    and (storage.foldername(name))[1] = (select public.app_tenant_id())::text
    and (select public.app_is_staff())
  );

-- 18. submit_payment(): the guest's ONE write here (plan Rule 1: a guest
--     submits; staff decide). SECURITY DEFINER: a chat token has no insert
--     policy on payments. It checks the caller's tenant, matches the guest
--     with guest_group() (a miss is P0002, which the package turns into the
--     same 404 sentence as a lookup), and then, in words:
--       22023  the method is not one of the tenant's, the amount or the date
--              is not plausible, the path is not this tenant's incoming/ file
--       55000  the stay takes no payment here (no settings, not tracked),
--              it is cancelled or expired, or a proof is already being checked
--     The object must exist in the bucket under this tenant's incoming/
--     prefix (uploaded by the route a moment before) and belong to no other
--     payment. A repeated idempotency key returns the first row's id: a
--     double click is one payment.
create or replace function submit_payment(
  p_tenant_id       bigint,
  p_reference       text,
  p_contact         text,
  p_proof_path      text,
  p_method          text,
  p_claimed_amount  bigint,
  p_paid_on         date,
  p_payer_reference text,
  p_idempotency_key uuid
)
returns bigint
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_group    uuid;
  v_status   text;
  v_config   jsonb;
  v_today    date;
  v_created  date;
  v_pay      jsonb;
  v_price    bigint;
  v_method   text;
  v_existing bigint;
  v_id       bigint;
begin
  if coalesce(auth.jwt() ->> 'role', '') <> 'service_role'
     and p_tenant_id is distinct from public.app_tenant_id() then
    raise exception 'submit_payment: tenant % is not the token''s tenant', p_tenant_id
      using errcode = 'insufficient_privilege';
  end if;

  v_group := public.guest_group(p_tenant_id, p_reference, p_contact);
  if v_group is null then
    raise exception 'no such booking' using errcode = 'no_data_found';
  end if;

  -- The same key again: the first submission's answer (a double click).
  select p.id into v_existing from public.payments p
  where p.tenant_id = p_tenant_id and p.group_id = v_group and p.idempotency_key = p_idempotency_key;
  if v_existing is not null then
    return v_existing;
  end if;

  select a.config into v_config from public.tenant_applications a
  where a.tenant_id = p_tenant_id and a.application_key = 'bookings';
  v_status := public.stay_status(p_tenant_id, v_group);
  v_pay := public.stay_payment(p_tenant_id, v_group);

  if not (v_config ? 'payments') or v_pay->>'status' = 'not_tracked' then
    raise exception 'This booking does not take payment on this page. Please contact the resort.'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  if v_status not in ('pending', 'confirmed') then
    raise exception 'This booking is %, so it takes no payment.', v_status
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  if (v_pay->>'open')::boolean then
    raise exception 'A payment for this booking is already being checked. Please wait for the resort to review it.'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  select m->>'label' into v_method from jsonb_array_elements(v_config->'payments'->'methods') m
  where lower(btrim(m->>'label')) = lower(btrim(coalesce(p_method, '')));
  if v_method is null then
    raise exception 'Choose one of the ways to pay shown on the page.' using errcode = 'invalid_parameter_value';
  end if;

  v_price := (v_pay->>'price')::bigint;
  if p_claimed_amount is null or p_claimed_amount < 1 or (v_price is not null and p_claimed_amount > v_price) then
    raise exception 'The amount paid must be more than zero and no more than the booking''s total.'
      using errcode = 'invalid_parameter_value';
  end if;

  v_today := (now() at time zone (v_config->>'timezone'))::date;
  select (min(s.created_at) at time zone (v_config->>'timezone'))::date into v_created
  from public.stays s where s.tenant_id = p_tenant_id and s.group_id = v_group;
  if p_paid_on is null or p_paid_on > v_today or p_paid_on < v_created - 1 then
    raise exception 'The payment date must be between the day you booked and today.'
      using errcode = 'invalid_parameter_value';
  end if;

  if p_payer_reference is not null and char_length(p_payer_reference) > 60 then
    raise exception 'The transaction reference is too long (60 characters at most).' using errcode = 'invalid_parameter_value';
  end if;

  if coalesce(p_proof_path, '') !~ ('^' || p_tenant_id::text || '/incoming/[0-9a-f-]{36}\.(jpg|png|webp|pdf)$')
     or not exists (select 1 from storage.objects o where o.bucket_id = 'payment-proofs' and o.name = p_proof_path)
     or exists (select 1 from public.payments p where p.proof_path = p_proof_path) then
    raise exception 'The proof of payment did not arrive. Please upload it again.' using errcode = 'invalid_parameter_value';
  end if;

  -- A stay past its payment deadline takes no proof (plan § 2.5): it is
  -- expired, whether or not the sweep has written the word yet.
  if public.stay_is_due(p_tenant_id, v_group) then
    raise exception 'The time to pay for this booking has passed, so it has expired. Please make a new request.'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  insert into public.payments (tenant_id, group_id, kind, method, payer_reference, claimed_amount, paid_on, proof_path, idempotency_key)
  values (p_tenant_id, v_group, 'payment', v_method, nullif(btrim(p_payer_reference), ''), p_claimed_amount, p_paid_on, p_proof_path, p_idempotency_key)
  returning id into v_id;

  -- Staff now have review_within_hours to decide it (Phase 5).
  update public.stays s
  set review_by = case when v_config->'payments' ? 'review_within_hours'
                       then now() + make_interval(hours => (v_config->'payments'->>'review_within_hours')::int) end
  where s.tenant_id = p_tenant_id and s.group_id = v_group;
  return v_id;
end;
$$;
revoke all on function submit_payment(bigint, text, text, text, text, bigint, date, text, uuid) from public, anon;
grant execute on function submit_payment(bigint, text, text, text, text, bigint, date, text, uuid) to authenticated, service_role;

-- ─── Phase 5: deadlines ──────────────────────────────────────────────────

-- 19a. Is this stay due to expire? ONE place (plan § 2.5): pending, past
--      pay_by, nothing verified, and no proof sent BEFORE pay_by still
--      waiting (that one is governed by review_by: staff decide it, the
--      clock does not). Reads use it at read time, so a stay shows
--      'expired' the moment it is due; the sweep below writes the word.
create or replace function stay_is_due(p_tenant_id bigint, p_group_id uuid)
returns boolean
language sql
stable
set search_path = ''
as $$
  select coalesce((
    select s.pay_by is not null
       and s.pay_by < now()
       and public.stay_status(s.tenant_id, s.group_id) = 'pending'
       and not exists (select 1 from public.payments p
                       where p.tenant_id = s.tenant_id and p.group_id = s.group_id and p.kind = 'payment'
                         and (p.status = 'verified' or (p.status = 'submitted' and p.created_at <= s.pay_by)))
    from public.stays s
    where s.tenant_id = p_tenant_id and s.group_id = p_group_id
  ), false)
$$;

-- 19b. The sweep: every due stay of the tenant → 'expired', as the system
--      (its events say so). Idempotent: a second run matches nothing.
--      SECURITY DEFINER so the word is written as 'system' whoever asks;
--      it checks its caller: staff of the tenant, or service_role. Called
--      when staff load the Bookings screen or the Payments queue.
create or replace function expire_due_stays(p_tenant_id bigint)
returns int
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_count int;
begin
  if coalesce(auth.jwt() ->> 'role', '') <> 'service_role'
     and (p_tenant_id is distinct from public.app_tenant_id() or not public.app_is_staff()) then
    raise exception 'expire_due_stays: not staff of tenant %', p_tenant_id using errcode = 'insufficient_privilege';
  end if;
  perform set_config('app.actor', 'system', true);
  update public.bookings b
  set status = 'expired', decision_note = 'Not paid in time'
  where b.tenant_id = p_tenant_id and b.status = 'pending'
    and public.stay_is_due(b.tenant_id, b.group_id);
  get diagnostics v_count = row_count;
  perform set_config('app.actor', '', true);
  return v_count;
end;
$$;
revoke all on function expire_due_stays(bigint) from public, anon;
grant execute on function expire_due_stays(bigint) to authenticated, service_role;

-- ─── Phase 4: staff verify, reject, refund; the settings; the note rule ───

-- 19-. Retention (§ 9 q7): a proof's FILE is deleted 180 days after its stay
--      ends (storage-orphans --expired); its payments row (amounts,
--      reviewer, dates) is kept, with proof_path cleared and the moment
--      recorded. Phase 8.
alter table payments add column if not exists proof_removed_at timestamptz;
alter table payments drop constraint if exists payments_proof;
alter table payments add constraint payments_proof
  check (kind <> 'payment' or proof_path is not null or proof_removed_at is not null);

-- 19. A staff note on a refund (and anything a reviewer wants to add).
alter table payments add column if not exists note text;
alter table payments drop constraint if exists payments_note;
alter table payments add constraint payments_note check (note is null or char_length(note) <= 500);

-- 20. review_payment(): verify or reject ONE submitted proof (plan § 4,
--     S-14). SECURITY DEFINER, so no token needs an update policy on
--     payments; it asks the role itself (D-079): an OWNER or ADMIN of the
--     token's tenant (app_is_admin()), nobody else (§ 9 q4). Staff read the
--     queue; they cannot decide it.
--       verify  the amount FOUND in the account (1 to the stay's total) and
--               "I checked the account", both required (R-46: a recorded
--               choice, not a click)
--       reject  a reason, 1–500 characters, which the guest reads
--       confirm with verify, and only if the stay is pending and now has
--               enough: pending → confirmed for the whole stay, in the SAME
--               transaction. A night taken meanwhile is bookings_no_overlap's
--               23P01, and then NOTHING changes, the verification included:
--               staff verify without confirming, and decide the clash.
--     Errors: 42501 not an owner/admin of this tenant; P0002 no such
--     payment here; 55000 already reviewed; 22023 the input, in words.
create or replace function review_payment(
  p_tenant_id       bigint,
  p_payment_id      bigint,
  p_action          text,
  p_amount          bigint,
  p_account_checked boolean,
  p_note            text,
  p_confirm         boolean
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_pay       public.payments%rowtype;
  v_price     bigint;
  v_confirmed int := 0;
  v_money     jsonb;
begin
  if p_tenant_id is distinct from public.app_tenant_id() or not public.app_is_admin() then
    raise exception 'Only an owner or admin of this business can review payments.' using errcode = 'insufficient_privilege';
  end if;

  select * into v_pay from public.payments p
  where p.tenant_id = p_tenant_id and p.id = p_payment_id and p.kind = 'payment'
  for update;
  if not found then
    raise exception 'no such payment' using errcode = 'no_data_found';
  end if;
  if v_pay.status <> 'submitted' then
    raise exception 'This proof was already %.', case v_pay.status when 'verified' then 'verified' else 'rejected' end
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  if p_action = 'verify' then
    v_price := ((public.stay_payment(p_tenant_id, v_pay.group_id))->>'price')::bigint;
    if p_amount is null or p_amount < 1 or (v_price is not null and p_amount > v_price) then
      raise exception 'Type the amount you found in the account: more than zero, and no more than the booking''s total.'
        using errcode = 'invalid_parameter_value';
    end if;
    if not coalesce(p_account_checked, false) then
      raise exception 'Tick "I checked the account" once the money is there. A screenshot alone proves nothing.'
        using errcode = 'invalid_parameter_value';
    end if;
    update public.payments
    set status = 'verified', verified_amount = p_amount, account_checked = true,
        reviewed_by = auth.uid(), reviewed_at = now(), note = nullif(btrim(coalesce(p_note, '')), '')
    where id = v_pay.id;
  elsif p_action = 'reject' then
    if char_length(btrim(coalesce(p_note, ''))) not between 1 and 500 then
      raise exception 'Say why the proof is not accepted (the guest reads it), in at most 500 characters.'
        using errcode = 'invalid_parameter_value';
    end if;
    update public.payments
    set status = 'rejected', rejection_reason = btrim(p_note), reviewed_by = auth.uid(), reviewed_at = now()
    where id = v_pay.id;
  else
    raise exception 'The action is "verify" or "reject".' using errcode = 'invalid_parameter_value';
  end if;

  v_money := public.stay_payment(p_tenant_id, v_pay.group_id);
  -- A proof sent BEFORE pay_by keeps its stay alive (stay_is_due() is false
  -- for it), so it can still be verified and confirmed after the deadline.
  if p_action = 'verify' and coalesce(p_confirm, false) and (v_money->>'enough')::boolean
     and public.stay_status(p_tenant_id, v_pay.group_id) = 'pending' then
    update public.bookings
    set status = 'confirmed', decision_note = coalesce(nullif(btrim(coalesce(p_note, '')), ''), 'Payment verified')
    where tenant_id = p_tenant_id and group_id = v_pay.group_id and status = 'pending';
    get diagnostics v_confirmed = row_count;
  end if;

  return jsonb_build_object('payment', v_money, 'confirmed', v_confirmed > 0);
end;
$$;
revoke all on function review_payment(bigint, bigint, text, bigint, boolean, text, boolean) from public, anon;
grant execute on function review_payment(bigint, bigint, text, bigint, boolean, text, boolean) to authenticated, service_role;

-- 21. record_refund(): staff RECORD a refund they made elsewhere (no money
--     moves here). Owner or admin; at most what was received; a note saying
--     how. A refund is a payments row of kind 'refund', verified at once,
--     so stay_payment() subtracts it like any other row.
create or replace function record_refund(
  p_tenant_id bigint,
  p_group_id  uuid,
  p_amount    bigint,
  p_method    text,
  p_note      text
)
returns bigint
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_received bigint;
  v_tz       text;
  v_id       bigint;
begin
  if p_tenant_id is distinct from public.app_tenant_id() or not public.app_is_admin() then
    raise exception 'Only an owner or admin of this business can record a refund.' using errcode = 'insufficient_privilege';
  end if;
  if not exists (select 1 from public.stays s where s.tenant_id = p_tenant_id and s.group_id = p_group_id) then
    raise exception 'no such booking' using errcode = 'no_data_found';
  end if;
  v_received := ((public.stay_payment(p_tenant_id, p_group_id))->>'received')::bigint;
  if p_amount is null or p_amount < 1 or p_amount > v_received then
    raise exception 'A refund is more than zero and no more than what was received.' using errcode = 'invalid_parameter_value';
  end if;
  if char_length(btrim(coalesce(p_method, ''))) not between 1 and 40 or char_length(btrim(coalesce(p_note, ''))) not between 1 and 500 then
    raise exception 'Say how the money was returned (1–40 characters) and add a note (1–500).' using errcode = 'invalid_parameter_value';
  end if;
  select a.config->>'timezone' into v_tz from public.tenant_applications a
  where a.tenant_id = p_tenant_id and a.application_key = 'bookings';

  insert into public.payments (tenant_id, group_id, kind, method, claimed_amount, paid_on, idempotency_key,
                               status, verified_amount, account_checked, reviewed_by, reviewed_at, note)
  values (p_tenant_id, p_group_id, 'refund', btrim(p_method), p_amount, (now() at time zone coalesce(v_tz, 'UTC'))::date, gen_random_uuid(),
          'verified', p_amount, true, auth.uid(), now(), btrim(p_note))
  returning id into v_id;
  return v_id;
end;
$$;
revoke all on function record_refund(bigint, uuid, bigint, text, text) from public, anon;
grant execute on function record_refund(bigint, uuid, bigint, text, text) to authenticated, service_role;

-- 22. set_payment_settings(): the Settings tab's ONE write. Owner or admin.
--     tenant_applications has no update policy for a tenant's own staff
--     (only super users edit the whole config), so this writes the
--     `payments` key and nothing else; null removes it (payments off). The
--     validator (§ 12) checks the shape as for any write.
create or replace function set_payment_settings(p_tenant_id bigint, p_payments jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_config jsonb;
begin
  if p_tenant_id is distinct from public.app_tenant_id() or not public.app_is_admin() then
    raise exception 'Only an owner or admin of this business can change payment settings.' using errcode = 'insufficient_privilege';
  end if;
  update public.tenant_applications a
  set config = case when p_payments is null or p_payments = 'null'::jsonb then a.config - 'payments'
                    else jsonb_set(a.config, '{payments}', p_payments) end
  where a.tenant_id = p_tenant_id and a.application_key = 'bookings'
  returning a.config into v_config;
  if v_config is null then
    raise exception 'no bookings application' using errcode = 'no_data_found';
  end if;
  return v_config->'payments';
end;
$$;
revoke all on function set_payment_settings(bigint, jsonb) from public, anon;
grant execute on function set_payment_settings(bigint, jsonb) to authenticated, service_role;

-- 23. Confirming a TRACKED stay with nothing verified needs a note (§ 9 q3):
--     "paid in cash", "Viber". The rule is Postgres's, so every door that
--     confirms meets it: the Requests section, the list's Confirm, a script.
--     A stay that is not tracked (staff stays; a tenant with no payment
--     settings) is untouched, as before. BEFORE UPDATE, per row, as the
--     caller (staff read stays and payments).
create or replace function bookings_confirm_needs_payment_or_note() returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_required bigint;
begin
  if old.status = 'pending' and new.status = 'confirmed' and btrim(coalesce(new.decision_note, '')) = '' then
    select s.required_amount into v_required from public.stays s
    where s.tenant_id = new.tenant_id and s.group_id = new.group_id;
    if v_required is not null and not ((public.stay_payment(new.tenant_id, new.group_id))->>'enough')::boolean then
      raise exception 'No payment has been verified for this booking yet. Add a note saying why it is confirmed, for example "paid in cash".'
        using errcode = 'check_violation';
    end if;
  end if;
  return new;
end;
$$;
drop trigger if exists bookings_confirm_needs_payment_or_note on bookings;
create trigger bookings_confirm_needs_payment_or_note
  before update on bookings
  for each row execute function bookings_confirm_needs_payment_or_note();

-- ─── Phase 6: cancel and reschedule requests (plan § 2.8, D-108) ─────────

-- 24. change_requests: a guest ASKS, staff decide (plan Rule 1). One open
--     request per stay. The quote the guest saw is stored with it.
create table if not exists change_requests (
  id                bigint      generated always as identity primary key,
  tenant_id         bigint      not null,
  group_id          uuid        not null,
  kind              text        not null,
  status            text        not null default 'pending',
  new_check_in      date,
  quoted_price      bigint,
  quoted_difference bigint,
  refund_due        bigint,
  guest_reason      text,
  decision_note     text,
  decided_by        uuid,
  decided_at        timestamptz,
  created_at        timestamptz not null default now(),
  constraint change_requests_stay_fk foreign key (tenant_id, group_id)
    references stays (tenant_id, group_id) on delete cascade,
  constraint change_requests_kind check (kind in ('cancel', 'reschedule')),
  constraint change_requests_status check (status in ('pending', 'approved', 'rejected', 'withdrawn')),
  constraint change_requests_reschedule check (kind <> 'reschedule' or (new_check_in is not null and quoted_price is not null)),
  constraint change_requests_reason check (guest_reason is null or char_length(guest_reason) <= 500),
  constraint change_requests_note check (decision_note is null or char_length(decision_note) <= 500)
);
create unique index if not exists change_requests_one_open_idx on change_requests (tenant_id, group_id) where status = 'pending';

alter table change_requests enable row level security;
drop policy if exists change_requests_read on change_requests;
create policy change_requests_read on change_requests for select to authenticated
  using (tenant_id = (select public.app_tenant_id()) and (select public.app_is_staff()));

alter table booking_events drop constraint if exists booking_events_kind;
alter table booking_events add constraint booking_events_kind check (kind in ('created', 'status', 'payment', 'change'));
alter table booking_events add column if not exists change_request_id bigint;

create or replace function change_requests_log() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    insert into public.booking_events (tenant_id, group_id, actor_kind, actor_user, kind, to_value, change_request_id, amount, note)
    values (new.tenant_id, new.group_id, public.app_actor(), auth.uid(), 'change', new.kind || ':' || new.status, new.id,
            coalesce(new.quoted_difference, new.refund_due), coalesce(new.new_check_in::text, new.guest_reason));
  elsif new.status is distinct from old.status then
    insert into public.booking_events (tenant_id, group_id, actor_kind, actor_user, kind, from_value, to_value, change_request_id, note)
    values (new.tenant_id, new.group_id, public.app_actor(), auth.uid(), 'change', old.kind || ':' || old.status, new.kind || ':' || new.status,
            new.id, new.decision_note);
  end if;
  return null;
end;
$$;
revoke all on function change_requests_log() from public, anon, authenticated;
drop trigger if exists change_requests_log on change_requests;
create trigger change_requests_log
  after insert or update on change_requests
  for each row execute function change_requests_log();

-- 25. change_terms(): what cancelling or rescheduling means TODAY, for the
--     page and for request_change(). ONE place for the policy's arithmetic:
--     days before check-in in the tenant's day; the first tier (sorted by
--     days_before, largest first) the stay is at or beyond gives the
--     refund percentage of what was RECEIVED, rounded DOWN to the centavo
--     (a refund owed is never more than the policy says). No tiers = 0.
create or replace function change_terms(p_tenant_id bigint, p_group_id uuid)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_config   jsonb;
  v_today    date;
  v_check_in date;
  v_days     int;
  v_percent  int;
  v_received bigint;
  v_cutoff   int;
  v_status   text := public.stay_status(p_tenant_id, p_group_id);
begin
  select a.config into v_config from public.tenant_applications a
  where a.tenant_id = p_tenant_id and a.application_key = 'bookings';
  v_today := (now() at time zone (v_config->>'timezone'))::date;
  select min(b.booked_date) into v_check_in from public.bookings b
  where b.tenant_id = p_tenant_id and b.group_id = p_group_id and b.status = v_status;
  v_days := v_check_in - v_today;
  v_received := ((public.stay_payment(p_tenant_id, p_group_id))->>'received')::bigint;
  select (t->>'refund_percent')::int into v_percent
  from jsonb_array_elements(coalesce(v_config->'payments'->'cancellation', '[]'::jsonb)) t
  where (t->>'days_before')::int <= v_days
  order by (t->>'days_before')::int desc
  limit 1;
  v_cutoff := (v_config->'payments'->>'reschedule_until_days_before')::int;
  return jsonb_build_object(
    'days_before',     v_days,
    'refund_percent',  coalesce(v_percent, 0),
    'refund_due',      (v_received * coalesce(v_percent, 0)) / 100,
    'can_cancel',      v_status in ('pending', 'confirmed') and v_days >= 0,
    'can_reschedule',  v_status = 'confirmed' and v_cutoff is not null and v_days >= v_cutoff,
    'reschedule_until_days_before', v_cutoff
  );
end;
$$;
revoke all on function change_terms(bigint, uuid) from public, anon;
grant execute on function change_terms(bigint, uuid) to authenticated, service_role;

-- 26. request_change(): the guest's door (definer, the guest_group() match).
--     p_dry_run = true returns the quote and stores nothing: the page shows
--     it BEFORE the guest sends (plan § 4).
--       cancel      a pending or confirmed stay, not yet begun; the refund
--                   the policy gives today is stored with the request
--       reschedule  a confirmed stay, at or before the cutoff; the SAME
--                   rooms, slot, nights and guests on new dates, priced by
--                   unit_quote() (no promo is carried: a discount was for
--                   the old dates, and the quote says the new price as it
--                   is); the new dates must be free now (booking_takes())
--     Errors: P0002 a miss; 22023 the input; 55000 the stay's state, the
--     policy, or a request already open.
create or replace function request_change(
  p_tenant_id    bigint,
  p_reference    text,
  p_contact      text,
  p_kind         text,
  p_new_check_in date,
  p_reason       text,
  p_dry_run      boolean
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_group     uuid;
  v_status    text;
  v_terms     jsonb;
  v_config    jsonb;
  v_today     date;
  v_check_in  date;
  v_shift     int;
  v_price     bigint;
  v_new_price bigint;
  v_taken     boolean;
  v_id        bigint;
begin
  if coalesce(auth.jwt() ->> 'role', '') <> 'service_role'
     and p_tenant_id is distinct from public.app_tenant_id() then
    raise exception 'request_change: tenant % is not the token''s tenant', p_tenant_id using errcode = 'insufficient_privilege';
  end if;
  v_group := public.guest_group(p_tenant_id, p_reference, p_contact);
  if v_group is null then
    raise exception 'no such booking' using errcode = 'no_data_found';
  end if;
  if p_kind not in ('cancel', 'reschedule') then
    raise exception 'A change is "cancel" or "reschedule".' using errcode = 'invalid_parameter_value';
  end if;
  if p_reason is not null and char_length(p_reason) > 500 then
    raise exception 'The reason is too long (500 characters at most).' using errcode = 'invalid_parameter_value';
  end if;
  if exists (select 1 from public.change_requests c where c.tenant_id = p_tenant_id and c.group_id = v_group and c.status = 'pending') then
    raise exception 'You already have a request waiting for this booking. Withdraw it first, or wait for the resort to answer.'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  v_status := public.stay_status(p_tenant_id, v_group);
  v_terms := public.change_terms(p_tenant_id, v_group);
  v_price := ((public.stay_payment(p_tenant_id, v_group))->>'price')::bigint;

  if p_kind = 'cancel' then
    if not (v_terms->>'can_cancel')::boolean then
      raise exception 'This booking can no longer be cancelled here. Please contact the resort.' using errcode = 'object_not_in_prerequisite_state';
    end if;
    if coalesce(p_dry_run, false) then
      return jsonb_build_object('kind', 'cancel', 'refund_due', (v_terms->>'refund_due')::bigint, 'refund_percent', (v_terms->>'refund_percent')::int);
    end if;
    insert into public.change_requests (tenant_id, group_id, kind, refund_due, guest_reason)
    values (p_tenant_id, v_group, 'cancel', (v_terms->>'refund_due')::bigint, nullif(btrim(p_reason), ''))
    returning id into v_id;
    return jsonb_build_object('id', v_id, 'kind', 'cancel', 'refund_due', (v_terms->>'refund_due')::bigint);
  end if;

  -- reschedule
  if not (v_terms->>'can_reschedule')::boolean then
    raise exception 'This booking can no longer be moved here: % Please contact the resort.',
      case when v_status <> 'confirmed' then 'only a confirmed booking can be moved.'
           when v_terms->>'reschedule_until_days_before' is null then 'the resort does not take date changes on this page.'
           else format('changes close %s days before check-in.', v_terms->>'reschedule_until_days_before') end
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  select a.config into v_config from public.tenant_applications a where a.tenant_id = p_tenant_id and a.application_key = 'bookings';
  v_today := (now() at time zone (v_config->>'timezone'))::date;
  select min(b.booked_date) into v_check_in from public.bookings b
  where b.tenant_id = p_tenant_id and b.group_id = v_group and b.status = v_status;
  if p_new_check_in is null or p_new_check_in <= v_today or p_new_check_in = v_check_in
     or p_new_check_in > v_today + coalesce((v_config->>'max_advance_days')::int, 365) then
    raise exception 'Choose a new check-in date after today, different from the current one, and within the booking window.'
      using errcode = 'invalid_parameter_value';
  end if;
  v_shift := p_new_check_in - v_check_in;

  -- The new nights: every live row moved by the same number of days.
  select sum(q.price)::bigint,
         bool_or(exists (
           select 1 from public.bookings o
           where o.tenant_id = p_tenant_id and o.unit_id = b.unit_id and o.group_id <> v_group
             and public.booking_takes(o.status, o.held, o.held_until)
             and o.during && public.slot_range(b.booked_date + v_shift, sl.start_time, sl.duration, v_config->>'timezone'))
         or exists (select 1 from public.rate_calendar rc where rc.tenant_id = p_tenant_id and rc.day = b.booked_date + v_shift and rc.kind = 'closed'))
    into v_new_price, v_taken
  from public.bookings b
  join public.slots sl on sl.tenant_id = b.tenant_id and sl.id = b.slot_id
  cross join lateral public.unit_quote(p_tenant_id, b.unit_id, b.slot_id, b.booked_date + v_shift, b.guest_count) q
  where b.tenant_id = p_tenant_id and b.group_id = v_group and b.status = v_status;
  if v_taken then
    raise exception 'Those dates are not available. Please choose others.' using errcode = 'object_not_in_prerequisite_state';
  end if;
  if v_new_price is null then
    raise exception 'Those dates have no price yet. Please choose others.' using errcode = 'invalid_parameter_value';
  end if;
  if coalesce(p_dry_run, false) then
    return jsonb_build_object('kind', 'reschedule', 'new_check_in', p_new_check_in, 'quoted_price', v_new_price, 'quoted_difference', v_new_price - v_price);
  end if;
  insert into public.change_requests (tenant_id, group_id, kind, new_check_in, quoted_price, quoted_difference, guest_reason)
  values (p_tenant_id, v_group, 'reschedule', p_new_check_in, v_new_price, v_new_price - v_price, nullif(btrim(p_reason), ''))
  returning id into v_id;
  return jsonb_build_object('id', v_id, 'kind', 'reschedule', 'new_check_in', p_new_check_in, 'quoted_price', v_new_price, 'quoted_difference', v_new_price - v_price);
end;
$$;
revoke all on function request_change(bigint, text, text, text, date, text, boolean) from public, anon;
grant execute on function request_change(bigint, text, text, text, date, text, boolean) to authenticated, service_role;

-- 27. withdraw_change(): the guest takes back their open request.
create or replace function withdraw_change(p_tenant_id bigint, p_reference text, p_contact text)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_group uuid;
  v_count int;
begin
  if coalesce(auth.jwt() ->> 'role', '') <> 'service_role'
     and p_tenant_id is distinct from public.app_tenant_id() then
    raise exception 'withdraw_change: tenant % is not the token''s tenant', p_tenant_id using errcode = 'insufficient_privilege';
  end if;
  v_group := public.guest_group(p_tenant_id, p_reference, p_contact);
  if v_group is null then
    raise exception 'no such booking' using errcode = 'no_data_found';
  end if;
  update public.change_requests c set status = 'withdrawn', decided_at = now()
  where c.tenant_id = p_tenant_id and c.group_id = v_group and c.status = 'pending';
  get diagnostics v_count = row_count;
  return v_count > 0;
end;
$$;
revoke all on function withdraw_change(bigint, text, text) from public, anon;
grant execute on function withdraw_change(bigint, text, text) to authenticated, service_role;

-- 28. decide_change(): staff approve or reject. Owners and admins (it
--     moves money owed: a refund due, a balance), like review_payment().
--       reject     a note the guest reads
--       cancel     every live row → cancelled, in one statement; the refund
--                  due stays on the request for staff to pay and RECORD
--                  (record_refund()); nothing is refunded here
--       reschedule under request_booking()'s own lock: the old rows are
--                  cancelled ("rescheduled to …") and the new ones inserted
--                  in the SAME group (one reference) with the old status, in
--                  ONE transaction. The insert meets bookings_no_overlap and
--                  every trigger; a night taken meanwhile is 23P01 and
--                  nothing changes, the request still pending. Prices are the
--                  insert trigger's (unit_quote()); the difference becomes
--                  the stay's outstanding balance by itself (stay_payment()
--                  sums the live rows), § 9 q5.
create or replace function decide_change(p_tenant_id bigint, p_id bigint, p_action text, p_note text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_req    public.change_requests%rowtype;
  v_status text;
  v_shift  int;
  v_check  date;
  v_old    bigint[];
begin
  if p_tenant_id is distinct from public.app_tenant_id() or not public.app_is_admin() then
    raise exception 'Only an owner or admin of this business can decide a change request.' using errcode = 'insufficient_privilege';
  end if;
  select * into v_req from public.change_requests c where c.tenant_id = p_tenant_id and c.id = p_id for update;
  if not found then
    raise exception 'no such request' using errcode = 'no_data_found';
  end if;
  if v_req.status <> 'pending' then
    raise exception 'This request was already %.', v_req.status using errcode = 'object_not_in_prerequisite_state';
  end if;

  if p_action = 'reject' then
    if char_length(btrim(coalesce(p_note, ''))) not between 1 and 500 then
      raise exception 'Say why (the guest reads it), in at most 500 characters.' using errcode = 'invalid_parameter_value';
    end if;
    update public.change_requests set status = 'rejected', decision_note = btrim(p_note), decided_by = auth.uid(), decided_at = now()
    where id = v_req.id;
    return jsonb_build_object('status', 'rejected');
  elsif p_action <> 'approve' then
    raise exception 'The action is "approve" or "reject".' using errcode = 'invalid_parameter_value';
  end if;

  v_status := public.stay_status(p_tenant_id, v_req.group_id);
  if v_req.kind = 'cancel' then
    update public.bookings b
    set status = 'cancelled', decision_note = coalesce(nullif(btrim(coalesce(p_note, '')), ''), 'Cancelled at the guest''s request')
    where b.tenant_id = p_tenant_id and b.group_id = v_req.group_id and b.status in ('pending', 'confirmed');
  else
    if v_status <> 'confirmed' then
      raise exception 'Only a confirmed booking can be moved; this one is %.', v_status using errcode = 'object_not_in_prerequisite_state';
    end if;
    perform pg_advisory_xact_lock(hashtextextended('request_booking:' || p_tenant_id::text, 0));
    select min(b.booked_date), array_agg(b.id) into v_check, v_old from public.bookings b
    where b.tenant_id = p_tenant_id and b.group_id = v_req.group_id and b.status = 'confirmed';
    v_shift := v_req.new_check_in - v_check;
    update public.bookings b
    set status = 'cancelled', decision_note = format('Rescheduled to %s', v_req.new_check_in)
    where b.id = any(v_old);
    insert into public.bookings (tenant_id, unit_id, slot_id, booked_date, guest_name, guest_phone, guest_email, guest_count,
                                 notes, status, source, group_id, reference, decision_note)
    select b.tenant_id, b.unit_id, b.slot_id, b.booked_date + v_shift, b.guest_name, b.guest_phone, b.guest_email, b.guest_count,
           b.notes, 'confirmed', b.source, b.group_id, b.reference, format('Moved from %s', v_check)
    from public.bookings b
    where b.id = any(v_old)
    order by b.booked_date, b.id;
  end if;

  update public.change_requests set status = 'approved', decision_note = nullif(btrim(coalesce(p_note, '')), ''), decided_by = auth.uid(), decided_at = now()
  where id = v_req.id;
  return jsonb_build_object('status', 'approved', 'payment', public.stay_payment(p_tenant_id, v_req.group_id));
end;
$$;
revoke all on function decide_change(bigint, bigint, text, text) from public, anon;
grant execute on function decide_change(bigint, bigint, text, text) to authenticated, service_role;

-- 29. The dashboard's two attention counts (plan § 4, Phase 8): proofs
--     waiting and change requests waiting. A function BESIDE
--     tenant_dashboard() rather than a change to it, so that file's body is
--     not redefined here (trap 20); the dashboard read merges the two.
--     INVOKER, so it counts under the caller's RLS, and it refuses a caller
--     that is not staff of the tenant, like tenant_dashboard(); service_role
--     is allowed, for the tools, as there (the filters-only isolation run
--     reads the dashboard on it).
create or replace function manage_attention(p_tenant_id bigint)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
begin
  if coalesce(auth.jwt() ->> 'role', '') <> 'service_role'
     and (p_tenant_id is distinct from public.app_tenant_id() or not public.app_is_staff()) then
    raise exception 'manage_attention: not staff of tenant %', p_tenant_id using errcode = 'insufficient_privilege';
  end if;
  return jsonb_build_object(
    'proofsToVerify', (select count(*) from public.payments p where p.tenant_id = p_tenant_id and p.kind = 'payment' and p.status = 'submitted'),
    'changeRequests', (select count(*) from public.change_requests c where c.tenant_id = p_tenant_id and c.status = 'pending')
  );
end;
$$;
revoke all on function manage_attention(bigint) from public, anon;
grant execute on function manage_attention(bigint) to authenticated, service_role;

-- PostgREST caches the schema: the new table, function and columns are
-- unknown to it until told.
notify pgrst, 'reload schema';
