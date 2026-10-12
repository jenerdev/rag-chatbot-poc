-- schema-notifications.sql — the 29th file (plan/notifications.md, D-116).
--
-- Staff hear about what waits on them on their own devices: a guest's
-- booking request, a proof of payment, a change request. Two tables, one
-- trigger, two definer functions:
--
--   push_subscriptions   one row per (tenant, member, device): where to send
--   notification_outbox  one row per event worth telling, filled by a trigger
--   booking_events_notify  AFTER INSERT on booking_events: the ONE source (Rule 1)
--   notify_claim()       the drain's read: claim this tenant's unsent rows,
--                        joined to the members who may hear them NOW (Rule 3)
--   notify_done()        the drain's write: what each push service answered
--
-- Run after schema-manage-booking.sql (booking_events, its kinds) and
-- schema-roles.sql (memberships.role). Idempotent: every object is created
-- if missing or replaced.
--
-- Every function: set search_path = '' and every name qualified (trap 19).

-- 1. push_subscriptions -------------------------------------------------------
--    A Web Push subscription is a URL the server will POST to and two keys
--    the payload is encrypted with (RFC 8291). Per member AND tenant: the
--    foreign key to memberships means a removed member's devices go with
--    the membership, at once (Rule 3).

create table if not exists public.push_subscriptions (
  id          bigint      generated always as identity primary key,
  tenant_id   bigint      not null,
  -- The token's own user: a route never says whose device it is (and the
  -- insert policy would refuse anyone else's).
  user_id     uuid        not null default auth.uid(),
  endpoint    text        not null unique,
  p256dh      text        not null,
  auth        text        not null,
  kinds       text[]      not null default '{request,proof,change}',
  user_agent  text,
  created_at  timestamptz not null default now(),
  last_ok_at  timestamptz,
  failures    int         not null default 0,
  constraint push_subscriptions_member_fk foreign key (user_id, tenant_id)
    references public.memberships (user_id, tenant_id) on delete cascade,
  -- https only, and short: the drain POSTs to it (the route also checks the host).
  constraint push_subscriptions_endpoint check (endpoint like 'https://%' and length(endpoint) <= 1000),
  -- base64url keys of the sizes the browser hands out: a P-256 point (65
  -- bytes → 87 characters) and a 16-byte secret (22), padding tolerated.
  constraint push_subscriptions_p256dh check (p256dh ~ '^[A-Za-z0-9_-]{86,88}=?$'),
  constraint push_subscriptions_auth check (auth ~ '^[A-Za-z0-9_-]{21,24}={0,2}$'),
  constraint push_subscriptions_kinds check (cardinality(kinds) between 1 and 3 and kinds <@ array['request', 'proof', 'change']),
  constraint push_subscriptions_user_agent check (user_agent is null or length(user_agent) <= 200)
);
create index if not exists push_subscriptions_member_idx on public.push_subscriptions (tenant_id, user_id);

alter table public.push_subscriptions enable row level security;
-- A member sees, adds and removes ONLY their own devices, in the token's
-- tenant. No update policy: changing the kinds is delete + insert, so a
-- row never moves to another member or tenant.
drop policy if exists push_subscriptions_read on public.push_subscriptions;
create policy push_subscriptions_read on public.push_subscriptions for select to authenticated
  using (user_id = (select auth.uid()) and tenant_id = (select public.app_tenant_id()) and (select public.app_is_staff()));
drop policy if exists push_subscriptions_insert on public.push_subscriptions;
create policy push_subscriptions_insert on public.push_subscriptions for insert to authenticated
  with check (user_id = (select auth.uid()) and tenant_id = (select public.app_tenant_id()) and (select public.app_is_staff()));
drop policy if exists push_subscriptions_delete on public.push_subscriptions;
create policy push_subscriptions_delete on public.push_subscriptions for delete to authenticated
  using (user_id = (select auth.uid()) and tenant_id = (select public.app_tenant_id()) and (select public.app_is_staff()));

-- 2. notification_outbox --------------------------------------------------------
--    One row per event worth telling. No policy for any token: the trigger
--    writes it (definer), notify_claim() reads it (definer). The payload is
--    ONLY these named fields (Rule 2): no guest name, phone, email or amount.

