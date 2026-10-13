-- schema-features.sql — the 33rd file (D-127): FEATURE FLAGS per tenant,
-- switched on and off by a super user on the platform page.
--
-- A feature is a part of the app a tenant may do without: a screen, a public
-- page, a kind of notice. Like an application (D-033) it is CODE; a row here
-- only says whether this tenant has it. Unlike an application, a feature is
-- ON unless a row says it is off, so every tenant keeps what it has today
-- and a new feature reaches every tenant at once. The keys are listed in
-- apps/web/lib/features.ts and in the check below: the same names.
--
-- Two walls, as everywhere (D-038):
--   1. the code: a switched-off page and its routes answer 404, and the
--      header leaves the link out (apps/web/lib/feature-flags.ts);
--   2. Postgres: the WRITES a switched-off feature would let a stranger make
--      are refused here, by triggers, whoever asks: a web booking request
--      (booking_page), a guest's proof or change request (manage_booking).
--      A switched-off notifications feature queues nothing (the outbox row
--      is dropped before it is written), so nothing is pushed.
--   A read behind a switched-off screen is wall 1's alone: the data stays
--   readable by the same tokens as before (a member reads its own
--   conversations), so there is nothing new for Postgres to hide.
--
-- Who writes: a super user (app_is_super(), D-076). Who reads: any token of
-- the tenant, for its own rows, because the chat's pages must know whether
-- the booking page is on. Nothing here is secret.
--
-- No function is replaced, so no older file needs a guard (trap 20). The
-- helper, tenant_feature_on(), is SECURITY INVOKER: inside request_booking()
-- and the other definer functions it runs as their owner; called by a token
-- directly it reads only that token's tenant's rows, and a row it cannot
-- see reads as "on", the default.
--
-- Idempotent. Run after schema-roles.sql, schema-manage-booking.sql and
-- schema-notifications.sql.

-- 1. The table.
create table if not exists public.tenant_features (
  tenant_id  bigint      not null references public.tenants (id) on delete cascade,
  feature    text        not null,
  enabled    boolean     not null,
  updated_at timestamptz not null default now(),
  primary key (tenant_id, feature)
);
alter table public.tenant_features drop constraint if exists tenant_features_key;
alter table public.tenant_features add  constraint tenant_features_key check (feature in (
  'dashboard', 'conversations', 'unanswered', 'suggested_questions',
  'booking_page', 'manage_booking', 'calendar', 'notifications'
));

alter table public.tenant_features enable row level security;
revoke all on public.tenant_features from anon;

drop policy if exists tenant_features_read on public.tenant_features;
create policy tenant_features_read on public.tenant_features for select to authenticated
  using (tenant_id = (select public.app_tenant_id()));

drop policy if exists tenant_features_super_all on public.tenant_features;
create policy tenant_features_super_all on public.tenant_features for all to authenticated
  using      ((select public.app_is_super()))
  with check ((select public.app_is_super()));

-- 2. The one question: is this feature on for this tenant? No row = on.
create or replace function public.tenant_feature_on(p_tenant_id bigint, p_feature text) returns boolean
language sql stable
set search_path = ''
as $$
  select coalesce(
    (select f.enabled from public.tenant_features f where f.tenant_id = p_tenant_id and f.feature = p_feature),
    true)
$$;
revoke all on function public.tenant_feature_on(bigint, text) from public, anon;
grant execute on function public.tenant_feature_on(bigint, text) to authenticated, service_role;

-- 3. The writes a switched-off feature refuses (wall 2). BEFORE INSERT, so a
--    refused row is never written; check_violation (23514), so every door
--    already maps it to a 400 with these words.

--    booking_page: a web request. Staff bookings (source 'staff') are the
--    tenant's own work and stay open.
create or replace function public.bookings_feature_booking_page() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.source = 'web' and not public.tenant_feature_on(new.tenant_id, 'booking_page') then
    raise exception 'Online booking is switched off for this workspace.' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
drop trigger if exists bookings_feature_booking_page on public.bookings;
create trigger bookings_feature_booking_page before insert on public.bookings
  for each row execute function public.bookings_feature_booking_page();

--    manage_booking: a guest's proof of payment (kind 'payment'; staff
--    write only refunds) and a guest's change request (only guests make one).
create or replace function public.payments_feature_manage_booking() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.kind = 'payment' and not public.tenant_feature_on(new.tenant_id, 'manage_booking') then
    raise exception 'Managing a booking online is switched off for this workspace.' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
drop trigger if exists payments_feature_manage_booking on public.payments;
create trigger payments_feature_manage_booking before insert on public.payments
  for each row execute function public.payments_feature_manage_booking();

create or replace function public.change_requests_feature_manage_booking() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if not public.tenant_feature_on(new.tenant_id, 'manage_booking') then
    raise exception 'Managing a booking online is switched off for this workspace.' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
drop trigger if exists change_requests_feature_manage_booking on public.change_requests;
create trigger change_requests_feature_manage_booking before insert on public.change_requests
  for each row execute function public.change_requests_feature_manage_booking();

--    notifications: nothing is queued, so nothing is pushed. Returning null
--    from a BEFORE trigger skips the row quietly: the booking event that
--    caused it is still written, and staff still see the request on their
--    screens; only the notice is not made.
create or replace function public.notification_outbox_feature() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if not public.tenant_feature_on(new.tenant_id, 'notifications') then
    return null;
  end if;
  return new;
end;
$$;
drop trigger if exists notification_outbox_feature on public.notification_outbox;
create trigger notification_outbox_feature before insert on public.notification_outbox
  for each row execute function public.notification_outbox_feature();

notify pgrst, 'reload schema';
