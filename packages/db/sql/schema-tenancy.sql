-- schema-tenancy.sql — tenancy Phase 1: one database, many businesses.
--
-- Run this ONCE in the Supabase SQL editor, after schema.sql and
-- schema-hybrid.sql. It is idempotent, so a second run is harmless.
-- Source: plan.md § 1 (the data model) and § 3 Phase 1.
--
-- THE ONE THING TO KNOW
-- ---------------------
-- The server uses the service_role key, which bypasses RLS (D-006, R-2). So
-- after this file, the only thing between tenant A and tenant B is a
-- `tenant_id = …` filter: in application code, and inside the two search
-- functions at the bottom. The composite foreign keys in step 6 are the one
-- guard that does not depend on anyone remembering to write a filter.
--
-- THE BRIDGE (D-031): temporary, removed in Phase 3
-- -------------------------------------------------
-- Today's pipeline does not know tenants exist. It inserts rows without a
-- tenant_id and calls match_chunks without p_tenant_id. Without a bridge, this
-- file would break ingest, chat and `pnpm eval` until Phase 3 is finished. So
-- two things are here that the finished design forbids (D-027):
--
--   1. tenant_id defaults to the northwind tenant (step 4), and
--   2. the old, UNFILTERED match_chunks and match_chunks_fts stay alongside the
--      new tenant-scoped versions (step 8). They are overloads, not
--      replacements: a call that sends p_tenant_id reaches the new function,
--      and a call that does not reaches the old one.
--
-- Both are harmless while northwind is the only tenant, and both become a
-- cross-tenant leak once a second tenant exists and the app still has not been
-- threaded (Phase 3). The drop statements are at the very end, commented out.
-- Phase 3 runs them.

-- 1. The tenants table.
create table if not exists tenants (
  id              bigint generated always as identity primary key,
  slug            text        not null unique,   -- the /t/<slug> segment
  business_name   text        not null,          -- "Northwind Labs"
  assistant_name  text        not null,          -- "Nora"
  logo_url        text,                          -- https only, validated on write
  banner_url      text,
  theme           jsonb       not null default '{}'::jsonb,
  admin_key_hash  text,                          -- scrypt; null = nobody can admin it
  created_at      timestamptz not null default now(),

  -- The slug is in a URL, so the database constrains it rather than trusting
  -- whatever created the row. Lower-case, no dots, no slashes, no leading or
  -- trailing hyphen, 3–32 characters.
  constraint tenants_slug_shape check (slug ~ '^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$'),
  -- Slugs that would collide with a route or read as a system page.
  constraint tenants_slug_reserved check (
    slug not in ('api','admin','t','_next','static','new','login','health')
  )
);

-- Same posture as the other four tables: RLS on, no policies (D-006). The anon
-- key gets nothing, and service_role bypasses RLS.
alter table tenants enable row level security;

-- 2. The seed tenant, which takes everything already in the database.
insert into tenants (slug, business_name, assistant_name)
values ('northwind', 'Northwind Labs', 'Nora')
on conflict (slug) do nothing;

-- 3. Nullable first, so the backfill has something to fill.
alter table documents     add column if not exists tenant_id bigint references tenants(id) on delete cascade;
alter table chunks        add column if not exists tenant_id bigint references tenants(id) on delete cascade;
alter table conversations add column if not exists tenant_id bigint references tenants(id) on delete cascade;
alter table messages      add column if not exists tenant_id bigint references tenants(id) on delete cascade;

-- 4. Backfill every existing row to northwind, then forbid NULL.
--
-- A nullable tenant_id is not an acceptable end state: `where tenant_id = 3`
-- silently skips every NULL row, so a forgotten backfill looks like an empty
-- knowledge base instead of an error.
update documents     set tenant_id = (select id from tenants where slug = 'northwind') where tenant_id is null;
update chunks        set tenant_id = (select id from tenants where slug = 'northwind') where tenant_id is null;
update conversations set tenant_id = (select id from tenants where slug = 'northwind') where tenant_id is null;
update messages      set tenant_id = (select id from tenants where slug = 'northwind') where tenant_id is null;

alter table documents     alter column tenant_id set not null;
alter table chunks        alter column tenant_id set not null;
alter table conversations alter column tenant_id set not null;
alter table messages      alter column tenant_id set not null;

-- BRIDGE (D-031): a default so today's un-threaded inserts keep working.
-- A column DEFAULT cannot contain a subquery, so it calls this function. The
-- name says what it is, so it is easy to find and hard to mistake for design.
create or replace function tenancy_bridge_default_tenant()
returns bigint
language sql stable
as $$ select id from tenants where slug = 'northwind' $$;

alter table documents     alter column tenant_id set default tenancy_bridge_default_tenant();
alter table chunks        alter column tenant_id set default tenancy_bridge_default_tenant();
alter table conversations alter column tenant_id set default tenancy_bridge_default_tenant();
alter table messages      alter column tenant_id set default tenancy_bridge_default_tenant();

