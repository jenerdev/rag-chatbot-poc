-- schema-booking-types.sql — booking types: whole_resort or per_room (plan/booking-types.md).
--
-- Run in the Supabase SQL editor AFTER schema-auth.sql. Idempotent: every
-- step can run again harmlessly, so the file is re-run whole as it grows.
--
-- PHASE 1 STATUS: this file holds only § 11 for now, the photo bucket and its
-- policies. It is the Storage spike of plan § 2.8: before anything else is
-- built, prove that Supabase Storage accepts the tokens mintTenantToken()
-- signs, and that its policies see the same tenant_id / app_admin claims
-- PostgREST does. plan/booking-types-phase1-storage.mjs runs the checks.
-- Steps 1–10 (config, units, rates, prices, …) are appended after it passes.

-- 11. Room photos: the bucket, and who may write to it.
--
-- PUBLIC for reads (plan § 2.8): room photos are the tenant's marketing, a
-- public URL needs no token to display, and object names are random UUIDs, so
-- there is nothing to enumerate. `public` only opens the public-URL endpoint;
-- the API's list/select still goes through the policies below.
--
-- file_size_limit and allowed_mime_types are the SECOND wall. The upload
-- route checks size and type first; the bucket still refuses if the route has
-- a bug. 2 MiB is provisional: Phase 4 measures a real phone photo after the
-- browser resize and sets MAX_IMAGE_BYTES (and this) from that. No SVG: it
-- can carry script.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('unit-images', 'unit-images', true, 2097152, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update
  set public             = excluded.public,
      file_size_limit    = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- Objects are named '<tenant_id>/<unit_id>/<uuid>.<ext>'. Every policy
-- compares the FIRST folder with the token's tenant: that is wall 2.
-- Wall 1 is @rag/bookings building the path from tenant.id itself.
--
-- Staff only, for all three. A chat token has app_is_admin() = false, so it
-- can neither upload nor delete. `select` is needed because Storage reads
-- the object's row to delete it, and for the staff screen's listing; public
-- reads of the image itself do not go through it.
--
-- No UPDATE policy: a photo is replaced by delete + upload, so a path never
-- starts showing a different picture. (It also means upload with
-- `upsert: true` is refused, which is intended.)
--
-- The helpers are wrapped as `(select …)`, the same InitPlan form as every
-- policy in schema-auth.sql.
drop policy if exists unit_images_objects_insert on storage.objects;
drop policy if exists unit_images_objects_select on storage.objects;
drop policy if exists unit_images_objects_delete on storage.objects;

create policy unit_images_objects_insert on storage.objects for insert to authenticated
  with check (
    bucket_id = 'unit-images'
    and (storage.foldername(name))[1] = (select public.app_tenant_id())::text
    and (select public.app_is_admin())
  );

create policy unit_images_objects_select on storage.objects for select to authenticated
  using (
    bucket_id = 'unit-images'
    and (storage.foldername(name))[1] = (select public.app_tenant_id())::text
    and (select public.app_is_admin())
  );

create policy unit_images_objects_delete on storage.objects for delete to authenticated
  using (
    bucket_id = 'unit-images'
    and (storage.foldername(name))[1] = (select public.app_tenant_id())::text
    and (select public.app_is_admin())
  );

-- Verify: node --conditions=react-server --env-file=../../.env ../../plan/booking-types-phase1-storage.mjs
--   (run from packages/db)
