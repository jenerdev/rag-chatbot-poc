-- schema-stay-outcome.sql — what a guest reads when their stay can no
-- longer go ahead, and the refusal that matches it.
--
-- Run AFTER schema-holds.sql. The 25th file. Idempotent.
--
--   stay_taken()          a PENDING stay whose dates another stay has taken
--                         since it was made (confirmed, or a live hold:
--                         booking_takes(), the ONE taken test). A request
--                         holds nothing (D-070), so this happens; staff then
--                         cannot confirm it (bookings_no_overlap). Returns
--                         the first clash in words, or null.
--   payments_refuse_taken a guest cannot send a proof of payment for such a
--                         stay: 55000 in words, as submit_payment()'s own
--                         refusals are. A BEFORE INSERT trigger, so
--                         submit_payment() is not redefined.
--   guest_stay()          REPLACED with three keys more: decision_note (why
--                         it ended), declined (cancelled before it was ever
--                         confirmed) and taken (stay_taken()'s words). Its
--                         older definition in schema-manage-booking.sql is
--                         GUARDED on stay_taken(), so re-running that file
--                         cannot put the older one back (CLAUDE.md trap 20).
--
-- The decision note is the staff's own (D-096). It was shown to staff only;
-- from here the guest reads it too, and the staff dialogs say so.

-- 1. The first clash of a pending stay, in words, or null. Reads other
--    groups' rows, so it runs inside definer functions only.
-- GUARDED (room types, D-133): schema-room-counts.sql replaces
-- stay_taken() with versions that count rooms. Once it has run, a re-run
-- of this file must not put these back (trap 20).
do $guard$
begin
  if to_regprocedure('public.room_for(bigint, bigint, uuid, date, tstzrange, bigint)') is null then
    execute $ddl$
create or replace function stay_taken(p_tenant_id bigint, p_group_id uuid)
returns text
language sql
stable
set search_path = ''
as $$
  select format('%s is no longer free on %s: %s.',
                u.name,
                to_char(b.booked_date, 'FMDy, FMDD Mon YYYY'),
                case when o.status = 'confirmed' then 'another booking was confirmed for it'
                     else 'it is held for another guest' end)
  from public.bookings b
  join public.bookings o
    on o.tenant_id = b.tenant_id
   and o.unit_id   = b.unit_id
   and o.group_id is distinct from b.group_id
   and o.during && b.during
   and public.booking_takes(o.status, o.held, o.held_until)
  join public.units u on u.tenant_id = b.tenant_id and u.id = b.unit_id
  where b.tenant_id = p_tenant_id and b.group_id = p_group_id and b.status = 'pending'
  order by b.booked_date, (o.status = 'confirmed') desc, u.name
  limit 1
$$;
$ddl$;
  end if;
end
$guard$;
revoke all on function stay_taken(bigint, uuid) from public, anon, authenticated;

-- 2. No proof for a stay that can no longer be confirmed. Payments only
--    (a refund is staff's, and a refund is exactly what such a stay may need).
create or replace function payments_refuse_taken() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_words text;
begin
  if new.kind <> 'payment' or public.stay_status(new.tenant_id, new.group_id) <> 'pending' then
    return new;
  end if;
  v_words := public.stay_taken(new.tenant_id, new.group_id);
  if v_words is not null then
    raise exception '% This request can no longer be confirmed, so it takes no payment.', v_words
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  return new;
end;
$$;
revoke all on function payments_refuse_taken() from public, anon, authenticated;
drop trigger if exists payments_refuse_taken on payments;
create trigger payments_refuse_taken
  before insert on payments
  for each row execute function payments_refuse_taken();

-- 3. guest_stay(), as schema-manage-booking.sql § 16 has it, plus
--    decision_note, declined and taken.
-- GUARDED (D-147, 2026-10-26): schema-free-guests.sql replaces this with 'free' on each room line.
-- Once that file has run, re-running THIS file must not put a body with no
-- free count back, so the definition is skipped (CLAUDE.md trap 20).
do $guard$
begin
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'bookings' and column_name = 'free_guests') then
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
    -- schema-stay-outcome.sql: why a stay ended, in the staff's words (a
    -- decline's or cancel's note, "Not paid in time"); null while it is live.
    'decision_note', case when public.stay_is_due(p_tenant_id, v_group) then 'Not paid in time'
                          when v_status in ('cancelled', 'expired') then max(b.decision_note) end,
    -- cancelled before it was ever confirmed: the guest reads "Declined".
    'declined',    v_status = 'cancelled' and not exists (
                     select 1 from public.booking_events e
                     where e.tenant_id = p_tenant_id and e.group_id = v_group and e.to_value = 'confirmed'),
    -- a pending stay whose dates another stay has taken since (stay_taken()):
    -- it can no longer be confirmed, so it takes no payment. Null otherwise.
    'taken',       case when v_status = 'pending' and not public.stay_is_due(p_tenant_id, v_group)
                        then public.stay_taken(p_tenant_id, v_group) end,
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

notify pgrst, 'reload schema';
