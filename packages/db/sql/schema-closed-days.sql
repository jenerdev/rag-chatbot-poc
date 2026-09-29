-- schema-closed-days.sql — dates the business is closed (D-080).
--
-- Run AFTER schema-roles.sql. Safe to re-run: every step drops what it
-- creates first. It replaces NO earlier function, so re-running an older
-- file cannot undo it (CLAUDE.md trap 20), and no earlier file needs a guard.
--
-- A closed date is a row in the holiday calendar with kind 'closed'. The
-- calendar already has what a closed date needs: one row per (tenant, day)
-- that applies to every unit, any token of the tenant reads it (the booking
-- page shows it), and only its admins write it (schema-customer-booking.sql
-- § 13). So there is no new table and no new policy.
--
-- It closes the WHOLE property for every slot that STARTS on that date. An
-- Overnight that starts the evening before ends on the closed morning, and
-- is allowed: `booked_date` is the date a slot starts on, in the tenant's
-- timezone, everywhere in this schema.
--
-- The two walls, as always (D-038):
--   wall 1, the code: @rag/bookings refuses a closed date before it writes,
--           and reports it as 'closed' in every availability read;
--   wall 2, Postgres: the two triggers below. They hold alone: a staff token,
--           a chat token through request_booking(), and service_role all meet
--           them.
--
-- Closed is closed (D-080): nothing pending or confirmed may land on a
-- closed date, from anyone, and a date with a confirmed booking cannot be
-- closed. To take a booking on a closed date, reopen the date first.

-- 1. The kind. A closed date has no surcharge: nothing is sold on it.
alter table rate_calendar drop constraint if exists rate_calendar_kind;
alter table rate_calendar add  constraint rate_calendar_kind check (kind in ('holiday', 'peak', 'closed'));
alter table rate_calendar drop constraint if exists rate_calendar_closed_no_surcharge;
alter table rate_calendar add  constraint rate_calendar_closed_no_surcharge check (kind <> 'closed' or surcharge = 0);

-- 2. ONE lock per tenant, taken by both triggers below, so a closure and a
--    booking on the same day cannot both pass their checks at once. Without
--    it, each transaction would read the other's row as not there yet, both
--    would commit, and a confirmed booking would sit on a closed date (write
--    skew; "check, then insert" is CLAUDE.md trap 8). The lock is held to the
--    end of the transaction, and each trigger's query runs AFTER it is taken,
--    so under READ COMMITTED it sees whatever the other one committed.
--
--    Taken only by a write that could clash (a closure, or a pending or
--    confirmed booking), so a cancel never waits.
--
--    The key is 'closed_days:<tenant id>', hashed. It is written out in both
--    triggers rather than in a helper function: the triggers run as the
--    caller, so a helper would need EXECUTE for every token, and then any
--    chat token could take the lock through PostgREST.

-- 3. A date with a confirmed booking cannot be closed (D-080). The message
--    counts them, so staff know what to cancel or move.
--
--    Runs as the caller, NOT security definer: only admins can write the
--    calendar (its policies), and admins read every booking of their tenant
--    (bookings_read, app_is_staff()). A caller that could not see the
--    bookings could not have written the row either.
--
--    Pending requests do not block a closure: they hold nothing (D-070), and
--    step 4 stops them being confirmed. Staff decline them.
create or replace function rate_calendar_closed_check() returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_confirmed int;
begin
  if new.kind <> 'closed' then
    return new;
  end if;
  perform pg_advisory_xact_lock(hashtextextended('closed_days:' || new.tenant_id, 0));

  select count(*) into v_confirmed
  from public.bookings b
  where b.tenant_id = new.tenant_id
    and b.booked_date = new.day
    and b.status = 'confirmed';
  if v_confirmed > 0 then
    raise exception '% has % confirmed booking(s); cancel or move them before closing the date', new.day, v_confirmed
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists rate_calendar_closed_check on rate_calendar;
create trigger rate_calendar_closed_check
  before insert or update of kind, day on rate_calendar
  for each row execute function rate_calendar_closed_check();

-- 4. Nothing pending or confirmed lands on a closed date (D-080): a staff
--    booking, a customer request through request_booking(), and a request
--    confirmed on the Bookings screen all meet this.
--
--    A cancel (status → cancelled) is always allowed, so staff can clear a
--    closed date of old requests. It fires on the columns that move a row
--    onto a date or into a live status.
--
--    Runs as the caller. Every caller that writes bookings reads the
--    calendar: rate_calendar_read is any token of the tenant, and
--    request_booking() is security definer, which runs as the table owner.
--    `search_path = ''`: fired from inside request_booking() it inherits an
--    empty one (CLAUDE.md trap 19).
create or replace function bookings_not_on_closed_day() returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_label text;
begin
  if new.status not in ('pending', 'confirmed') then
    return new;
  end if;
  perform pg_advisory_xact_lock(hashtextextended('closed_days:' || new.tenant_id, 0));

  select c.label into v_label
  from public.rate_calendar c
  where c.tenant_id = new.tenant_id
    and c.day = new.booked_date
    and c.kind = 'closed';
  if found then
    raise exception 'closed on %: %', new.booked_date, v_label
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists bookings_not_on_closed_day on bookings;
create trigger bookings_not_on_closed_day
  before insert or update of tenant_id, booked_date, status on bookings
  for each row execute function bookings_not_on_closed_day();

-- 5. No EXECUTE grants: a trigger function is never called by name, and
--    pg_advisory_xact_lock is callable by everyone already.

notify pgrst, 'reload schema';

-- Verify:  pnpm --filter @rag/bookings rooms   (checks 30–33: closed dates)
