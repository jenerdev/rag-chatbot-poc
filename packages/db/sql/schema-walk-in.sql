-- schema-walk-in.sql — a staff booking can say the guest walked in (D-111).
--
-- Run AFTER schema-stay-outcome.sql. The 26th file. Idempotent. Replaces
-- no function.
--
--   bookings.walk_in   what the staff form sent, on every row it inserts.
--                      Only a staff row may say it (bookings_walk_in): the
--                      booking page's request_booking() never does.
--   stays.walk_in      the STAY's label, the one every screen reads. It is
--                      on the stay because a reschedule (decide_change())
--                      inserts new booking rows into the SAME stay and does
--                      not copy this column; the stay keeps the label.
--   bookings_ac_walk_in  copies the row's flag to its stay. BEFORE INSERT,
--                      named to run right after bookings_ab_ensure_stay
--                      (name order), so the stay row already exists.
--                      SECURITY DEFINER, like bookings_ensure_stay(), so no
--                      token needs an update policy on `stays`.
--
-- A label only: a walk-in is born pending and paid like any stay (D-095,
-- D-105). Nothing reads it to decide anything.

-- 1. The two columns. Every existing row was not a walk-in.
alter table bookings add column if not exists walk_in boolean not null default false;
alter table bookings drop constraint if exists bookings_walk_in;
alter table bookings add constraint bookings_walk_in check (not walk_in or source = 'staff');

alter table stays add column if not exists walk_in boolean not null default false;

-- 2. The row's flag reaches its stay. Only ever sets true: a stay that a
--    walk-in started stays one, and no later insert into it unsets that.
create or replace function bookings_mark_walk_in() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.walk_in then
    update public.stays s set walk_in = true
    where s.tenant_id = new.tenant_id and s.group_id = new.group_id and not s.walk_in;
  end if;
  return new;
end;
$$;
revoke all on function bookings_mark_walk_in() from public, anon, authenticated;
drop trigger if exists bookings_ac_walk_in on bookings;
create trigger bookings_ac_walk_in
  before insert on bookings
  for each row execute function bookings_mark_walk_in();
