// database.types.ts — the shape of the database, for @supabase/supabase-js.
//
// HAND-WRITTEN FROM `sql/schema.sql` AND `sql/schema-hybrid.sql`, not generated.
//
// The plan called for `supabase gen types typescript`, which needs either a
// personal access token (`supabase login`, interactive) or a database URL. The
// direct host no longer resolves —
//
//     getaddrinfo ENOTFOUND db.<ref>.supabase.co
//
// — because Supabase serves direct connections over IPv6 only now; reaching the
// database from a script means the connection pooler, whose hostname carries a
// region this repo does not record.
//
// So these are written from the two .sql files, which are committed, are what
// actually ran, and are the source of truth this project already treats as
// authoritative. To regenerate once credentials are to hand:
//
//     pnpm dlx supabase login
//     pnpm dlx supabase gen types typescript --project-id <ref> \
//       > packages/db/src/database.types.ts
//
// and diff the result against this file rather than trusting either blindly.

export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

/**
 * How a `vector(1536)` column crosses the wire.
 *
 * **Reading it back gives you a string, not an array.** Measured on this
 * database (`plan/baseline/db-state.md`):
 *
 *     typeof = string   JSON.parse(...).length = 1536   first = 0.00051546097
 *
 * Nothing is broken and this is *not* the trap in `CLAUDE.md` § 5 — the column
 * is a real `vector(1536)`, and `match_chunks` orders by `<=>` against it,
 * which a text column could not do. What is a string is only PostgREST's JSON
 * serialisation of the vector type on the way out.
 *
 * Typing this as `number[]` because that is what it "should" be would be a lie
 * the compiler accepts and the runtime does not — precisely the failure mode
 * TypeScript is being adopted here to prevent. Anything that reads a stored
 * embedding back into JavaScript has to parse it, and the type says so.
 *
 * Writing is the other direction: a plain `number[]` is accepted and stored.
 */
export type StoredVector = string;
export type VectorInput = number[] | string;

export interface Database {
  public: {
    Tables: {
      documents: {
        Row: {
          id: number;
          title: string;
          /** optional: url, filename, note */
          source: string | null;
          /** the full original text */
          content: string;
          created_at: string;
        };
        Insert: {
          /** `generated always as identity` — never supplied by the client */
          id?: never;
          title: string;
          source?: string | null;
          content: string;
          created_at?: string;
        };
        Update: {
          id?: never;
          title?: string;
          source?: string | null;
          content?: string;
          created_at?: string;
        };
        Relationships: [];
      };
      chunks: {
        Row: {
          id: number;
          document_id: number;
          /** position within the document */
          chunk_index: number;
          /** the chunk text, shown as a source */
          content: string;
          /** see StoredVector — a string on the way out */
          embedding: StoredVector;
          created_at: string;
        };
        Insert: {
          id?: never;
          document_id: number;
          chunk_index: number;
          content: string;
          embedding: VectorInput;
          created_at?: string;
        };
        Update: {
          id?: never;
          document_id?: number;
          chunk_index?: number;
          content?: string;
          embedding?: VectorInput;
          created_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'chunks_document_id_fkey';
            columns: ['document_id'];
            referencedRelation: 'documents';
            referencedColumns: ['id'];
          },
        ];
      };
      conversations: {
        Row: {
          /** uuid, `default gen_random_uuid()` */
          id: string;
          created_at: string;
        };
        /** Every column has a default — which is why `.insert({})` is legal. */
        Insert: {
          id?: string;
          created_at?: string;
        };
        Update: {
          id?: string;
          created_at?: string;
        };
        Relationships: [];
      };
      messages: {
        Row: {
          id: number;
          conversation_id: string;
          /** `check (role in ('user', 'assistant'))` — the database enforces this */
          role: 'user' | 'assistant';
          content: string;
          created_at: string;
        };
        Insert: {
          id?: never;
          conversation_id: string;
          role: 'user' | 'assistant';
          content: string;
          created_at?: string;
        };
        Update: {
          id?: never;
          conversation_id?: string;
          role?: 'user' | 'assistant';
          content?: string;
          created_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'messages_conversation_id_fkey';
            columns: ['conversation_id'];
            referencedRelation: 'conversations';
            referencedColumns: ['id'];
          },
        ];
      };
    };
    Views: Record<never, never>;
    Functions: {
      /** sql/schema.sql § 7 — cosine similarity search. */
      match_chunks: {
        Args: {
          query_embedding: VectorInput;
          match_count?: number;
          min_similarity?: number;
        };
        Returns: {
          id: number;
          document_id: number;
          content: string;
          similarity: number;
        }[];
      };
      /** sql/schema-hybrid.sql § 3 — keyword search, reporting BOTH scores. */
      match_chunks_fts: {
        Args: {
          query_text: string;
          query_embedding: VectorInput;
          match_count?: number;
        };
        Returns: {
          id: number;
          document_id: number;
          content: string;
          similarity: number;
          rank: number;
        }[];
      };
      /** sql/schema-hybrid.sql § 2 — called only from inside match_chunks_fts. */
      to_or_tsquery: {
        Args: { query_text: string };
        Returns: unknown;
      };
    };
    Enums: Record<never, never>;
    CompositeTypes: Record<never, never>;
  };
}
