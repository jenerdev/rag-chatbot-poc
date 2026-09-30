-- schema-slots.sql — slots managed by a tenant's owners and admins (D-090).
--
-- Run AFTER schema-suggested-questions.sql. Safe to re-run: every step is
-- `if not exists`, `create or replace`, or drops what it creates first. It
-- replaces NO earlier function, so no older file needs a guard (trap 20).
--
-- Until now slots were "read-only to tokens, seeded by SQL" (schema-auth.sql
-- § 3): no token could write one, and they were added by hand. This file
-- lets a tenant's owners and admins create, edit, retire and delete them,
-- with the two rules the user chose (2026-09-30):
--
--   * a slot's TIMES (start_time, duration) cannot change while it has an
--     upcoming booking, pending or confirmed. A booking stores its `during`
--     when it is made (bookings_compute_during); nothing moves it when a
--     slot changes, so an edit would leave bookings on times their slot no
--     longer has. The name and `nightly` may change at any time.
--   * a slot with booking history is RETIRED, not deleted: `active = false`.
--     A retired slot takes no new booking, from anyone; its past bookings
--     keep it. Deleting stays possible for a slot never booked: the
--     bookings foreign key (NO ACTION) refuses the rest, and its unit_rates
--     go with it (on delete cascade).
--
-- The two walls, as always (D-038):
--   wall 1, the code: @rag/bookings says why before it writes, lists only
--           active slots where a new booking is made, and every query
--           filters on tenant_id;
--   wall 2, Postgres: the policies and the two triggers below, which hold
--           whatever the code does, for staff and request_booking() alike.

-- 1. Retired or not. Every existing slot is active: nothing changes today.
alter table slots add column if not exists active boolean not null default true;

-- 2. Write policies: owners and admins of the slot's tenant, exactly like
--    unit_rates (schema-booking-types.sql) and rate_calendar. The read
--    policy (slots_read, any token of the tenant) is unchanged.
drop policy if exists slots_insert on slots;
drop policy if exists slots_update on slots;
drop policy if exists slots_delete on slots;
create policy slots_insert on slots for insert to authenticated
  with check (tenant_id = (select public.app_tenant_id()) and (select public.app_is_admin()));
create policy slots_update on slots for update to authenticated
  using      (tenant_id = (select public.app_tenant_id()) and (select public.app_is_admin()))
  with check (tenant_id = (select public.app_tenant_id()) and (select public.app_is_admin()));
create policy slots_delete on slots for delete to authenticated
  using (tenant_id = (select public.app_tenant_id()) and (select public.app_is_admin()));

-- 3. A slot's times are fixed while an upcoming booking uses them. "Upcoming"
--    is a pending or confirmed booking that has not ENDED: its stored
--    `during` reaches past now. The tenant_id is compared too, though a
--    booking's slot is always its own tenant's (the composite FK).
--    NOT security definer: only an admin can update a slot (step 2), and an
--    admin's token reads every booking of its tenant, so the count is real
--    (trap 12); service_role bypasses RLS and counts everything.
create or replace function public.slots_times_fixed() returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_upcoming int;
begin
  if new.start_time is distinct from old.start_time or new.duration is distinct from old.duration then
    select count(*) into v_upcoming
    from public.bookings b
    where b.tenant_id = old.tenant_id
      and b.slot_id = old.id
      and b.status in ('pending', 'confirmed')
      and upper(b.during) > now();
    if v_upcoming > 0 then
      raise exception 'slot times fixed: % upcoming booking(s) use "%"', v_upcoming, old.name
        using errcode = 'check_violation';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists slots_times_fixed on slots;
create trigger slots_times_fixed
  before update of start_time, duration on slots
  for each row execute function public.slots_times_fixed();

-- 4. A retired slot takes no new booking, and no booking moves onto one.
--    BEFORE INSERT, and before an update that changes the slot or the date
--    (a booking moved), so it covers staff bookings and request_booking()
--    alike. An old booking on a retired slot can still be cancelled or
--    confirmed: its slot and date do not change.
--    NOT security definer: the slot is read by the caller, and every caller
--    that can insert a booking can read its own tenant's slots (slots_read);
--    request_booking() runs as its definer anyway.
create or replace function public.bookings_slot_active() returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_active boolean;
  v_name   text;
begin
  select s.active, s.name into v_active, v_name
  from public.slots s
  where s.id = new.slot_id and s.tenant_id = new.tenant_id;
  -- A missing slot is bookings_compute_during's error (23503), not this one.
  if v_active is false then
    raise exception 'slot retired: "%" takes no new bookings', v_name
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists bookings_slot_active on bookings;
create trigger bookings_slot_active
  before insert or update of slot_id, booked_date on bookings
  for each row execute function public.bookings_slot_active();

-- PostgREST caches the schema: without this the new column stays invisible.
notify pgrst, 'reload schema';
