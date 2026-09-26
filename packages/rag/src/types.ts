// The shapes the web app codes against.
//
// In the POC these existed only as the properties an object literal happened to
// have, documented in a JSDoc block and enforced by nothing. They are the API
// between the pipeline and the two screens, so they get names.

import type { DbClient, MatchRow } from '@rag/db';

/**
 * What the pipeline needs to know about a tenant.
 *
 * A value object, not a row. It is narrower than the `tenants` table on
 * purpose: `admin_key_hash` is not in this type, so it cannot end up in a JSON
 * response by accident, however the object gets passed around.
 *
 * Every pipeline function that touches the database takes one of these as a
 * REQUIRED first argument (D-027). There is no default and no ambient "current
 * tenant". A call site that forgets to say which tenant it means does not
 * compile.
 */
export interface TenantContext {
  id: number;
  slug: string;
  businessName: string;
  assistantName: string;
  /**
   * What the chat shows when the documents cannot answer, in place of the
   * internal refusal marker NO_ANSWER, one per reply language (D-047,
   * D-048). A missing language is the built-in default in that language
   * (refusal.ts).
   */
  fallbackMessages: FallbackMessages;
  /**
   * The database, AS this tenant: a client holding a token minted for it
   * (auth-rls Phase 3, D-039). Postgres's RLS policies compare every row
   * against that token, so this is the second wall behind every
   * `.eq('tenant_id', …)` below, which all stay (Rule 1).
   *
   * D-027 said a forgotten tenant should not compile. Now a forgotten tenant
   * also means no database at all: there is no module-level client left to
   * reach for.
   *
   * NEVER pass a TenantContext to a Client Component. Pages pass named props.
   * The token in here is five minutes of this tenant's database.
   */
  db: DbClient;
}

/** A tenant's refusal wording per reply language. Keys match LanguagePreference (language.ts). */
export type FallbackMessages = Partial<Record<'english' | 'taglish' | 'tagalog', string>>;

/** Which search found a chunk. Rendered as a badge in the sources panel (D-015). */
export type FoundBy = 'vector' | 'keyword' | 'both';

/** One turn of stored conversation. The database `check` constrains role to these two. */
export interface HistoryMessage {
  role: 'user' | 'assistant';
  content: string;
}

/** A chunk that survived fusion: a database row plus how it got here. */
export interface RetrievedChunk extends MatchRow {
  /** The Reciprocal Rank Fusion score. Internal — never shown to a user. */
  score: number;
  foundBy: FoundBy;
}

/**
 * A retrieved chunk as the UI receives it.
 *
 * Deliberately a product feature, not debug output (D-012): showing the exact
 * text an answer was built from is what makes the answer checkable, and
 * `foundBy` is what makes "an exact keyword match the vector search would have
 * missed" visible rather than mysterious.
 */
export interface Source {
  id: number;
  documentId: number;
  documentTitle: string;
  content: string;
  similarity: number;
  foundBy: FoundBy;
}

/**
 * One tool call made while answering, as the UI shows it (D-037).
 *
 * The same argument as for Source (D-012). A tool result is part of what the
 * answer was built from, so it is shown, not hidden. `result` is exactly what
 * the model was given: SlotAvailability rows, or `{ error }`. It carries no
 * guest data, because the executor only ever calls checkAvailability
 * (plan/bookings.md Rule 3).
 */
export interface ToolCallRecord {
  name: string;
  /** The arguments as the model wrote them, parsed. Null if they were not valid JSON. */
  args: Record<string, unknown> | null;
  result: unknown;
}

/** The non-streaming reply. */
export interface Answer {
  conversationId: string;
  /** What the user sees. A refusal is the tenant's friendly message here, never the marker (D-047). */
  reply: string;
  /**
   * True when the documents (and tools) could not answer: the saved reply is
   * NO_ANSWER and `reply` is the friendly message. How callers tell a refusal
   * apart now that its wording is per tenant.
   */
  refused: boolean;
  sources: Source[];
  /** Empty for a tenant with no tools, and for any turn where the model called none. */
  toolCalls: ToolCallRecord[];
  /**
   * What retrieval actually searched for, which is not always what was typed
   * (D-016). Returned so the UI can show it — a retriever silently searching
   * for something else is exactly what should be visible rather than hidden.
   */
  searchQuery: string;
}

/** The `meta` event, sent once as soon as retrieval is done and before any answer exists. */
export interface StreamMeta {
  conversationId: string;
  searchQuery: string;
  sources: Source[];
}

/** One document in the admin list. `chunkCount` of 0 is the R-7 orphan the UI flags. */
export interface DocumentSummary {
  id: number;
  title: string;
  source: string | null;
  created_at: string;
  chunkCount: number;
}

/** One document with its full original text, for the admin page's edit form. */
export interface DocumentDetail {
  id: number;
  title: string;
  source: string | null;
  content: string;
}

/** One chunk as the admin page's expandable row shows it — without the embedding. */
export interface ChunkSummary {
  id: number;
  chunk_index: number;
  content: string;
}

export interface IngestResult {
  id: number;
  title: string;
  chunkCount: number;
}

/** One question the documents could not answer, as the S-4 staff screen lists it. `id` is the refusal's message id. */
export interface UnansweredQuestion {
  id: number;
  question: string;
  askedAt: string;
  /** When staff marked it resolved (D-045), or null while it is open. */
  resolvedAt: string | null;
}
