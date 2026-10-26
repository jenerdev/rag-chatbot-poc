-- schema-legal.sql — the 35th file (D-129 – D-131, plan/legal.md): what the
-- Data Privacy Act (RA 10173) asks of the app's own parts.
--
--   1. tenants: the privacy contact, the data processing agreement's date,
--      the policy version guests agree to, and how long chats and guest
--      details are kept (D-129, D-131);
--   2. tenant_public(): those, for the public privacy page. REPLACES the
--      definition in schema-assistant-avatar.sql, which is now guarded on
--      this file's marker (the privacy_contact_email column; trap 20);
--   3. consent on the stay: request_booking_with_consent() and the stays
--      trigger that records it (D-129). request_booking() itself is NOT
--      replaced (plan/legal.md Rule 2);
--   4. the DPA gate: the platform cannot switch bookings on for a tenant
--      without a signed agreement (D-130);
--   5. removing a stay's guest details after the retention period (D-131);
--   6. listing the chats past the period, for the retention tool (D-131).
--      bookings_web_request is re-made to allow it; the older file's
--      version is guarded on bookings.guest_removed_at.
--
-- Idempotent. Run after schema-role-permissions.sql.

-- 1. tenants.
alter table public.tenants add column if not exists privacy_contact_name  text;
alter table public.tenants add column if not exists privacy_contact_email text;
alter table public.tenants add column if not exists dpa_signed_on         date;
alter table public.tenants add column if not exists policy_version        text not null default '1';
alter table public.tenants add column if not exists chat_retention_days   int  not null default 365;
alter table public.tenants add column if not exists guest_retention_days  int  not null default 1095;

alter table public.tenants drop constraint if exists tenants_privacy_contact;
alter table public.tenants add  constraint tenants_privacy_contact check (
  (privacy_contact_name is null or char_length(btrim(privacy_contact_name)) between 1 and 100)
  and (privacy_contact_email is null or (char_length(privacy_contact_email) <= 254 and privacy_contact_email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'))
);
alter table public.tenants drop constraint if exists tenants_policy_version;
alter table public.tenants add  constraint tenants_policy_version check (policy_version ~ '^[A-Za-z0-9._-]{1,20}$');
alter table public.tenants drop constraint if exists tenants_retention;
alter table public.tenants add  constraint tenants_retention check (
  chat_retention_days between 30 and 1825 and guest_retention_days between 180 and 3650
);

-- 2. tenant_public(), with what the privacy page states: the contact, the
--    version, the periods. Not the DPA date: that is between the platform
--    and the resort. Dropped and re-created (the return type changes);
--    still definer, search_path '', no archived tenant; grants re-applied.
-- GUARDED (D-139, 2026-10-21): schema-welcome-text.sql replaces this with a
-- welcome_text column. Re-run after it, this drop and create would quietly
-- take the column away again (CLAUDE.md trap 20), so it is skipped once
-- tenant_public() returns that column.
do $guard$
begin
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'tenant_public'
       and 'welcome_text' = any(p.proargnames)
  ) then
    return;
  end if;
drop function if exists public.tenant_public(text);
create function public.tenant_public(p_slug text)
returns table (
  id                    bigint,
  slug                  text,
  business_name         text,
  assistant_name        text,
  logo_url              text,
  banner_url            text,
  theme                 jsonb,
  fallback_messages     jsonb,
  suggested_questions   jsonb,
  assistant_avatar_url  text,
  privacy_contact_name  text,
  privacy_contact_email text,
  policy_version        text,
  chat_retention_days   int,
  guest_retention_days  int
)
language sql stable
security definer
set search_path = ''
as $$
  select t.id, t.slug, t.business_name, t.assistant_name, t.logo_url, t.banner_url, t.theme, t.fallback_messages,
         t.suggested_questions, t.assistant_avatar_url, t.privacy_contact_name, t.privacy_contact_email,
         t.policy_version, t.chat_retention_days, t.guest_retention_days
  from public.tenants t
  where t.slug = p_slug and t.archived_at is null
$$;
revoke all on function public.tenant_public(text) from public, anon, authenticated;
grant execute on function public.tenant_public(text) to anon, authenticated, service_role;
end;
$guard$;

-- 3. Consent on the stay (D-129).
alter table public.stays add column if not exists consent_version text;
alter table public.stays add column if not exists consented_at    timestamptz;

--    The stay row is born inside request_booking() (the stays trigger of
--    schema-manage-booking.sql). This BEFORE INSERT trigger reads the
--    transaction-local setting the wrapper below sets, and nothing else; a
--    stay made any other way (staff, the tools) gets none.
create or replace function public.stays_consent() returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_version text := nullif(current_setting('app.consent_version', true), '');
begin
  if v_version is not null then
    new.consent_version := v_version;
    new.consented_at := now();
  end if;
  return new;
end;
$$;
drop trigger if exists stays_consent on public.stays;
create trigger stays_consent before insert on public.stays
  for each row execute function public.stays_consent();

--    The web route's door: the same arguments as request_booking(), and the
--    version of the policy the guest ticked. The version must be the
--    tenant's current one (a page left open across a policy change asks
--    again). SECURITY DEFINER for the same reason as request_booking(); it
--    checks the token's tenant itself and then calls that function, which
--    checks everything else again.
-- GUARDED (D-147, 2026-10-26): schema-free-guests.sql replaces this with p_free (and drops this signature).
-- Once that file has run, re-running THIS file must not put a body with no
-- free count back, so the definition is skipped (CLAUDE.md trap 20).
do $guard$
begin
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'bookings' and column_name = 'free_guests') then
    execute $ddl$
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
  p_consent_version text
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
                                         p_name, p_phone, p_email, p_notes, p_promo_code);
