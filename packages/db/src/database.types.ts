// database.types.ts — the shape of the database, for @supabase/supabase-js.
//
// HAND-WRITTEN FROM `sql/schema.sql`, `sql/schema-hybrid.sql` AND
// `sql/schema-tenancy.sql`, not generated. This describes the schema AFTER the
// D-031 bridge is removed: `tenant_id` is required on every insert, and only
// the tenant-scoped signatures of the two search functions exist.
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
// So these are written from the .sql files, which are committed, are what
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
      tenants: {
        Row: {
          id: number;
          /** the /t/<slug> segment; shape and reserved words are checked in SQL */
          slug: string;
          business_name: string;
          assistant_name: string;
          logo_url: string | null;
          banner_url: string | null;
          theme: Json;
          /** scrypt hash. null means nobody can administer this tenant. NEVER select it casually. */
          admin_key_hash: string | null;
          created_at: string;
        };
        Insert: {
          id?: never;
          slug: string;
          business_name: string;
          assistant_name: string;
          logo_url?: string | null;
          banner_url?: string | null;
          theme?: Json;
          admin_key_hash?: string | null;
          created_at?: string;
        };
        Update: {
          id?: never;
          slug?: string;
          business_name?: string;
          assistant_name?: string;
          logo_url?: string | null;
          banner_url?: string | null;
          theme?: Json;
          admin_key_hash?: string | null;
          created_at?: string;
        };
        Relationships: [];
      };
      documents: {
        Row: {
          id: number;
          tenant_id: number;
          title: string;
          /** optional: url, filename, note */
          source: string | null;
          /** the full original text */
          content: string;
          created_at: string;
        };
        Insert: {
          /** required: no default once the D-031 bridge is removed */
          tenant_id: number;
          /** `generated always as identity` — never supplied by the client */
          id?: never;
          title: string;
          source?: string | null;
          content: string;
          created_at?: string;
        };
        Update: {
          tenant_id?: number;
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
          tenant_id: number;
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
          /** required: no default once the D-031 bridge is removed */
          tenant_id: number;
          id?: never;
          document_id: number;
          chunk_index: number;
          content: string;
          embedding: VectorInput;
          created_at?: string;
        };
        Update: {
          tenant_id?: number;
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
          {
            foreignKeyName: 'chunks_document_tenant_fk';
            columns: ['document_id', 'tenant_id'];
            referencedRelation: 'documents';
            referencedColumns: ['id', 'tenant_id'];
          },
        ];
      };
      conversations: {
        Row: {
          /** uuid, `default gen_random_uuid()` */
          id: string;
          tenant_id: number;
          created_at: string;
        };
        /** Every column but tenant_id has a default. */
        Insert: {
          /** required: no default once the D-031 bridge is removed */
          tenant_id: number;
          id?: string;
          created_at?: string;
        };
        Update: {
          tenant_id?: number;
          id?: string;
          created_at?: string;
        };
        Relationships: [];
      };
      messages: {
        Row: {
          id: number;
          tenant_id: number;
          conversation_id: string;
          /** `check (role in ('user', 'assistant'))` — the database enforces this */
          role: 'user' | 'assistant';
          content: string;
          created_at: string;
        };
        Insert: {
          /** required: no default once the D-031 bridge is removed */
          tenant_id: number;
          id?: never;
          conversation_id: string;
          role: 'user' | 'assistant';
          content: string;
          created_at?: string;
        };
        Update: {
          tenant_id?: number;
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
          {
            foreignKeyName: 'messages_conversation_tenant_fk';
            columns: ['conversation_id', 'tenant_id'];
            referencedRelation: 'conversations';
            referencedColumns: ['id', 'tenant_id'];
          },
        ];
      };
    };
    Views: Record<never, never>;
    Functions: {
      /** sql/schema-tenancy.sql § 8 — cosine similarity search within ONE tenant. */
      match_chunks: {
        Args: {
          query_embedding: VectorInput;
          /** no default in SQL, and required here: a forgotten tenant is a compile error */
          p_tenant_id: number;
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
      /** sql/schema-tenancy.sql § 8 — keyword search within ONE tenant, reporting BOTH scores. */
      match_chunks_fts: {
        Args: {
          query_text: string;
          query_embedding: VectorInput;
          p_tenant_id: number;
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
