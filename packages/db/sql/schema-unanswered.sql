-- schema-unanswered.sql — "mark as resolved" for the unanswered-questions
-- screen (S-4, D-045).
--
-- Run after schema-auth.sql, in the Supabase SQL editor. Idempotent: every
-- step is `if not exists` or a drop-then-create.
--
-- WHY A TABLE, NOT A DELETE. The unanswered list is not stored anywhere; it
-- is read out of `messages` (packages/rag/src/unanswered.ts). Deleting an
-- entry would mean deleting a visitor's transcript, and no token may do that.
-- A resolution is a separate row that points at the refusal, so the
-- transcript stays whole and "resolved" can be undone.
--
-- WHY NOT A COLUMN ON messages. It would need an UPDATE policy on messages,
-- a table the open chat token can already read and insert into. A separate
-- table keeps messages append-only and gives resolutions their own
-- staff-only policies.

-- 1. (id, tenant_id) unique on messages, so step 2's composite FK has
--    something to reference. id alone is already unique; this is the same
--    move schema-tenancy.sql step 5 made for documents and conversations.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'messages_id_tenant_key') then
    alter table messages add constraint messages_id_tenant_key unique (id, tenant_id);
  end if;
end $$;

-- 2. One row per resolved refusal. message_id is the REFUSAL's id (the
--    assistant row), the same id the S-4 list carries.
--    The composite FK makes Postgres refuse a resolution whose tenant
--    disagrees with its message's, even if the code were wrong.
create table if not exists unanswered_resolutions (
  message_id   bigint      primary key,
  tenant_id    bigint      not null references tenants(id) on delete cascade,
  resolved_at  timestamptz not null default now(),
  constraint unanswered_resolutions_message_fk
    foreign key (message_id, tenant_id) references messages (id, tenant_id) on delete cascade
);

create index if not exists unanswered_resolutions_tenant_idx on unanswered_resolutions (tenant_id);

-- 3. RLS: staff only, every verb. A chat token (no app_admin) reads nothing
--    and writes nothing here. There is no update: a resolution is added or
--    removed, never changed.
alter table unanswered_resolutions enable row level security;

-- GUARDED (tenant management Phase 1, 2026-09-29): schema-roles.sql replaces
-- these three (any member, via app_is_staff()).
-- Once that file has run (platform_admins exists), re-running THIS file must
-- not put the older definition back, so it is skipped.
do $guard$
begin
  if to_regclass('public.platform_admins') is null then
    execute $ddl$
drop policy if exists unanswered_resolutions_read   on unanswered_resolutions;
    $ddl$;
    execute $ddl$
drop policy if exists unanswered_resolutions_insert on unanswered_resolutions;
    $ddl$;
    execute $ddl$
drop policy if exists unanswered_resolutions_delete on unanswered_resolutions;
    $ddl$;
    execute $ddl$
create policy unanswered_resolutions_read on unanswered_resolutions for select to authenticated
  using (tenant_id = (select public.app_tenant_id()) and (select public.app_is_admin()));
    $ddl$;
    execute $ddl$
create policy unanswered_resolutions_insert on unanswered_resolutions for insert to authenticated
  with check (tenant_id = (select public.app_tenant_id()) and (select public.app_is_admin()));
    $ddl$;
    execute $ddl$
create policy unanswered_resolutions_delete on unanswered_resolutions for delete to authenticated
  using (tenant_id = (select public.app_tenant_id()) and (select public.app_is_admin()));
    $ddl$;
  end if;
end $guard$;

-- Belt and braces, as for memberships: Supabase grants every privilege on a
-- new table by default. anon never needs this table; update is never used.
revoke all on unanswered_resolutions from anon;
revoke update on unanswered_resolutions from authenticated;
