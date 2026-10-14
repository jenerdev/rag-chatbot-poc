-- schema-stay-notes.sql — the 36th file (D-132): STAFF NOTES ON A STAY.
--
-- A stay (D-100's group, a `stays` row) may carry any number of notes,
-- written by staff for staff on its detail page, S-15: "Asked for an early
-- check-in", "Paid the balance in cash, receipt 0412". Not the guest's
-- `bookings.notes` (what the guest or the booking form wrote, one per row),
-- and not a decision note (D-096, one per decision, shown to the guest).
-- A staff note is never shown to the guest and never reaches a prompt.
--
-- THE RULES
-- ---------
-- 1. Append, then delete your own. A note is not edited: a correction is a
--    new note. Its author may delete it; nobody else may, an owner neither,
--    so a note cannot be quietly removed by a colleague.
-- 2. Who: reading needs bookings:read, writing bookings:write, the same as
--    the stay itself, asked through app_can() (D-128), so a tenant's role
--    overrides reach notes with no twin policy (the policies below ARE the
--    role check). A chat token, a platform token and anon read nothing.
-- 3. The author is the token's user, by default AND by check: a request
--    cannot write a note in someone else's name.
-- 4. Retention (D-131): a note may hold guest details, so when the retention
--    tool clears a stay's guest (bookings.guest_removed_at set), its notes
--    are deleted by a trigger. remove_guest_details() is NOT replaced
--    (trap 20, trap 25): the trigger is the whole change.
--
-- Idempotent. Run after schema-legal.sql (and so after every earlier file).

-- 1. The notes.
create table if not exists public.stay_notes (
  id         bigint      generated always as identity primary key,
  tenant_id  bigint      not null,
  group_id   uuid        not null,
  author     uuid        default auth.uid() references auth.users (id) on delete set null,
  body       text        not null,
  created_at timestamptz not null default now(),
  constraint stay_notes_stay_fk foreign key (tenant_id, group_id)
    references public.stays (tenant_id, group_id) on delete cascade,
  constraint stay_notes_body check (length(btrim(body)) between 1 and 2000)
);
create index if not exists stay_notes_stay_idx on public.stay_notes (tenant_id, group_id, created_at);

alter table public.stay_notes enable row level security;
revoke all on public.stay_notes from anon;
revoke update on public.stay_notes from authenticated;

-- 2. The policies (rule 2, rule 1, rule 3). app_can() is false for any token
--    that is not a member's, so these are also the tenant wall's staff test.
drop policy if exists stay_notes_read on public.stay_notes;
create policy stay_notes_read on public.stay_notes for select to authenticated
  using (tenant_id = (select public.app_tenant_id()) and (select public.app_can('bookings:read')));

drop policy if exists stay_notes_insert on public.stay_notes;
create policy stay_notes_insert on public.stay_notes for insert to authenticated
  with check (
    tenant_id = (select public.app_tenant_id())
    and (select public.app_can('bookings:write'))
    and author = (select auth.uid())
  );

drop policy if exists stay_notes_delete_own on public.stay_notes;
create policy stay_notes_delete_own on public.stay_notes for delete to authenticated
  using (
    tenant_id = (select public.app_tenant_id())
    and (select public.app_can('bookings:write'))
    and author = (select auth.uid())
  );

-- 3. Retention (rule 4): a stay whose guest is removed loses its notes too.
--    Fires once per booking row; the second row of a stay deletes nothing.
create or replace function public.stay_notes_on_guest_removed() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.group_id is not null then
    delete from public.stay_notes n where n.tenant_id = new.tenant_id and n.group_id = new.group_id;
  end if;
  return null;
end;
$$;
drop trigger if exists bookings_au_stay_notes on public.bookings;
create trigger bookings_au_stay_notes
  after update of guest_removed_at on public.bookings
  for each row
  when (old.guest_removed_at is null and new.guest_removed_at is not null)
  execute function public.stay_notes_on_guest_removed();

notify pgrst, 'reload schema';
