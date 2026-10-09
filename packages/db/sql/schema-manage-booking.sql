-- schema-manage-booking.sql — the guest's Manage booking page and what
-- stands behind it (plan/manage-booking.md).
--
-- Run AFTER schema-calendar.sql. The 23rd file. Idempotent. Phase 1:
-- stays, the `expired` status, booking_events, the guest's one read
-- (sections 1–11). Phase 3: payment settings, the required amount, payments,
-- stay_payment(), the proof bucket and submit_payment() (12–18), and
-- guest_stay() redefined IN PLACE with the stay's payment (16). Phases 4
-- and 6 add their sections here. NO existing function is
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
--         "terms": "..."                                                ≤ 4000, shown to guests
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
    if v_key not in ('methods', 'fee', 'pay_within_hours', 'review_within_hours', 'terms') then
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
  set required_amount = public.stay_required(t.total, a.config->'payments'->'fee')
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
    'status',      v_status,
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
                     'terms',   v_config->'payments'->'terms') end
  ) into v_out
  from public.bookings b
  join public.stays s on s.tenant_id = b.tenant_id and s.group_id = b.group_id
  where b.tenant_id = p_tenant_id and b.group_id = v_group and b.status = v_status;

  return v_out;
end;
$$;

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

  insert into public.payments (tenant_id, group_id, kind, method, payer_reference, claimed_amount, paid_on, proof_path, idempotency_key)
  values (p_tenant_id, v_group, 'payment', v_method, nullif(btrim(p_payer_reference), ''), p_claimed_amount, p_paid_on, p_proof_path, p_idempotency_key)
  returning id into v_id;
  return v_id;
end;
$$;
revoke all on function submit_payment(bigint, text, text, text, text, bigint, date, text, uuid) from public, anon;
grant execute on function submit_payment(bigint, text, text, text, text, bigint, date, text, uuid) to authenticated, service_role;

-- PostgREST caches the schema: the new table, function and columns are
-- unknown to it until told.
notify pgrst, 'reload schema';
