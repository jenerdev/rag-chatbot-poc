-- schema-platform-rate-limit.sql — the 47th file. Audit S-2 / B-4, D-157.
--
-- The super user's login and "Forgot password?" (/api/platform/session and
-- /api/platform/password-reset) had no limit at all. The tenant doors use
-- rate_allow() (schema-rate-limit.sql, D-137), but that function demands a
-- token with a TENANT, and the platform's two doors run before anyone is
-- signed in, for no tenant: the server has only the publishable key there.
--
--   platform_rate_windows   ONE row per (key, window). No policy and no
--                           grant for any role: only the function below
--                           reads or writes it.
--   platform_rate_allow()   rate_allow()'s one statement, without a tenant.
--
-- The caller is ANON (the publishable key, no token), because nothing else
-- exists before a login. The publishable key is public, so anyone can call
-- this function directly; it is shaped so that a direct call can do nothing
-- the login route does not already do:
--   - the key must be 'platform-login|<sha256 hex>' or
--     'platform-reset|<sha256 hex>': no free text, no email, no address in
--     the table, only hashes the server made (lib/rate-limit.ts);
--   - p_max and p_window_seconds are bounded; p_max only decides the answer;
--   - every call sweeps windows older than two windows, so the table holds
--     at most twenty minutes of keys.
-- Bumping a key by hand counts toward that key's limit, exactly as calling
-- the route with that email or from that address would.
--
-- security definer, set search_path = '' and every name qualified (trap 19).
-- Idempotent; replaces nothing an earlier file made.

begin;

create table if not exists public.platform_rate_windows (
  key          text        not null,
  window_start timestamptz not null,
  count        int         not null default 1,
  primary key (key, window_start),
  constraint platform_rate_windows_key check (key ~ '^platform-(login|reset)\|[0-9a-f]{64}$')
);

create index if not exists platform_rate_windows_sweep_idx on public.platform_rate_windows (window_start);

alter table public.platform_rate_windows enable row level security;
revoke all on public.platform_rate_windows from public, anon, authenticated;

create or replace function public.platform_rate_allow(p_key text, p_max int, p_window_seconds int)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_window interval;
  v_count  int;
begin
  if p_key is null or p_key !~ '^platform-(login|reset)\|[0-9a-f]{64}$' then
    raise exception 'platform_rate_allow: not a platform key' using errcode = 'invalid_parameter_value';
  end if;
  if p_max is null or p_max < 1 or p_max > 1000 or p_window_seconds is null or p_window_seconds < 60 or p_window_seconds > 86400 then
    raise exception 'platform_rate_allow: max or window out of bounds' using errcode = 'invalid_parameter_value';
  end if;
  v_window := make_interval(secs => p_window_seconds);

  delete from public.platform_rate_windows w where w.window_start < now() - 2 * v_window;

  insert into public.platform_rate_windows as w (key, window_start, count)
  values (p_key, date_bin(v_window, now(), '2000-01-01 00:00:00+00'::timestamptz), 1)
  on conflict (key, window_start) do update set count = w.count + 1
  returning w.count into v_count;

  return v_count <= p_max;
end;
$$;

revoke all on function public.platform_rate_allow(text, int, int) from public;
grant execute on function public.platform_rate_allow(text, int, int) to anon, authenticated, service_role;

commit;