create table if not exists public.notification_outbox (
  id           bigint      generated always as identity primary key,
  tenant_id    bigint      not null references public.tenants (id) on delete cascade,
  event_id     bigint      not null references public.booking_events (id) on delete cascade,
  kind         text        not null,
  reference    text        not null,
  first_night  date,
  nights       int,
  created_at   timestamptz not null default now(),
  claimed_at   timestamptz,
  sent_at      timestamptz,
  attempts     int         not null default 0,
  constraint notification_outbox_kind check (kind in ('request', 'proof', 'change')),
  constraint notification_outbox_event_unique unique (event_id)
);
create index if not exists notification_outbox_unsent_idx on public.notification_outbox (tenant_id, id) where sent_at is null;

alter table public.notification_outbox enable row level security;
revoke all on public.notification_outbox from anon, authenticated;

-- 3. booking_events_notify --------------------------------------------------------
--    The event log is the one source (Rule 1): a route never "also sends a
--    push". Only what waits on staff is news (§ 2b.7):
--      created, by a guest, pending        a web request (one event per stay)
--      payment, payment:submitted, new     a proof sent
--      change, <kind>:pending, new         a guest asks to cancel or move
--    Staff's own stays and decisions, the expiry sweep (system) and refunds
--    are not. Reads NEW and the stay's rows; writes only the outbox.

create or replace function public.booking_events_notify() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_kind text;
  v_reference text;
  v_first date;
  v_nights int;
begin
  v_kind := case
    when new.kind = 'created' and new.actor_kind = 'guest' and new.to_value = 'pending' then 'request'
    when new.kind = 'payment' and new.from_value is null and new.to_value = 'payment:submitted' then 'proof'
    when new.kind = 'change' and new.from_value is null and new.to_value like '%:pending' then 'change'
  end;
  if v_kind is null then
    return null;
  end if;

  select s.reference into v_reference
  from public.stays s where s.tenant_id = new.tenant_id and s.group_id = new.group_id;
  -- The stay's nights as they stand: the live rows, else any (a stay whose
  -- every row was declined still has dates to name).
  select min(b.booked_date), count(distinct b.booked_date)::int into v_first, v_nights
  from public.bookings b
  where b.tenant_id = new.tenant_id and b.group_id = new.group_id and b.status in ('pending', 'confirmed');
  if v_first is null then
    select min(b.booked_date), count(distinct b.booked_date)::int into v_first, v_nights
    from public.bookings b where b.tenant_id = new.tenant_id and b.group_id = new.group_id;
  end if;

  insert into public.notification_outbox (tenant_id, event_id, kind, reference, first_night, nights)
  values (new.tenant_id, new.id, v_kind, coalesce(v_reference, '?'), v_first, v_nights)
  on conflict (event_id) do nothing;
  return null;
end;
$$;
revoke all on function public.booking_events_notify() from public, anon, authenticated;

drop trigger if exists booking_events_notify on public.booking_events;
create trigger booking_events_notify after insert on public.booking_events
  for each row execute function public.booking_events_notify();

