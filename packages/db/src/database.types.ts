// database.types.ts — the shape of the database, for @supabase/supabase-js.
//
// HAND-WRITTEN FROM `sql/schema.sql`, `sql/schema-hybrid.sql`,
// `sql/schema-tenancy.sql` AND `sql/schema-bookings.sql`, not generated. This describes the schema AFTER the
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
          /** what the chat shows when the documents cannot answer (D-047); null = the built-in default */
          fallback_message: string | null;
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
          fallback_message?: string | null;
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
          fallback_message?: string | null;
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
      /** sql/schema-unanswered.sql § 2 — a row means staff marked that refusal resolved (D-045). Staff-only RLS. */
      unanswered_resolutions: {
        Row: {
          /** the REFUSAL's id: the assistant message, as the S-4 list carries it */
          message_id: number;
          tenant_id: number;
          resolved_at: string;
        };
        Insert: {
          message_id: number;
          tenant_id: number;
          resolved_at?: string;
        };
        /** no update policy: a resolution is added or removed, never changed */
        Update: Record<never, never>;
        Relationships: [
          {
            foreignKeyName: 'unanswered_resolutions_message_fk';
            columns: ['message_id', 'tenant_id'];
            // false, as PostgREST sees it: message_id alone is the unique key,
            // not (message_id, tenant_id), so it embeds the resolution as an
            // ARRAY of at most one. Declared true, the type said object and
            // the value was an array (isolation check 16, first run).
            isOneToOne: false;
            referencedRelation: 'messages';
            referencedColumns: ['id', 'tenant_id'];
          },
        ];
      };
      /** sql/schema-bookings.sql § 2 — a row means the application is on for that tenant (D-033). */
      tenant_applications: {
        Row: {
          tenant_id: number;
          /** `check (application_key in ('bookings'))`, the same keys as the code registry */
          application_key: 'bookings';
          /** for bookings: `{ timezone: <IANA name> }`, required and validated by a trigger */
          config: Json;
          created_at: string;
        };
        Insert: {
          tenant_id: number;
          application_key: 'bookings';
          config?: Json;
          created_at?: string;
        };
        Update: {
          tenant_id?: number;
          application_key?: 'bookings';
          config?: Json;
          created_at?: string;
        };
        Relationships: [];
      };
      /** sql/schema-bookings.sql § 3 — a thing that can be booked. */
      units: {
        Row: {
          id: number;
          tenant_id: number;
          name: string;
          created_at: string;
        };
        Insert: {
          tenant_id: number;
          id?: never;
          name: string;
          created_at?: string;
        };
        Update: {
          tenant_id?: number;
          id?: never;
          name?: string;
          created_at?: string;
        };
        Relationships: [];
      };
      /** sql/schema-bookings.sql § 4 — a named time window, in the tenant's timezone. */
      slots: {
        Row: {
          id: number;
          tenant_id: number;
          name: string;
          /** `time`, as "HH:MM:SS" */
          start_time: string;
          /** `interval`, as PostgREST renders it, e.g. "22:00:00" */
          duration: string;
          created_at: string;
        };
        Insert: {
          tenant_id: number;
          id?: never;
          name: string;
          start_time: string;
          duration: string;
          created_at?: string;
        };
        Update: {
          tenant_id?: number;
          id?: never;
          name?: string;
          start_time?: string;
          duration?: string;
          created_at?: string;
        };
        Relationships: [];
      };
      /** sql/schema-bookings.sql § 5 — guest data lives here and ONLY here; check_availability never returns it. */
      bookings: {
        Row: {
          id: number;
          tenant_id: number;
          unit_id: number;
          slot_id: number;
          /** `date`, as "YYYY-MM-DD": the date the slot starts on */
          booked_date: string;
          /** `tstzrange`, as a string like `["2026-10-01 06:00:00+00","2026-10-02 04:00:00+00")` */
          during: string;
          /** `check (status in ('pending','confirmed','cancelled'))` */
          status: 'pending' | 'confirmed' | 'cancelled';
          guest_name: string;
          guest_phone: string | null;
          guest_count: number | null;
          notes: string | null;
          created_at: string;
        };
        Insert: {
          tenant_id: number;
          id?: never;
          unit_id: number;
          slot_id: number;
          booked_date: string;
          /** computed by the bookings_compute_during trigger, which overwrites anything supplied */
          during?: never;
          status?: 'pending' | 'confirmed' | 'cancelled';
          guest_name: string;
          guest_phone?: string | null;
          guest_count?: number | null;
          notes?: string | null;
          created_at?: string;
        };
        Update: {
          tenant_id?: number;
          id?: never;
          unit_id?: number;
          slot_id?: number;
          booked_date?: string;
          during?: never;
          status?: 'pending' | 'confirmed' | 'cancelled';
          guest_name?: string;
          guest_phone?: string | null;
          guest_count?: number | null;
          notes?: string | null;
          created_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'bookings_unit_tenant_fk';
            columns: ['unit_id', 'tenant_id'];
            referencedRelation: 'units';
            referencedColumns: ['id', 'tenant_id'];
          },
          {
            foreignKeyName: 'bookings_slot_tenant_fk';
            columns: ['slot_id', 'tenant_id'];
            referencedRelation: 'slots';
            referencedColumns: ['id', 'tenant_id'];
          },
        ];
      };
      /**
       * sql/schema-auth.sql § 1 — who may administer which tenant. A row IS admin
       * (one role). Written only by the CLI with service_role; a token sees only
       * its own user's rows.
       */
      memberships: {
        Row: {
          user_id: string;
          tenant_id: number;
          created_at: string;
        };
        Insert: {
          user_id: string;
          tenant_id: number;
          created_at?: string;
        };
        Update: {
          user_id?: string;
          tenant_id?: number;
          created_at?: string;
        };
        Relationships: [];
      };
    };
    Views: Record<never, never>;
    Functions: {
      /** sql/schema-auth.sql § 2 — the token's tenant_id claim, or null. */
      app_tenant_id: {
        Args: Record<never, never>;
        Returns: number | null;
      };
      /** sql/schema-auth.sql § 2 — app_admin claim AND a membership for the token's tenant. */
      app_is_admin: {
        Args: Record<never, never>;
        Returns: boolean;
      };
      /**
       * sql/schema-auth.sql § 5 — the ONLY way a token reads a tenants row. The
       * column list is the boundary: no admin_key_hash. Callable by anon.
       */
      tenant_public: {
        Args: { p_slug: string };
        Returns: {
          id: number;
          slug: string;
          business_name: string;
          assistant_name: string;
          logo_url: string | null;
          banner_url: string | null;
          theme: Json;
          fallback_message: string | null;
        }[];
      };
      /** plan/auth-phase0-spike.sql — TEMPORARY: returns auth.jwt(). Dropped after auth-rls Phase 2. */
      whoami: {
        Args: Record<never, never>;
        Returns: Json;
      };
      /**
       * sql/schema-bookings.sql § 7 — open or taken, per (date, unit, slot), for ONE tenant.
       * Returns no guest data, by design (plan/bookings.md Rule 3).
       */
      check_availability: {
        Args: {
          /** no default in SQL, and required here (D-027) */
          p_tenant_id: number;
          /** "YYYY-MM-DD" */
          p_from: string;
          p_to: string;
        };
        Returns: {
          booked_date: string;
          unit: string;
          slot: string;
          status: 'open' | 'taken';
        }[];
      };
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