end;
$$;
$ddl$;
    execute $ddl$ revoke all on function public.request_booking_with_consent(bigint, bigint, bigint[], int[], date, int, text, text, text, text, text, text) from public, anon $ddl$;
    execute $ddl$ grant execute on function public.request_booking_with_consent(bigint, bigint, bigint[], int[], date, int, text, text, text, text, text, text) to authenticated, service_role $ddl$;
  end if;
end
$guard$;

-- 4. The DPA gate (D-130): the bookings application holds guests' personal
--    data, so it cannot be switched on before the resort and the platform
--    have signed a data processing agreement. A new row only: a tenant that
--    already has bookings keeps it (plan/legal.md § 5 lists them). The CLI
--    and the walks (service_role) are exempt; the platform token is not.
create or replace function public.tenant_applications_dpa() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.application_key = 'bookings'
     and coalesce(auth.jwt() ->> 'role', '') <> 'service_role'
     and session_user <> 'postgres'
     and (select t.dpa_signed_on from public.tenants t where t.id = new.tenant_id) is null then
    raise exception 'Record the signed data processing agreement first (the Legal tab), then switch bookings on.'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
drop trigger if exists tenant_applications_dpa on public.tenant_applications;
create trigger tenant_applications_dpa before insert on public.tenant_applications
  for each row execute function public.tenant_applications_dpa();

-- 5. Removing a stay's guest details (D-131).
alter table public.bookings add column if not exists guest_removed_at timestamptz;

--    A web request must carry its contact, unless the contact has been
--    removed after the retention period. Same as schema-customer-booking.sql
--    but for the last clause; that file now skips its version once
--    guest_removed_at exists.
alter table public.bookings drop constraint if exists bookings_web_request;
alter table public.bookings add  constraint bookings_web_request check (
  source <> 'web' or guest_removed_at is not null
  or (reference is not null and group_id is not null and guest_email is not null and guest_phone is not null)
);

--    Clear the guest's details from every stay of the tenant whose last
--    night ended before p_before: name, phone, email and notes on the
--    bookings, the guest's reason on change requests. The rows, dates,
--    amounts, statuses and references stay (the books). A live stay (still
--    pending, or confirmed with nights ahead) is never touched. Returns the
--    number of booking rows cleared. service_role only: the retention tool.
create or replace function public.remove_guest_details(p_tenant_id bigint, p_before date) returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_groups uuid[];
  v_count int;
begin
  if coalesce(auth.jwt() ->> 'role', '') <> 'service_role' and session_user <> 'postgres' then
    raise exception 'Only the retention tool removes guest details.' using errcode = 'insufficient_privilege';
  end if;
  select coalesce(array_agg(g.group_id), '{}') into v_groups
  from (
    select b.group_id
    from public.bookings b
    where b.tenant_id = p_tenant_id and b.group_id is not null and b.guest_removed_at is null
    group by b.group_id
    having max(b.booked_date) < p_before
  ) g;
  update public.bookings b
     set guest_name = 'Removed', guest_phone = null, guest_email = null, notes = null, guest_removed_at = now()
   where b.tenant_id = p_tenant_id and b.group_id = any (v_groups);
  get diagnostics v_count = row_count;
  update public.change_requests c set guest_reason = null
   where c.tenant_id = p_tenant_id and c.group_id = any (v_groups) and c.guest_reason is not null;
  return v_count;
end;
$$;
revoke all on function public.remove_guest_details(bigint, date) from public, anon, authenticated;
grant execute on function public.remove_guest_details(bigint, date) to service_role;

-- 6. The chats past the tenant's period (D-131): each conversation whose
--    NEWEST message (or, with none, its own creation) is older than p_before.
--    The retention tool deletes them by id; a conversation's messages, and
--    a refused question's resolution row, go with it by cascade.
--    service_role only, like remove_guest_details().
create or replace function public.chats_older_than(p_tenant_id bigint, p_before timestamptz)
returns table (id uuid, last_at timestamptz)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if coalesce(auth.jwt() ->> 'role', '') <> 'service_role' and session_user <> 'postgres' then
    raise exception 'Only the retention tool lists old chats.' using errcode = 'insufficient_privilege';
  end if;
  return query
    select c.id, coalesce(max(m.created_at), c.created_at) as last_at
    from public.conversations c
    left join public.messages m on m.conversation_id = c.id and m.tenant_id = c.tenant_id
    where c.tenant_id = p_tenant_id
    group by c.id, c.created_at
    having coalesce(max(m.created_at), c.created_at) < p_before;
end;
$$;
revoke all on function public.chats_older_than(bigint, timestamptz) from public, anon, authenticated;
grant execute on function public.chats_older_than(bigint, timestamptz) to service_role;

notify pgrst, 'reload schema';
