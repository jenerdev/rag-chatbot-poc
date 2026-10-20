-- schema-rate-limit.sql — the 42nd file. plan/rate-limit.md Phase 1, D-137.
--
-- The per-IP window on the open routes (a booking request, a Manage booking
-- lookup, a voice call and, since this file, a chat turn) used to live in a
-- Map inside apps/web/lib/rate-limit.ts: per server PROCESS, so every Vercel
-- instance kept its own count and a sender spread across instances got
-- several allowances (R-39). This file moves the count here, where there is
-- exactly one of it.
--
--   rate_windows   ONE row per (tenant, key, window). No policy for any
--                  token: only rate_allow() reads and writes it (Rule 2).
--   rate_allow()   bump this key's current window and say whether the call
--                  is inside the limit. ONE statement does both (Rule 1):
--                  an insert … on conflict do update … returning count, so
--                  two instances bumping the same key at once both see the
--                  true count — the row lock serialises them. There is no
--                  "read the count, then write it" (CLAUDE.md trap 8).
--
-- The window is a fixed one: date_bin(window, now(), a fixed origin), so
-- every instance computes the same window_start for the same instant (§ 2.4).
-- The function sweeps the TENANT's windows older than two windows before it
-- bumps, so a one-off visitor's row is gone the next time anyone on that
-- tenant is counted (§ 2.3; per key, a visitor who never returned would stay
-- forever); nothing here is a person's data for longer than twenty minutes.
--
-- security definer, because the caller is a CHAT token (no sub, a tenant
-- claim) and the table has no policy; set search_path = '' and every name
-- qualified (trap 19); it checks the token's tenant itself, like
-- notify_claim(). The thirteenth callable definer function.
--
-- Idempotent and safe to re-run in order (trap 25): it replaces nothing an
-- earlier file made.

begin;

-- 1. The count.
create table if not exists public.rate_windows (
  tenant_id    bigint      not null references public.tenants (id) on delete cascade,
  -- 'chat|<tenant>|<ip>', 'voice-in|…', 'voice-out|…', 'manage|…', '<tenant>|<ip>' (the booking request's,
  -- the first one, unprefixed). The code builds it; the function never parses it.
  key          text        not null,
  window_start timestamptz not null,
  count        int         not null default 1,
  primary key (tenant_id, key, window_start),
  constraint rate_windows_key check (length(key) between 1 and 200)
);
-- The sweep's index: the tenant's stale rows by age, without reading its live ones.
create index if not exists rate_windows_sweep_idx on public.rate_windows (tenant_id, window_start);
alter table public.rate_windows enable row level security;
revoke all on public.rate_windows from public, anon, authenticated;

-- 2. Bump and judge.
create or replace function public.rate_allow(p_tenant_id bigint, p_key text, p_max int, p_window_seconds int)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_window interval := make_interval(secs => p_window_seconds);
  v_count  int;
begin
  -- Wall 2: the id the route sent (wall 1) must be the token's own.
  if p_tenant_id is distinct from public.app_tenant_id() then
    raise exception 'rate_allow: not this tenant''s token' using errcode = 'insufficient_privilege';
  end if;
  if p_max < 1 or p_window_seconds < 1 then
    raise exception 'rate_allow: max and window must be positive' using errcode = 'invalid_parameter_value';
  end if;

  -- The sweep (§ 2.3): this tenant's windows that can no longer be current,
  -- every key's. One indexed delete (rate_windows_sweep_idx), never a scan.
  delete from public.rate_windows w
  where w.tenant_id = p_tenant_id
    and w.window_start < now() - 2 * v_window;

  -- Rule 1: one statement bumps and returns. The origin is fixed (§ 2.4), so
  -- every caller bins the same instant into the same window.
  insert into public.rate_windows as w (tenant_id, key, window_start, count)
  values (p_tenant_id, p_key, date_bin(v_window, now(), '2000-01-01 00:00:00+00'::timestamptz), 1)
  on conflict (tenant_id, key, window_start) do update set count = w.count + 1
  returning w.count into v_count;

  return v_count <= p_max;
end;
$$;

revoke all on function public.rate_allow(bigint, text, int, int) from public, anon;
grant execute on function public.rate_allow(bigint, text, int, int) to authenticated, service_role;

commit;
