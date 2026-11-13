-- schema-notify-drain.sql — the 50th file. Audit S-10, D-166.
--
-- The notification drain (D-116) runs on the server right after a guest's
-- request, and it used to run on THAT request's chat token: notify_claim()
-- and notify_done() accepted any token of the tenant. So a chat token, were
-- one ever to leak (they never leave the server, and live 5 minutes), could
-- claim the queue so no staff phone rang (a claim is retried after 5
-- minutes, dropped after 5 attempts) and report staff devices "gone", which
-- deletes their push subscriptions.
--
-- Now both functions demand the drain's OWN token: mintTenantToken({
-- tenantId, notifier: true }) (packages/db/src/tenant-client.ts), a tenant,
-- no user, and the claim `app_notifier`. Only notifierClient() mints it, and
-- only the drain (apps/web/lib/notify.ts) calls that. A chat token and a
-- staff token are refused (42501). Everything else in both bodies is
-- schema-notifications.sql's, unchanged.
--
-- The comments on the two functions are this file's MARKER: the older
-- definitions in schema-notifications.sql are skipped when it is there
-- (CLAUDE.md trap 20). Idempotent.

begin;

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
  -- D-166 (audit S-10): only the drain's own token. A chat token (minted
  -- for every guest request) and a staff token are refused, so a leaked one
  -- cannot take notifications off the queue or delete staff devices.
  if not coalesce((auth.jwt() ->> 'app_notifier')::boolean, false) then
    raise exception '%: only the notification drain may call this', 'notify_claim' using errcode = 'insufficient_privilege';
  end if;
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

comment on function public.notify_claim(bigint) is 'schema-notify-drain.sql (D-166): the drain''s token only (app_notifier).';
revoke all on function public.notify_claim(bigint) from public, anon;
grant execute on function public.notify_claim(bigint) to authenticated;

create or replace function public.notify_done(p_results jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant bigint := public.app_tenant_id();
begin
  -- D-166 (audit S-10): only the drain's own token. A chat token (minted
  -- for every guest request) and a staff token are refused, so a leaked one
  -- cannot take notifications off the queue or delete staff devices.
  if not coalesce((auth.jwt() ->> 'app_notifier')::boolean, false) then
    raise exception '%: only the notification drain may call this', 'notify_done' using errcode = 'insufficient_privilege';
  end if;
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

comment on function public.notify_done(jsonb) is 'schema-notify-drain.sql (D-166): the drain''s token only (app_notifier).';
revoke all on function public.notify_done(jsonb) from public, anon;
grant execute on function public.notify_done(jsonb) to authenticated;

commit;
