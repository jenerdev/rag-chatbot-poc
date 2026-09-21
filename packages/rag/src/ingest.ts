// ingest.ts — text -> chunks -> embeddings -> rows, plus the supporting reads.

import { chunkText } from '@rag/chunker';
import { embed } from '@rag/openai';
import { supabase } from '@rag/db';
import type { ChunkSummary, DocumentSummary, IngestResult } from './types.js';

/**
 * Store a document and make it searchable.
 *
 * The flow, matching architecture.md § 3.1:
 *   1. split the text into overlapping chunks
 *   2. insert the documents row
 *   3. embed every chunk in ONE OpenAI call
 *   4. insert the chunks rows, each with its vector
 */
export async function ingestDocument({
  title,
  source,
  content,
}: {
  title: string;
  source?: string | null;
  content: string;
}): Promise<IngestResult> {
  // 1. Chunk first, before touching the database or the network.
  //    If the text produces nothing, there is no point creating a row.
  const chunks = chunkText(content);
  if (chunks.length === 0) throw new Error('Document is empty after trimming — nothing to ingest');
  console.log(`[ingest] "${title}": ${content.length} chars -> ${chunks.length} chunks`);

  // 2. Insert the parent row. We need its id before the chunks can reference it.
  const { data: doc, error: docError } = await supabase
    .from('documents')
    .insert({ title, source: source || null, content })
    .select('id, title')
    .single();
  if (docError) throw new Error(`Could not save the document: ${docError.message}`);

  // From here on the documents row EXISTS. If anything below fails we must
  // remove it, or we are left with a document that appears in the list but has
  // zero chunks and can therefore never be retrieved — visible, useless, and
  // with nothing to explain why (R-7). This is cleanup, not a transaction:
  // supabase-js speaks HTTP, so there is no BEGIN/COMMIT to wrap this in.
  try {
    // 3. One embeddings call for every chunk in the document (F-3).
    const vectors = await embed(chunks);
    console.log(`[ingest] embedded ${vectors.length} chunks, ${vectors[0]!.length} dims each`);

    // 4. One insert for all the chunk rows. chunk_index records the position
    //    within the document, which is what lets the admin page show the
    //    chunks in order and makes the overlap visible when you read them.
    const rows = chunks.map((text, index) => ({
      document_id: doc.id,
      chunk_index: index,
      content: text,
      embedding: vectors[index]!,
    }));

    const { error: chunkError } = await supabase.from('chunks').insert(rows);
    if (chunkError) throw new Error(`Could not save the chunks: ${chunkError.message}`);

    return { id: doc.id, title: doc.title, chunkCount: chunks.length };
  } catch (error) {
    // Roll back the orphan. Deleting the document cascades to any chunks that
    // did land, so this is safe whether the failure happened before or after
    // the chunk insert.
    console.error(`[ingest] failed after creating document ${doc.id} — cleaning up`);
    await supabase.from('documents').delete().eq('id', doc.id);
    throw error;
  }
}

/**
 * Every document, newest first, with how many chunks it became.
 *
 * `chunks(count)` is PostgREST's aggregate over the foreign-key relationship —
 * it counts the related rows without fetching them, which matters because the
 * embeddings are ~6 KB each and we want none of them here.
 *
 * A document showing 0 chunks is the orphan from R-7 and the admin page flags
 * it. It should never happen now that ingest cleans up after itself, but the
 * badge stays: a symptom you can see beats one you cannot.
 */
export async function listDocuments(): Promise<DocumentSummary[]> {
  const { data, error } = await supabase
    .from('documents')
    .select('id, title, source, created_at, chunks(count)')
    .order('created_at', { ascending: false });
  if (error) throw new Error(`Could not list documents: ${error.message}`);

  return data.map((doc) => ({
    id: doc.id,
    title: doc.title,
    source: doc.source,
    created_at: doc.created_at,
    chunkCount: doc.chunks[0]?.count ?? 0,
  }));
}

/**
 * Delete a document. Its chunks go with it.
 *
 * The cascade is declared in schema.sql (`on delete cascade`) and Postgres
 * enforces it, so there is no second delete to write here. This is the half of
 * the project's success criterion that proves retrieval is real: delete the
 * document, ask the same question, and the bot must stop knowing the answer.
 */
export async function deleteDocument(id: number): Promise<boolean> {
  const { error, count } = await supabase
    .from('documents')
    .delete({ count: 'exact' })
    .eq('id', id);
  if (error) throw new Error(`Could not delete the document: ${error.message}`);
  return (count ?? 0) > 0;
}

/**
 * Every chunk of one document, in order, without its embedding.
 *
 * Powers the expandable row on the admin page. Seeing your own text sliced up —
 * and seeing the overlap repeat across each boundary — is what makes chunking
 * concrete rather than theoretical (screens.md § S-2).
 *
 * The embedding column is deliberately not selected: it is ~6 KB per chunk and
 * a screenful of floats tells you nothing.
 */
export async function getChunks(documentId: number): Promise<ChunkSummary[]> {
  const { data, error } = await supabase
    .from('chunks')
    .select('id, chunk_index, content')
    .eq('document_id', documentId)
    .order('chunk_index', { ascending: true });
  if (error) throw new Error(`Could not load chunks: ${error.message}`);
  return data;
}
