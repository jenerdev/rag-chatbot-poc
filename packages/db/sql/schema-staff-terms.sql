-- schema-staff-terms.sql — a staff stay is paid for like a web one (D-113).
--
-- Run AFTER schema-walk-in.sql. The 27th file. Idempotent. Replaces no
-- function: bookings_set_terms() (schema-manage-booking.sql) still sets the
-- terms of WEB stays, and this file adds its twin for STAFF stays.
--
--   bookings_set_staff_terms  AFTER INSERT, per statement, like its twin. A
--                       staff stay born while the tenant takes payments
--                       gets the same required_amount (stay_required() over
--                       the stored prices) and, UNLESS it is a walk-in, the
--                       same pay_by. So Manage booking shows "pay by" and
--                       the countdown, stay_is_due() can expire it, and
--                       Confirm with nothing verified needs a note, exactly
--                       as for a web stay.
--   a walk-in           still owes the amount (it is tracked: the guest is
--                       paying at the desk, and staff confirm with a note or
--                       a verified payment) but has no deadline, so it never
--                       expires and shows no countdown.
--
-- Until now a staff stay was never tracked ("a staff stay, a tenant with no
-- payment settings, a row with no price" were the three nulls). Stays born
-- before this file keep their terms (none); nothing is backfilled.
--
-- Not changed: holds. bookings_hold_on_request() holds WEB stays only; a
-- staff member who wants the dates taken confirms the stay.

create or replace function bookings_set_staff_terms() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.stays s
  set required_amount = public.stay_required(t.total, a.config->'payments'->'fee'),
      pay_by = case when not t.walk_in and a.config->'payments' ? 'pay_within_hours'
                    then now() + make_interval(hours => (a.config->'payments'->>'pay_within_hours')::int) end
  from (
    select n.tenant_id, n.group_id, sum(b.price)::bigint as total, bool_or(b.walk_in) as walk_in
    from (select distinct tenant_id, group_id from born where source = 'staff' and status = 'pending') n
    join public.bookings b on b.tenant_id = n.tenant_id and b.group_id = n.group_id
    group by n.tenant_id, n.group_id
  ) t
  join public.tenant_applications a on a.tenant_id = t.tenant_id and a.application_key = 'bookings'
  where s.tenant_id = t.tenant_id and s.group_id = t.group_id
    and s.required_amount is null
    and a.config ? 'payments';
  return null;
end;
$$;
revoke all on function bookings_set_staff_terms() from public, anon, authenticated;
drop trigger if exists bookings_set_staff_terms on bookings;
create trigger bookings_set_staff_terms
  after insert on bookings
  referencing new table as born
  for each statement execute function bookings_set_staff_terms();
