-- schema-taken-span.sql — a pending booking cannot be born on a span that
-- is already confirmed (plan/staff-clash.md, D-099).
--
-- Run AFTER schema-dashboard.sql. The 20th file. Safe to re-run: it drops
-- what it creates first, replaces NO earlier definition, and so needs no
-- guard and gives no earlier file one (CLAUDE.md trap 20). No table, no
-- column, no policy.
--
-- Since D-095 a staff booking is born `pending`, and a pending row holds
-- nothing (D-070): bookings_no_overlap covers `confirmed` rows only. So a
-- pending row could be created on a night someone already holds, and the
-- clash surfaced only at Confirm (409). This trigger refuses the INSERT of
-- a pending row whose (unit, span) overlaps a confirmed booking of the same
-- tenant, in words that name the date and the unit, from every door: the
-- staff route, request_booking() (a chat token), a raw insert.
--
-- What it does NOT do (plan Rule 3): two PENDING rows may still share a
-- night; the first one confirmed takes it and the other's Confirm is the
-- 409 it is today. bookings_no_overlap is untouched. And it is BEFORE
-- INSERT only: Confirm is an UPDATE of status, guarded by the constraint.
--
-- The error code is exclusion_violation (23P01), the constraint's own
-- (plan Rule 2), so @rag/bookings' map (23P01 → BookingConflictError) and
-- lib/route.ts's (→ 409) hold unchanged; only the message is new.
--
-- Ordering (plan § 2.2): triggers fire in NAME order, and `during` is
-- filled by bookings_compute_during (BEFORE INSERT). This one is named
-- bookings_pending_not_taken so it sorts after bookings_compute_during and
-- after bookings_not_on_closed_day, and reads a computed `during`. A null
-- `during` is refused outright rather than passed vacuously (trap 12).
--
-- No lock (plan Rule 4): an insert that reads "no confirmed row" while a
-- concurrent Confirm commits one leaves a pending row beside a confirmed
-- one, which is the state the list's `clash` flag and the dashboard's
-- "would clash on Confirm" count already describe, and that row's Confirm
-- answers 409. The window is one statement wide.
--
-- Runs as the CALLER, not security definer: every door that inserts a
-- booking can read the tenant's confirmed bookings (staff by
-- bookings_read; request_booking() is itself definer and reads as such),
-- and search_path is '' with every name qualified (trap 19), because
-- request_booking() runs with ''.

-- 1. The function.
-- GUARDED (manage-booking Phase 5, 2026-10-10): schema-holds.sql replaces
-- this with one that asks booking_takes() (a live hold takes a slot too).
-- Once that file has run, re-running THIS file must not put the
-- confirmed-only version back, so the step is skipped (trap 20).
do $guard$
begin
  if to_regprocedure('public.booking_takes(text, boolean, timestamptz)') is null then
    execute $ddl$
create or replace function bookings_pending_not_taken() returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_unit text;
begin
  if new.status <> 'pending' then
    return new;   -- a confirmed insert is the constraint's to judge; a cancelled one holds nothing
  end if;
  if new.during is null then
    raise exception 'booking on % has no span to check', new.booked_date using errcode = 'exclusion_violation';
  end if;
  select u.name into v_unit from public.units u where u.tenant_id = new.tenant_id and u.id = new.unit_id;
  if exists (
    select 1 from public.bookings c
    where c.tenant_id = new.tenant_id
      and c.unit_id   = new.unit_id
      and c.status    = 'confirmed'
      and c.during && new.during
  ) then
    raise exception 'taken on %: % is already confirmed for that slot', new.booked_date, coalesce(v_unit, 'that unit')
      using errcode = 'exclusion_violation';
  end if;
  return new;
end;
$$
$ddl$;
  end if;
end
$guard$;

-- 2. The trigger. BEFORE INSERT only (see above); for each row, so one
--    clashing room refuses a several-rooms statement whole (plan § 2.3).
drop trigger if exists bookings_pending_not_taken on bookings;
create trigger bookings_pending_not_taken
  before insert on bookings
  for each row execute function bookings_pending_not_taken();

-- Verify:  pnpm --filter @rag/bookings rooms        (plan § 5 Phase 1's five checks)
-- Prove the ordering once, in the SQL editor:
--   select tgname from pg_trigger where tgrelid = 'public.bookings'::regclass and not tgisinternal order by tgname;
--   bookings_compute_during must sort before bookings_pending_not_taken.
