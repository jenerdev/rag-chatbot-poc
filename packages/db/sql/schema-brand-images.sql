-- schema-brand-images.sql — the 31st file (D-123): a tenant's logo, banner and
-- (later) assistant avatar UPLOADED on the platform page, not only pasted
-- as a URL.
--
-- One public bucket, `brand-images`, for the images every guest page shows.
-- Public like `unit-images` (schema-booking-types.sql): the chat, the
-- booking page and Manage booking draw them for strangers, by URL.
--
-- Objects are named '<tenant_id>/<kind>-<uuid>.<ext>'. Only a SUPER USER
-- (a platform token whose `platform_admins` row exists, app_is_super(),
-- D-076) may add, list or remove one: the platform page is where a tenant's
-- identity is edited. A tenant's staff token, a chat token and anon can do
-- none of it. The URL then goes into tenants.logo_url / banner_url through
-- the platform's ordinary update, so tenants_urls_https still applies.
--
-- Idempotent. Run after schema-roles.sql (app_is_super()).

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('brand-images', 'brand-images', true, 2097152, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update
  set public             = excluded.public,
      file_size_limit    = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- `select` is needed because Storage reads the object's row to delete it;
-- the public URL needs no policy.
drop policy if exists brand_images_objects_insert on storage.objects;
create policy brand_images_objects_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'brand-images' and (select public.app_is_super()));

drop policy if exists brand_images_objects_select on storage.objects;
create policy brand_images_objects_select on storage.objects for select to authenticated
  using (bucket_id = 'brand-images' and (select public.app_is_super()));

drop policy if exists brand_images_objects_delete on storage.objects;
create policy brand_images_objects_delete on storage.objects for delete to authenticated
  using (bucket_id = 'brand-images' and (select public.app_is_super()));

notify pgrst, 'reload schema';
