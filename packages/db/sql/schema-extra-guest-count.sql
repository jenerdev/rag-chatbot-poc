-- schema-extra-guest-count.sql — the 46th file (D-154): a stored booking keeps
-- HOW MANY guests its extra-guest fee was for, beside the fee itself, so the
-- price breakdown can say "2 extra guests" on the booking page's receipt,
-- Manage booking (S-13) and the staff's stay page (S-15).
--
-- The count is unit_quote()'s `extra_guests`, the same row the fee comes from
-- (extra-guests Rule 1: ONE function makes every price, and its parts). It is
-- STORED, not worked out on read from the unit's standard capacity: staff may
-- change that standard later, and a stay must keep saying what it was charged
-- for, exactly as base_price and extra_guest_price do.
--
-- bookings_compute_during() is NOT replaced (traps 20 and 25: it has five
-- definitions in five files). A companion BEFORE trigger,
-- bookings_compute_extra_guests, fires right after it (triggers of one timing
-- fire in name order: "..._during" < "..._extra_guests") and follows its rule:
-- a row that did not move, with the same guests and promo, keeps what it
-- stored; otherwise the count comes from the same unit_quote() call, so it
-- always matches the extra_guest_price beside it. A direct write of the
-- column is ignored the same way.
--
-- It REPLACES guest_stay() from schema-free-guests.sql, whose step 5 is now
-- GUARDED on this file's marker, the column bookings.extra_guests (trap 20).
--
-- Idempotent, and safe to re-run IN ORDER (trap 25).

begin;

-- 1. The column. Null = unknown (a row with no price, or a backfill that could
--    not tell); a screen then names the fee without a number.
alter table public.bookings add column if not exists extra_guests int;
alter table public.bookings drop constraint if exists bookings_extra_guests_range;
alter table public.bookings add  constraint bookings_extra_guests_range check (extra_guests >= 0);

-- 2. The backfill, BEFORE the trigger exists: the trigger's keep-what-it-stored
--    branch would turn this update back into a no-op. Dropped first so a
--    re-run backfills too. Every UPDATE trigger without a column list
--    (bookings_clear_hold, bookings_confirm_needs_payment_or_note,
--    bookings_log_status) acts on a status change only, so this writes no
--    event; bookings has no audit trigger (D-138).
--    The stored fee is the truth; the unit's CURRENT settings are used only
--    when they reproduce it exactly, else the fee ÷ the current rate when that
--    divides evenly, else null. No fee = 0 extra guests.
drop trigger if exists bookings_compute_extra_guests on public.bookings;

update public.bookings b
set extra_guests = case
      when b.extra_guest_price = 0 then 0
      when u.standard_capacity is not null and u.extra_person_rate > 0 and b.guest_count is not null
           and greatest(0, b.guest_count - u.standard_capacity) * u.extra_person_rate = b.extra_guest_price
        then greatest(0, b.guest_count - u.standard_capacity)
      when u.extra_person_rate > 0 and b.extra_guest_price % u.extra_person_rate = 0
        then (b.extra_guest_price / u.extra_person_rate)::int
    end
from public.units u
where u.tenant_id = b.tenant_id and u.id = b.unit_id
  and b.extra_guest_price is not null and b.extra_guests is null;

-- 3. The companion trigger.
create or replace function public.bookings_compute_extra_guests() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- bookings_compute_during()'s own keep test, word for word: what it kept,
  -- this keeps.
  if tg_op = 'UPDATE'
     and new.unit_id = old.unit_id and new.slot_id = old.slot_id and new.booked_date = old.booked_date
     and new.guest_count is not distinct from old.guest_count
     and new.promo_id is not distinct from old.promo_id then
    new.extra_guests := old.extra_guests;
    return new;
  end if;

  if new.extra_guest_price is null then
    new.extra_guests := null;
    return new;
  end if;

  -- The call bookings_compute_during() just made, in the same statement, so
  -- the count is the one its fee was computed from.
  select q.extra_guests into new.extra_guests
  from public.unit_quote(new.tenant_id, new.unit_id, new.slot_id, new.booked_date, new.guest_count) q;
  return new;
end;
$$;

create trigger bookings_compute_extra_guests
  before insert or update of tenant_id, unit_id, slot_id, booked_date, guest_count, promo_id, extra_guest_price, extra_guests
  on public.bookings
  for each row execute function public.bookings_compute_extra_guests();

-- 4. guest_stay(): price.extra_guest_count, the extra guests a NIGHT (every
--    room of the stay together), for Manage booking's "2 extra guests ×
--    3 nights". Null when any row's count is unknown, or the nights differ
--    (never so far: a stay books the same rooms and guests every night).
--    The rest is schema-free-guests.sql's.
create or replace function public.guest_stay(p_tenant_id bigint, p_reference text, p_contact text)
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
                     'extra_guest_count',
                       case when bool_and(b.extra_guests is not null)
                                 and sum(b.extra_guests) % nullif(count(distinct b.booked_date), 0) = 0
                            then sum(b.extra_guests) / nullif(count(distinct b.booked_date), 0) end,
                     'surcharge',    sum(b.surcharge),
                     'discount',     sum(b.discount),
                     'total',        sum(b.price)),
    'rooms',       (select jsonb_agg(r order by r ->> 'unit', r ->> 'slot')
                    from (select distinct jsonb_build_object('unit', u.name, 'slot', sl.name, 'guests', b2.guest_count, 'free', b2.free_guests) as r
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

commit;

-- PostgREST caches the schema: without this the new column stays invisible
-- to .from().
notify pgrst, 'reload schema';
