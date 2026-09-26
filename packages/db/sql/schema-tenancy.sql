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
-- THE BRIDGE (D-031), and why step 9 exists
-- -------------------------------------------
-- Between tenancy Phases 1 and 3 this file also gave tenant_id a default of
-- northwind, and left the old unfiltered match_chunks and match_chunks_fts in
-- place, so that the pipeline kept working before it knew tenants existed.
-- Phase 3 threaded the tenant through every call, and the bridge was removed.
--
-- This file now describes the FINAL state. Re-running it never puts the
-- bridge back. Step 9 drops the default, the helper function and the
-- pre-tenancy search signatures, which schema.sql and schema-hybrid.sql still
-- create on a fresh install. Every step is `if exists` / `if not exists`, so
-- the file is idempotent from any starting point.

-- 1. The tenants table.
create table if not exists tenants (
  id              bigint generated always as identity primary key,
  slug            text        not null unique,   -- the /t/<slug> segment
  business_name   text        not null,          -- "Northwind Labs"
  assistant_name  text        not null,          -- "Nora"
  logo_url        text,                          -- https only, validated on write
  banner_url      text,
  theme           jsonb       not null default '{}'::jsonb,
  admin_key_hash  text,                          -- scrypt; dropped by schema-auth.sql § 7 (auth-rls Phase 6)
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

-- There is deliberately NO default. An insert that does not say which tenant
-- it belongs to fails, which is the point (D-027). Step 9 removes the default
-- the D-031 bridge added.

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

-- The vector index is UNCHANGED: one global HNSW graph over every tenant.
-- Phase 2 measured what that costs (notes.md, "Tenancy and the index"):
--
--   * Today the planner does not use HNSW for a tenant-scoped search at all.
--     It reads the tenant's rows through chunks_tenant_idx and sorts them
--     exactly, which gives perfect recall at this size.
--   * Once a tenant is big enough for HNSW to win, the tenant filter is
--     applied AFTER the graph walk. With the walk cut short, villa got 0 rows
--     because every candidate belonged to northwind. That is the silent false
--     refusal of plan.md § 2.1. The fix is iterative scan, set on
--     match_chunks below.
--   * The composite (tenant_id, tsvector) GIN index is NOT built. Full-text
--     search also goes through chunks_tenant_idx. Revisit when one tenant
--     holds thousands of chunks.

-- 8. The tenant-scoped search functions.
--
-- p_tenant_id has NO DEFAULT. A defaulted tenant parameter is a function that
-- happily searches the wrong tenant when a caller forgets an argument (D-027).
-- Supabase's .rpc() passes arguments by name, so its position (second) is
-- documentation; the missing default is what actually protects you.
--
-- `create or replace` with a new parameter list does not replace the old
-- functions. It creates overloads next to them. The old, unfiltered signatures
-- from schema.sql and schema-hybrid.sql are dropped in step 9.
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
-- Iterative index scan (pgvector ≥ 0.8.0; this database has 0.8.2). When the
-- HNSW walk runs out of candidates before `match_count` rows have passed the
-- tenant filter, the scan keeps walking instead of returning short. It is
-- `strict_order`, not `relaxed_order`: relaxed can hand back rows slightly out
-- of distance order, and the pipeline and verify.mjs both rely on
-- most-similar-first. Measured in Phase 2: with ef_search 2, villa went from
-- 0 rows to 5. The scan is still bounded by hnsw.max_scan_tuples (default
-- 20,000). Set on the function itself, so no caller can forget it.
set hnsw.iterative_scan = 'strict_order'
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

-- 9. Remove the D-031 bridge and the pre-tenancy search functions.
--
-- After this, nothing in the database can search or write without naming a
-- tenant. An un-threaded .rpc('match_chunks', {query_embedding, ...}) fails
-- with "Could not find the function", instead of quietly searching everyone.
alter table documents     alter column tenant_id drop default;
alter table chunks        alter column tenant_id drop default;
alter table conversations alter column tenant_id drop default;
alter table messages      alter column tenant_id drop default;
drop function if exists tenancy_bridge_default_tenant();
drop function if exists match_chunks (vector(1536), int, float);
drop function if exists match_chunks_fts (text, vector(1536), int);

-- PostgREST caches the schema. Without this, the new columns and functions are
-- invisible to .rpc() and .from(), and the dropped ones still look callable,
-- until the cache refreshes on its own.
notify pgrst, 'reload schema';

-- Verify:
--   select count(*) from chunks where tenant_id is null;          -- must be 0
--   pnpm --filter @rag/db verify                                    -- 14 checks
