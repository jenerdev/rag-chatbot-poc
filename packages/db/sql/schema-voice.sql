-- schema-voice.sql — the 41st file. plan/voice.md Phase 4, D-134.
--
-- Voice is a feature a super user switches per tenant (D-127), like the
-- other eight, with ONE difference: no row means OFF. It adds cost to every
-- spoken turn and sends the guest's voice to OpenAI, so a tenant gets it
-- only when someone decided it should (plan § 6 q6). apps/web/lib/features.ts
-- says the same with `defaultOn: false`; this file is the database's half.
--
-- Nothing else: voice keeps no table. A recording is never stored, and a
-- spoken question is stored as its words, an ordinary message (Rule 4).
--
-- Safe to re-run IN ORDER (trap 25): both statements replace what
-- schema-features.sql (the 33rd) made, and that file's own re-run would put
-- the old constraint back, so re-apply this one after it.

begin;

-- 1. The ninth key.
alter table public.tenant_features drop constraint if exists tenant_features_key;
alter table public.tenant_features add  constraint tenant_features_key check (feature in (
  'dashboard', 'conversations', 'unanswered', 'suggested_questions',
  'booking_page', 'manage_booking', 'calendar', 'notifications',
  'voice'
));

-- 2. No row = on, except voice: no row = off.
create or replace function public.tenant_feature_on(p_tenant_id bigint, p_feature text) returns boolean
language sql stable
set search_path = ''
as $$
  select coalesce(
    (select f.enabled from public.tenant_features f where f.tenant_id = p_tenant_id and f.feature = p_feature),
    p_feature <> 'voice')
$$;
revoke all on function public.tenant_feature_on(bigint, text) from public, anon;
grant execute on function public.tenant_feature_on(bigint, text) to authenticated, service_role;

commit;
