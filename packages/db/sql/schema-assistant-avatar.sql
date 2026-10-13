-- schema-assistant-avatar.sql — the 32nd file (D-124): the AI assistant's own
-- photo or picture, set on the platform page (uploaded into the
-- brand-images bucket, D-123, or an https address), and shown wherever the
-- assistant speaks: the chat's welcome card and beside every reply.
--
-- Run AFTER schema-brand-images.sql and schema-suggested-questions.sql.
-- Safe to re-run.
--
-- It REPLACES tenant_public() from schema-suggested-questions.sql, whose
-- drop-and-create is now guarded on this column (CLAUDE.md trap 20).

-- 1. The column, https only like the logo and banner (tenants_urls_https).
alter table tenants add column if not exists assistant_avatar_url text;
alter table tenants drop constraint if exists tenants_assistant_avatar_https;
alter table tenants add  constraint tenants_assistant_avatar_https check (
  assistant_avatar_url is null or assistant_avatar_url ~ '^https://[^[:space:]]+$'
);

-- 2. tenant_public(), with the column: dropped and re-created (its return type
--    changes), the same body otherwise, still security definer, still
--    search_path = '', still no archived tenant. Its column list is the
--    boundary of what a token may read about a tenant; the avatar is meant
--    for every visitor.
drop function if exists public.tenant_public(text);
create function public.tenant_public(p_slug text)
returns table (
  id                   bigint,
  slug                 text,
  business_name        text,
  assistant_name       text,
  logo_url             text,
  banner_url           text,
  theme                jsonb,
  fallback_messages    jsonb,
  suggested_questions  jsonb,
  assistant_avatar_url text
)
language sql stable
security definer
set search_path = ''
as $$
  select t.id, t.slug, t.business_name, t.assistant_name, t.logo_url, t.banner_url, t.theme, t.fallback_messages,
         t.suggested_questions, t.assistant_avatar_url
  from public.tenants t
  where t.slug = p_slug and t.archived_at is null
$$;

-- 3. A dropped function loses its grants: re-applied as before.
revoke all on function public.tenant_public(text) from public, anon, authenticated;
grant execute on function public.tenant_public(text) to anon, authenticated, service_role;

notify pgrst, 'reload schema';
