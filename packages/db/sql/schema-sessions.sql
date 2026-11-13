-- schema-sessions.sql — the 49th file. Audit S-6, D-163.
--
-- Staff and platform sessions were HMAC cookies with an expiry and no state
-- on the server (D-028, D-040, D-076): genuine until they ran out, 12 hours.
-- Logging out cleared the cookie in THAT browser only; a copied cookie (a
-- shared machine, a stolen laptop's profile) went on working for the rest of
-- the 12 hours, through a logout and through a password change. The
-- platform cookie, which reaches every tenant, the same.
--
-- Now every login has a row, and the cookie carries its id inside the HMAC:
--
--   app_sessions        one row per login: whose, which kind, which tenant
--                       (staff) or none (platform), when it ends, whether it
--                       was revoked. No policy, no grant: only the functions.
--   session_open()      at login, on the new member's (or super user's) OWN
--                       token: the row for auth.uid(), for the token's tenant.
--   session_valid()     on every guarded request, after the membership: this
--                       id is this user's, this kind's, this tenant's, live.
--   session_close()     logout: this device's row.
--   session_close_all() a new password: every live row of auth.uid(), every
--                       tenant and the platform. Called with the reset link's
--                       own Supabase access token (its sub is the user).
--
-- Every function takes the USER from the token (auth.uid()), never from an
-- argument, so no caller can open, test or close another person's session.
-- A chat token has no sub: every function refuses it or answers false.
-- security definer (the table has no policy), search_path = '', every name
-- qualified (trap 19). Idempotent; replaces nothing an earlier file made.

begin;

create table if not exists public.app_sessions (
  id         uuid        primary key default gen_random_uuid(),
  user_id    uuid        not null references auth.users (id) on delete cascade,
  kind       text        not null,
  tenant_id  bigint      references public.tenants (id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  constraint app_sessions_kind check (kind in ('staff', 'platform')),
  constraint app_sessions_tenant check ((kind = 'staff') = (tenant_id is not null))
);
create index if not exists app_sessions_user_live on public.app_sessions (user_id) where revoked_at is null;

alter table public.app_sessions enable row level security;
revoke all on public.app_sessions from public, anon, authenticated;

-- Open: the row for the token's user. A staff session needs a membership of
-- the token's tenant (app_role()); a platform session needs the super row.
-- p_seconds is the cookie's own lifetime, bounded. The user's rows that ended
-- more than a day ago are swept here, so the table holds live sessions and a
-- day of history, not every login ever.
create or replace function public.session_open(p_kind text, p_seconds int)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_user   uuid := auth.uid();
  v_tenant bigint;
  v_id     uuid;
begin
  if v_user is null then
    raise exception 'session_open: no user on this token' using errcode = 'insufficient_privilege';
  end if;
  if p_seconds is null or p_seconds < 60 or p_seconds > 43200 then
    raise exception 'session_open: a session lasts 1 minute to 12 hours' using errcode = 'invalid_parameter_value';
  end if;
  if p_kind = 'staff' then
    v_tenant := public.app_tenant_id();
    if v_tenant is null or public.app_role() is null then
      raise exception 'session_open: not a member of this token''s tenant' using errcode = 'insufficient_privilege';
    end if;
  elsif p_kind = 'platform' then
    if public.app_tenant_id() is not null or not public.app_is_super() then
      raise exception 'session_open: not a super user' using errcode = 'insufficient_privilege';
    end if;
  else
    raise exception 'session_open: the kind is staff or platform' using errcode = 'invalid_parameter_value';
  end if;

  delete from public.app_sessions s
  where s.user_id = v_user and coalesce(s.revoked_at, s.expires_at) < now() - interval '1 day';

  insert into public.app_sessions (user_id, kind, tenant_id, expires_at)
  values (v_user, p_kind, v_tenant, now() + make_interval(secs => p_seconds))
  returning id into v_id;
  return v_id;
end;
$$;

-- Valid: this id, this user, live, and the kind and tenant of THIS token. A
-- staff session of villa is not valid on a token of another tenant, and a
-- platform session is not valid on a tenant's token, nor the reverse.
create or replace function public.session_valid(p_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.app_sessions s
    where s.id = p_id
      and s.user_id = auth.uid()
      and s.revoked_at is null
      and s.expires_at > now()
      and (
        (s.kind = 'staff' and s.tenant_id = public.app_tenant_id())
        or (s.kind = 'platform' and public.app_tenant_id() is null)
      )
  )
$$;

-- Close one: logout. Only the token's user's own row; true if it was live.
create or replace function public.session_close(p_id uuid)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_count int;
begin
  update public.app_sessions s set revoked_at = now()
  where s.id = p_id and s.user_id = auth.uid() and s.revoked_at is null;
  get diagnostics v_count = row_count;
  return v_count > 0;
end;
$$;

-- Close all: a new password ends every session the user has, everywhere.
create or replace function public.session_close_all()
returns int
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_count int;
begin
  if auth.uid() is null then
    raise exception 'session_close_all: no user on this token' using errcode = 'insufficient_privilege';
  end if;
  update public.app_sessions s set revoked_at = now()
  where s.user_id = auth.uid() and s.revoked_at is null;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function public.session_open(text, int) from public, anon;
revoke all on function public.session_valid(uuid) from public, anon;
revoke all on function public.session_close(uuid) from public, anon;
revoke all on function public.session_close_all() from public, anon;
grant execute on function public.session_open(text, int) to authenticated, service_role;
grant execute on function public.session_valid(uuid) to authenticated, service_role;
grant execute on function public.session_close(uuid) to authenticated, service_role;
grant execute on function public.session_close_all() to authenticated, service_role;

commit;
