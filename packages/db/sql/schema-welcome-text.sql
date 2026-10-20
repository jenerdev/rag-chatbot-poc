-- schema-welcome-text.sql — the 44th file (D-139): the welcome line a new
-- chat opens with, per tenant.
--
-- The chat's welcome card introduces the assistant ("Hi, I'm Tessa", "Alteza
-- Hillside Resort's assistant") and then says, in one sentence, what to ask
-- it. That sentence was the same words for every tenant, in code. Now it is
-- a column: null = the default sentence in apps/web/lib/welcome-text.ts, set
-- by a super user on the platform tenant form (Profile → Identity), and
-- read by the chat through tenant_public(), like every other thing a visitor
-- sees about a tenant (D-089 did the same for the suggested questions).
--
-- Idempotent. Run after schema-audit-log.sql (the 43rd), whose audit_row()
-- allowlist names this column so a change is logged with its before and
-- after; re-run that file after editing it, then this one (trap 25).
--
-- It REPLACES tenant_public() from schema-legal.sql, whose own drop-and-
-- create is now guarded on this column (trap 20): re-run after this file, it
-- skips its step 2 instead of taking the column away again.

begin;

-- 1. The column. One short line of plain text, 1 to 200 characters once
--    trimmed; an empty line is null, never ''.
alter table public.tenants add column if not exists welcome_text text;
alter table public.tenants drop constraint if exists tenants_welcome_text_length;
alter table public.tenants add  constraint tenants_welcome_text_length check (
  welcome_text is null or char_length(btrim(welcome_text)) between 1 and 200
);

-- 2. tenant_public(), with the column: dropped and re-created (the return
--    type changes), the same body otherwise, still security definer, still
--    search_path = '', still no archived tenant. Its column list is the
--    boundary of what a token may read about a tenant (auth-rls § 1.3); the
--    welcome line is meant for every visitor.
drop function if exists public.tenant_public(text);
create function public.tenant_public(p_slug text)
returns table (
  id                    bigint,
  slug                  text,
  business_name         text,
  assistant_name        text,
  logo_url              text,
  banner_url            text,
  theme                 jsonb,
  fallback_messages     jsonb,
  suggested_questions   jsonb,
  assistant_avatar_url  text,
  privacy_contact_name  text,
  privacy_contact_email text,
  policy_version        text,
  chat_retention_days   int,
  guest_retention_days  int,
  welcome_text          text
)
language sql stable
security definer
set search_path = ''
as $$
  select t.id, t.slug, t.business_name, t.assistant_name, t.logo_url, t.banner_url, t.theme, t.fallback_messages,
         t.suggested_questions, t.assistant_avatar_url, t.privacy_contact_name, t.privacy_contact_email,
         t.policy_version, t.chat_retention_days, t.guest_retention_days, t.welcome_text
  from public.tenants t
  where t.slug = p_slug and t.archived_at is null
$$;

-- 3. A dropped function loses its grants: re-applied as every earlier file had them.
revoke all on function public.tenant_public(text) from public, anon, authenticated;
grant execute on function public.tenant_public(text) to anon, authenticated, service_role;

commit;

-- PostgREST caches the schema: without this the new column and return type
-- stay invisible to .from() and .rpc().
notify pgrst, 'reload schema';
