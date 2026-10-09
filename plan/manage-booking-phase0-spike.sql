-- manage-booking-phase0-spike.sql — Phase 0's two spikes (plan/manage-booking.md § 5).
--
-- Run in the Supabase SQL editor. Part A sets up spike (a), a private bucket a
-- CHAT token may insert into and never read; then run
--   (cd packages/db && node --conditions=react-server --env-file=../../.env ../../plan/manage-booking-phase0-spike.mjs)
-- Part B answers spike (b), whether pg_cron can be enabled here; it CHANGES
-- NOTHING, it only reads the catalogue. Part C removes Part A afterwards.
--
-- The bucket is 'payment-proofs-spike', not the real 'payment-proofs': Phase 3
-- creates the real one in a schema file. Policies copy the unit-images shape
-- (schema-booking-types.sql): the FIRST folder is the token's tenant, wall 2.

-- ── Part A: the spike bucket ───────────────────────────────────────────────
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('payment-proofs-spike', 'payment-proofs-spike', false, 5242880,
        array['image/jpeg', 'image/png', 'image/webp', 'application/pdf'])
on conflict (id) do update
  set public             = excluded.public,
      file_size_limit    = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists proofs_spike_insert on storage.objects;
drop policy if exists proofs_spike_select on storage.objects;

-- ANY token of the tenant may insert, but only under <tenant>/incoming/.
-- (The real route matches the stay first: wall 1.) No select, update or
-- delete for a chat token, so it cannot read back, list or overwrite.
create policy proofs_spike_insert on storage.objects for insert to authenticated
  with check (
    bucket_id = 'payment-proofs-spike'
    and (storage.foldername(name))[1] = (select public.app_tenant_id())::text
    and (storage.foldername(name))[2] = 'incoming'
  );

-- Staff of the tenant read (needed to sign a URL). A chat token has
-- app_is_staff() = false.
create policy proofs_spike_select on storage.objects for select to authenticated
  using (
    bucket_id = 'payment-proofs-spike'
    and (storage.foldername(name))[1] = (select public.app_tenant_id())::text
    and (select public.app_is_staff())
  );

-- ── Part B: is pg_cron available? (read-only) ─────────────────────────────
select name, default_version, installed_version
from pg_available_extensions
where name in ('pg_cron', 'pg_net');

-- ── Part C: cleanup, AFTER the spike script has run ───────────────────────
-- The script removes every object it made through the Storage API (Supabase
-- refuses a direct delete from storage.objects), and prints the count; the
-- bucket must be empty before it can go.
--
-- drop policy if exists proofs_spike_insert on storage.objects;
-- drop policy if exists proofs_spike_select on storage.objects;
-- delete from storage.buckets where id = 'payment-proofs-spike';
