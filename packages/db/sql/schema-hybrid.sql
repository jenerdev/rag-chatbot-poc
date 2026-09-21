-- schema-hybrid.sql — post-MVP addition: keyword search alongside vector search.
--
-- Run this ONCE in the Supabase SQL editor, after schema.sql.
-- Everything here is idempotent, so running it twice is harmless.
--
-- WHY THIS EXISTS
-- ---------------
-- Embeddings encode *meaning*. An identifier like "4417" or "NL-220" has
-- almost no meaning to encode, so vector search ranks it poorly. Measured on
-- this build (see notes.md):
--
--     "extension 4417"        -> 0.284   (the exact string IS in the document)
--     "can a candidate on a tour walk into Bay 7?"  -> 0.401   (a paraphrase)
--
-- An exact quoted identifier scored WORSE than a vague paraphrase, and at a
-- threshold of 0.30 it would have been refused outright. Postgres full-text
-- search has the opposite bias: hopeless at meaning, perfect at exact tokens.
-- Running both and merging covers each one's blind spot.

-- 1. The full-text index.
--
-- A GIN index over the tsvector of every chunk. to_tsvector with an EXPLICIT
-- config name ('english') is immutable, which is what makes it indexable —
-- the single-argument form depends on a session setting and Postgres will
-- refuse to index it.
create index if not exists chunks_content_fts_idx
  on chunks using gin (to_tsvector('english', content));

-- 2. Turn a question into an OR query.
--
-- plainto_tsquery and websearch_to_tsquery both AND the terms together, which
-- is far too strict here. "Who do I contact on extension 4417?" becomes
-- 'contact & extens & 4417', and the chunk containing "reachable at extension
-- 4417" does not contain "contact" — so an AND query finds nothing, and the
-- one thing keyword search exists to catch is missed.
--
-- So: run the question through the same normaliser the index used, take the
-- resulting lexemes, and OR them. Ranking sorts out which matches matter.
create or replace function to_or_tsquery(query_text text)
returns tsquery
language sql
immutable
as $$
  select coalesce(
    nullif(
      array_to_string(tsvector_to_array(to_tsvector('english', query_text)), ' | '),
      ''
    )::tsquery,
    ''::tsquery   -- a query of only stopwords matches nothing, which is correct
  );
$$;

-- 3. Keyword search over chunks.
--
-- Takes the query embedding as well, even though it does not search with it.
-- That is so every row can report BOTH scores: the keyword rank that found it
-- and the cosine similarity it would have had. A chunk that keyword search
-- rescued at similarity 0.28 is exactly the story this feature exists to tell,
-- and the sources panel can show it.
create or replace function match_chunks_fts (
  query_text      text,
  query_embedding vector(1536),
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
  where to_tsvector('english', c.content) @@ to_or_tsquery(query_text)
  order by rank desc
  limit match_count;
$$;

-- Verify:
--   select id, round(rank::numeric, 4), round(similarity::numeric, 3)
--   from match_chunks_fts('extension 4417', (select embedding from chunks limit 1), 5);