-- 4. notify_claim(p_tenant_id) ----------------------------------------------------
--    The drain runs on whatever token the request has: a guest's CHAT token
--    (book/request, a proof, a change) or a staff token (the attention poll,
--    the sweep). Neither may read another member's subscriptions, so this is
--    a definer (§ 2b.8). It
--      - refuses a tenant that is not the token's (wall 2);
--      - claims up to 50 unsent rows of THAT tenant (skip locked: two drains
--        never take the same row; a claim older than 5 minutes is a crashed
--        drain's and is taken again; 5 attempts, then dropped);
--      - marks a claimed row with nobody to tell as sent at once;
--      - returns each claimed row joined to the members who may hear it NOW,
--        asked from the membership row at send time (Rule 3): request and
--        change → every role (bookings:write); proof → owner and admin
--        (payments:write). lib/permissions.ts says the same, and a test
--        checks the two agree.
--    The keys are useless without the VAPID private key, and a claimed row
--    is consumed, so the function cannot be used to list subscriptions.

create or replace function public.notify_claim(p_tenant_id bigint)
returns table (outbox_id bigint, kind text, reference text, first_night date, nights int,
               subscription_id bigint, endpoint text, p256dh text, auth text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ids bigint[];
begin
  if p_tenant_id is distinct from public.app_tenant_id() then
    raise exception 'notify_claim: not this tenant''s token' using errcode = 'insufficient_privilege';
  end if;

  -- Older than a push may live (TTL 24 h, § 2b.6): news no longer. Retired
  -- unsent, so a drain that starts late (push configured today) does not
  -- ring every phone with last week's requests.
  update public.notification_outbox o set sent_at = now()
  where o.tenant_id = p_tenant_id and o.sent_at is null and o.created_at < now() - interval '24 hours';

  with picked as (
    select o.id from public.notification_outbox o
    where o.tenant_id = p_tenant_id and o.sent_at is null and o.attempts < 5
      and (o.claimed_at is null or o.claimed_at < now() - interval '5 minutes')
    order by o.id
    limit 50
    for update skip locked
  ), claimed as (
    update public.notification_outbox o set claimed_at = now(), attempts = o.attempts + 1
    from picked where o.id = picked.id
    returning o.id
  )
  select coalesce(array_agg(claimed.id), '{}') into v_ids from claimed;

  -- Who may hear each claimed row, now.
  return query
  select o.id, o.kind, o.reference, o.first_night, o.nights, s.id, s.endpoint, s.p256dh, s.auth
  from public.notification_outbox o
  join public.push_subscriptions s on s.tenant_id = o.tenant_id and o.kind = any (s.kinds)
  join public.memberships m on m.tenant_id = s.tenant_id and m.user_id = s.user_id
  where o.id = any (v_ids)
    and (o.kind in ('request', 'change') or (o.kind = 'proof' and m.role in ('owner', 'admin')))
  order by o.id, s.id;

  -- Nobody to tell: done now, not claimed again every 5 minutes.
  update public.notification_outbox o set sent_at = now()
  where o.id = any (v_ids) and not exists (
    select 1 from public.push_subscriptions s
    join public.memberships m on m.tenant_id = s.tenant_id and m.user_id = s.user_id
    where s.tenant_id = o.tenant_id and o.kind = any (s.kinds)
      and (o.kind in ('request', 'change') or (o.kind = 'proof' and m.role in ('owner', 'admin'))));
end;
$$;
revoke all on function public.notify_claim(bigint) from public, anon;
grant execute on function public.notify_claim(bigint) to authenticated;

-- 5. notify_done(p_results) ---------------------------------------------------------
--    [{ "outbox": 1, "subscription": 2, "result": "ok" | "gone" | "retry" }]
--    ok     the subscription answered: last_ok_at, failures 0
--    gone   404/410: the device unsubscribed; its row is deleted (§ 2b.6)
--    retry  429/5xx: failures + 1; the outbox row is released for the next
--           drain (its attempts were counted by the claim)
--    An outbox row whose recipients all answered ok or gone is sent. Only
--    rows of the token's tenant that are claimed are touched.

create or replace function public.notify_done(p_results jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant bigint := public.app_tenant_id();
begin
  if v_tenant is null then
    raise exception 'notify_done: no tenant in the token' using errcode = 'insufficient_privilege';
  end if;
  if jsonb_typeof(p_results) is distinct from 'array' then
    raise exception 'notify_done: results must be an array' using errcode = '22023';
  end if;

  with r as (
    select (x->>'outbox')::bigint as outbox_id, (x->>'subscription')::bigint as subscription_id, x->>'result' as result
    from jsonb_array_elements(p_results) x
  ), ok as (
    update public.push_subscriptions s set last_ok_at = now(), failures = 0
    from r where r.result = 'ok' and s.id = r.subscription_id and s.tenant_id = v_tenant
    returning s.id
  ), bad as (
    update public.push_subscriptions s set failures = s.failures + 1
    from r where r.result = 'retry' and s.id = r.subscription_id and s.tenant_id = v_tenant
    returning s.id
  )
  delete from public.push_subscriptions s
  using r where r.result = 'gone' and s.id = r.subscription_id and s.tenant_id = v_tenant;

  -- Sent: every answer for the row was ok or gone. Retried: released.
  update public.notification_outbox o
  set sent_at = case when bool_and_ok then now() else o.sent_at end,
      claimed_at = case when bool_and_ok then o.claimed_at else null end
  from (
    select (x->>'outbox')::bigint as outbox_id, bool_and(x->>'result' in ('ok', 'gone')) as bool_and_ok
    from jsonb_array_elements(p_results) x
    group by 1
  ) agg
  where o.id = agg.outbox_id and o.tenant_id = v_tenant and o.claimed_at is not null and o.sent_at is null;
end;
$$;
revoke all on function public.notify_done(jsonb) from public, anon;
grant execute on function public.notify_done(jsonb) to authenticated;

notify pgrst, 'reload schema';