-- 5. (id, tenant_id) is unique on the parents. It already is, because id alone
--    is unique. This constraint exists so step 6 has something to reference.
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'documents_id_tenant_key') then
    alter table documents add constraint documents_id_tenant_key unique (id, tenant_id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'conversations_id_tenant_key') then
    alter table conversations add constraint conversations_id_tenant_key unique (id, tenant_id);
  end if;
end $$;

-- 6. The composite foreign keys: the most valuable lines in the plan.
--
-- chunks.tenant_id duplicates documents.tenant_id on purpose. Both search
-- functions scan chunks alone, which is why they are fast; joining to documents
-- for every candidate row would defeat the index before the filter could help.
-- A denormalised copy can drift, so drift is made impossible here. A chunk
-- whose tenant_id disagrees with its document's tenant_id fails to insert.
-- Every other isolation guarantee is a filter someone has to remember to
-- write. This one is Postgres refusing.
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'chunks_document_tenant_fk') then
    alter table chunks add constraint chunks_document_tenant_fk
      foreign key (document_id, tenant_id)
      references documents (id, tenant_id) on delete cascade;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'messages_conversation_tenant_fk') then
    alter table messages add constraint messages_conversation_tenant_fk
      foreign key (conversation_id, tenant_id)
      references conversations (id, tenant_id) on delete cascade;
  end if;
end $$;

-- 7. Tenant-scoped lookups.
create index if not exists documents_tenant_idx     on documents (tenant_id, created_at desc);
create index if not exists chunks_tenant_idx        on chunks (tenant_id);
create index if not exists messages_tenant_conv_idx on messages (tenant_id, conversation_id, id);

-- The vector index is UNCHANGED: one global HNSW graph over every tenant. The
-- tenant filter is applied AFTER the graph walk, which can lose recall silently
-- as tenants multiply (plan.md § 2.1, R-10). Phase 2 measures that, and decides
-- whether these functions need `set hnsw.iterative_scan` (pgvector is 0.8.2).
-- The composite GIN index for full-text search is also a Phase 2 measurement,
-- so neither is decided here.

-- 8. The tenant-scoped search functions.
--
-- p_tenant_id has NO DEFAULT. A defaulted tenant parameter is a function that
-- happily searches the wrong tenant when a caller forgets an argument (D-027).
-- Supabase's .rpc() passes arguments by name, so its position (second) is
-- documentation; the missing default is what actually protects you.
--
-- These are new overloads. The old signatures from schema.sql and
-- schema-hybrid.sql still exist, unfiltered, until the bridge is removed.
create or replace function match_chunks (
  query_embedding vector(1536),
  p_tenant_id     bigint,
  match_count     int   default 5,
  min_similarity  float default 0.3
)
returns table (
  id          bigint,
  document_id bigint,
  content     text,
  similarity  float
)
language sql stable
as $$
  select
    c.id,
    c.document_id,
    c.content,
    1 - (c.embedding <=> query_embedding) as similarity
  from chunks c
  where c.tenant_id = p_tenant_id
    and 1 - (c.embedding <=> query_embedding) >= min_similarity
  order by c.embedding <=> query_embedding   -- still ascending distance, so still the index
  limit match_count;
$$;

create or replace function match_chunks_fts (
  query_text      text,
  query_embedding vector(1536),
  p_tenant_id     bigint,
  match_count     int default 5
)
returns table (
  id          bigint,
  document_id bigint,
  content     text,
  similarity  float,
  rank        float
)
language sql stable
as $$
  select
    c.id,
    c.document_id,
    c.content,
    1 - (c.embedding <=> query_embedding) as similarity,
    ts_rank(to_tsvector('english', c.content), to_or_tsquery(query_text)) as rank
  from chunks c
  where c.tenant_id = p_tenant_id
    and to_tsvector('english', c.content) @@ to_or_tsquery(query_text)
  order by rank desc
  limit match_count;
$$;

-- PostgREST caches the schema. Without this, the new columns and overloads are
-- invisible to .rpc() and .from() until the cache refreshes on its own.
notify pgrst, 'reload schema';

-- Verify:
--   select count(*) from chunks where tenant_id is null;          -- must be 0
--   pnpm --filter @rag/db verify                                    -- 14 checks

-- ---------------------------------------------------------------------------
-- REMOVE THE BRIDGE, in Phase 3, once every insert and .rpc() sends the tenant:
--
--   alter table documents     alter column tenant_id drop default;
--   alter table chunks        alter column tenant_id drop default;
--   alter table conversations alter column tenant_id drop default;
--   alter table messages      alter column tenant_id drop default;
--   drop function tenancy_bridge_default_tenant();
--   drop function match_chunks (vector(1536), int, float);
--   drop function match_chunks_fts (text, vector(1536), int);
--   notify pgrst, 'reload schema';
-- ---------------------------------------------------------------------------
