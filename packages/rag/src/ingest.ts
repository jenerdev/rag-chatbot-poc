// ingest.ts — text -> chunks -> embeddings -> rows, plus the supporting reads.

import { chunkText } from '@rag/chunker';
import { embed } from '@rag/openai';
import type { ChunkSummary, DocumentSummary, IngestResult, TenantContext } from './types.js';

/**
 * Store a document and make it searchable.
 *
 * The flow, matching architecture.md § 3.1:
 *   1. split the text into overlapping chunks
 *   2. insert the documents row
 *   3. embed every chunk in ONE OpenAI call
 *   4. insert the chunks rows, each with its vector
 *
 * Both inserts carry `tenant_id`. The chunk's copy is not trusted: the composite
 * foreign key `(document_id, tenant_id)` makes Postgres refuse a chunk whose
 * tenant disagrees with its document's (schema-tenancy.sql step 6).
 */
export async function ingestDocument({
  tenant,
  title,
  source,
  content,
}: {
  tenant: TenantContext;
  title: string;
  source?: string | null;
  content: string;
}): Promise<IngestResult> {
  // 1. Chunk first, before touching the database or the network.
  //    If the text produces nothing, there is no point creating a row.
  const chunks = chunkText(content);
  if (chunks.length === 0) throw new Error('Document is empty after trimming — nothing to ingest');
  console.log(`[ingest] ${tenant.slug} "${title}": ${content.length} chars -> ${chunks.length} chunks`);

  // 2. Insert the parent row. We need its id before the chunks can reference it.
  const { data: doc, error: docError } = await tenant.db
    .from('documents')
    .insert({ tenant_id: tenant.id, title, source: source || null, content })
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
      tenant_id: tenant.id,
      document_id: doc.id,
      chunk_index: index,
      content: text,
      embedding: vectors[index]!,
    }));

    // Every row carries tenant_id (set above), and the composite FK checks it.
    const { error: chunkError } = await tenant.db.from('chunks').insert(rows);
    if (chunkError) throw new Error(`Could not save the chunks: ${chunkError.message}`);

    return { id: doc.id, title: doc.title, chunkCount: chunks.length };
  } catch (error) {
    // Roll back the orphan. Deleting the document cascades to any chunks that
    // did land, so this is safe whether the failure happened before or after
    // the chunk insert.
    console.error(`[ingest] failed after creating document ${doc.id} — cleaning up`);
    await tenant.db.from('documents').delete().eq('tenant_id', tenant.id).eq('id', doc.id);
    throw error;
  }
}

/**
 * One tenant's documents, newest first, with how many chunks each became.
 *
 * `chunks(count)` is PostgREST's aggregate over the foreign-key relationship —
 * it counts the related rows without fetching them, which matters because the
 * embeddings are ~6 KB each and we want none of them here.
 *
 * The relationship is NAMED (`!chunks_document_tenant_fk`). Tenancy added a
 * second foreign key from chunks to documents, the composite one, and with two
 * to choose from PostgREST refuses to guess: "more than one relationship was
 * found for 'documents' and 'chunks'". The composite one is the right choice,
 * because it can only ever join a chunk to a document of the same tenant.
 *
 * A document showing 0 chunks is the orphan from R-7 and the admin page flags
 * it. It should never happen now that ingest cleans up after itself, but the
 * badge stays: a symptom you can see beats one you cannot.
 */
export async function listDocuments(tenant: TenantContext): Promise<DocumentSummary[]> {
  const { data, error } = await tenant.db
    .from('documents')
    .select('id, title, source, created_at, chunks!chunks_document_tenant_fk(count)')
    .eq('tenant_id', tenant.id)
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
 * How many documents this tenant has. Counted by Postgres, with no rows fetched.
 *
 * The chat page uses it to say "your knowledge base is empty" before the user
 * wonders why every answer is a refusal. It is a separate function from
 * listDocuments() because the list is admin-only (Phase 6), while "is there
 * anything to ask about?" is something any visitor may know.
 */
export async function countDocuments(tenant: TenantContext): Promise<number> {
  const { count, error } = await tenant.db
    .from('documents')
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', tenant.id);
  if (error) throw new Error(`Could not count documents: ${error.message}`);
  return count ?? 0;
}

/**
 * Delete a document. Its chunks go with it.
 *
 * The cascade is declared in schema.sql (`on delete cascade`) and Postgres
 * enforces it, so there is no second delete to write here. This is the half of
 * the project's success criterion that proves retrieval is real: delete the
 * document, ask the same question, and the bot must stop knowing the answer.
 *
 * `false` means "not yours OR not there", and the two are deliberately
 * indistinguishable. A 404 that meant "this exists but belongs to someone else"
 * would let anyone enumerate other tenants' document ids.
 */
export async function deleteDocument(tenant: TenantContext, id: number): Promise<boolean> {
  const { error, count } = await tenant.db
    .from('documents')
    .delete({ count: 'exact' })
    .eq('tenant_id', tenant.id)
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
 *
 * Another tenant's document id returns an empty list, the same as an id that
 * does not exist.
 */
export async function getChunks(tenant: TenantContext, documentId: number): Promise<ChunkSummary[]> {
  const { data, error } = await tenant.db
    .from('chunks')
    .select('id, chunk_index, content')
    .eq('tenant_id', tenant.id)
    .eq('document_id', documentId)
    .order('chunk_index', { ascending: true });
  if (error) throw new Error(`Could not load chunks: ${error.message}`);
  return data;
}
