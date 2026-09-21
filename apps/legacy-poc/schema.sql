-- schema.sql — RAG Chatbot POC
-- Run this once, top to bottom, in the Supabase SQL editor.
-- Source: architecture.md § 4.

-- 1. Enable pgvector. Supabase ships it; this just turns it on.
create extension if not exists vector;

-- 2. A source document, as pasted.
create table documents (
  id          bigint generated always as identity primary key,
  title       text        not null,
  source      text,                          -- optional: url, filename, note
  content     text        not null,          -- the full original text
  created_at  timestamptz not null default now()
);

-- 3. The searchable pieces. This is the table RAG actually reads.
create table chunks (
  id           bigint generated always as identity primary key,
  document_id  bigint       not null references documents(id) on delete cascade,
  chunk_index  int          not null,        -- position within the document
  content      text         not null,        -- the chunk text, shown as a source
  embedding    vector(1536) not null,        -- MUST match the embedding model size
  created_at   timestamptz  not null default now()
);

-- 4. Chat history, so a conversation can refer back to itself.
create table conversations (
  id          uuid primary key default gen_random_uuid(),
  created_at  timestamptz not null default now()
);

create table messages (
  id               bigint generated always as identity primary key,
  conversation_id  uuid        not null references conversations(id) on delete cascade,
  role             text        not null check (role in ('user', 'assistant')),
  content          text        not null,
  created_at       timestamptz not null default now()
);

-- 5. Indexes.
create index chunks_document_id_idx    on chunks (document_id);
create index messages_conversation_idx on messages (conversation_id, created_at);

-- The vector index. HNSW is the current pgvector recommendation: it can be
-- built on an empty table, unlike ivfflat which needs data to train on first.
create index chunks_embedding_idx
  on chunks using hnsw (embedding vector_cosine_ops);

-- 6. Row Level Security.
-- The Express server talks to Postgres with the service_role key, which
-- bypasses RLS entirely — so turning RLS on changes nothing about how this POC
-- works. It is on anyway because the alternative is tables that anyone holding
-- the anon key can read and write. No policies are written (D-006), which means
-- anon and authenticated get nothing at all. That is the intended posture:
-- the server is the only client of this database.
alter table documents     enable row level security;
alter table chunks        enable row level security;
alter table conversations enable row level security;
alter table messages      enable row level security;

-- 7. The similarity search function.
-- Vector search needs SQL, so it lives here and is called from Node with .rpc().
create or replace function match_chunks (
  query_embedding vector(1536),
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
  where 1 - (c.embedding <=> query_embedding) >= min_similarity
  order by c.embedding <=> query_embedding   -- ascending distance = most similar first
  limit match_count;
$$;
