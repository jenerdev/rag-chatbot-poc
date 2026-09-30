// database.types.ts — the shape of the database, for @supabase/supabase-js.
//
// HAND-WRITTEN FROM `sql/schema.sql`, `sql/schema-hybrid.sql`,
// `sql/schema-tenancy.sql`, `sql/schema-bookings.sql`,
// `sql/schema-booking-types.sql`, `sql/schema-extra-guests.sql` AND
// `sql/schema-customer-booking.sql`, not generated. This describes the schema AFTER the
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

/** `memberships.role` (sql/schema-roles.sql § 1): what a member may do, decided per request from the row. */
export type MemberRole = 'owner' | 'admin' | 'staff';

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
          /** what the chat shows when the documents cannot answer, per reply language (D-047, D-048); a missing key or null = the built-in default */
          fallback_messages: Json | null;
          /** set by the platform (tenant management Phase 1): tenant_public() no longer returns the row, so the whole app answers 404 for it */
          archived_at: string | null;
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
          fallback_messages?: Json | null;
          archived_at?: string | null;
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
          fallback_messages?: Json | null;
          archived_at?: string | null;
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
          /**
           * for bookings: `{ timezone, booking_type?, weekend_days?, currency? }`, validated
           * by a trigger. timezone is required; booking_type absent = 'whole_resort'
           * (schema-booking-types.sql § 1).
           */
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
      /**
       * sql/schema-bookings.sql § 3 — a thing that can be booked; a room, for a
       * per_room tenant (schema-booking-types.sql § 2). Never deleted by a token:
       * deactivated, so the bookings that name it keep their unit.
       */
      units: {
        Row: {
          id: number;
          tenant_id: number;
          name: string;
          description: string | null;
          /** the MAXIMUM guests (D-065); null = not stated, so never offered for a guest-count search */
          capacity: number | null;
          /** guests the base rate covers (schema-extra-guests.sql); null = no extra-guest fee */
          standard_capacity: number | null;
          /** centavos per guest above standard, per booking; null = no fee */
          extra_person_rate: number | null;
          active: boolean;
          sort_order: number;
          created_at: string;
        };
        Insert: {
          tenant_id: number;
          id?: never;
          name: string;
          description?: string | null;
          capacity?: number | null;
          standard_capacity?: number | null;
          extra_person_rate?: number | null;
          active?: boolean;
          sort_order?: number;
          created_at?: string;
        };
        Update: {
          tenant_id?: number;
          id?: never;
          name?: string;
          description?: string | null;
          capacity?: number | null;
          standard_capacity?: number | null;
          extra_person_rate?: number | null;
          active?: boolean;
          sort_order?: number;
          created_at?: string;
        };
        Relationships: [];
      };
      /** sql/schema-customer-booking.sql § 1 — holiday and peak dates, per tenant; surcharge in CENTAVOS. */
      rate_calendar: {
        Row: {
          tenant_id: number;
          /** `date`, as "YYYY-MM-DD" */
          day: string;
          kind: 'holiday' | 'peak' | 'closed';
          label: string;
          surcharge: number;
          created_at: string;
        };
        Insert: {
          tenant_id: number;
          day: string;
          kind?: 'holiday' | 'peak' | 'closed';
          label: string;
          surcharge?: number;
          created_at?: string;
        };
        Update: {
          tenant_id?: never;
          day?: string;
          kind?: 'holiday' | 'peak' | 'closed';
          label?: string;
          surcharge?: number;
          created_at?: string;
        };
        Relationships: [];
      };
      /** sql/schema-booking-types.sql § 3 — one price per (unit, slot), in CENTAVOS. */
      unit_rates: {
        Row: {
          tenant_id: number;
          unit_id: number;
          slot_id: number;
          weekday_price: number;
          weekend_price: number;
          /** schema-customer-booking.sql § 2 — null means the weekend rate on a calendar day */
          holiday_price: number | null;
          updated_at: string;
        };
        Insert: {
          tenant_id: number;
          unit_id: number;
          slot_id: number;
          weekday_price: number;
          weekend_price: number;
          holiday_price?: number | null;
          updated_at?: string;
        };
        Update: {
          tenant_id?: number;
          unit_id?: number;
          slot_id?: number;
          weekday_price?: number;
          weekend_price?: number;
          holiday_price?: number | null;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'unit_rates_unit_tenant_fk';
            columns: ['unit_id', 'tenant_id'];
            referencedRelation: 'units';
            referencedColumns: ['id', 'tenant_id'];
          },
          {
            foreignKeyName: 'unit_rates_slot_tenant_fk';
            columns: ['slot_id', 'tenant_id'];
            referencedRelation: 'slots';
            referencedColumns: ['id', 'tenant_id'];
          },
        ];
      };
      /**
       * sql/schema-booking-types.sql § 10 — one row per photo in the `unit-images`
       * bucket. `path` is '<tenant_id>/<unit_id>/<uuid>.<ext>' (a check says so),
       * and only sort_order may be updated (a column grant says so).
       */
      unit_images: {
        Row: {
          id: number;
          tenant_id: number;
          unit_id: number;
          path: string;
          sort_order: number;
          created_at: string;
        };
        Insert: {
          tenant_id: number;
          id?: never;
          unit_id: number;
          path: string;
          sort_order?: number;
          created_at?: string;
        };
        Update: {
          sort_order?: number;
        };
        Relationships: [
          {
            foreignKeyName: 'unit_images_unit_tenant_fk';
            columns: ['unit_id', 'tenant_id'];
            referencedRelation: 'units';
            referencedColumns: ['id', 'tenant_id'];
          },
        ];
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
          /** schema-customer-booking.sql § 3 — a stay of N nights is N rows of a nightly slot */
          nightly: boolean;
          created_at: string;
        };
        Insert: {
          tenant_id: number;
          id?: never;
          name: string;
          start_time: string;
          duration: string;
          nightly?: boolean;
          created_at?: string;
        };
        Update: {
          tenant_id?: number;
          id?: never;
          name?: string;
          start_time?: string;
          duration?: string;
          nightly?: boolean;
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
          /** centavos, the TOTAL, set by the insert trigger from unit_quote(); null for whole_resort and for old rows */
          price: number | null;
          /** the rate part and the extra-guest part of `price` (schema-extra-guests.sql); null likewise */
          base_price: number | null;
          extra_guest_price: number | null;
          /** shared by the rows of one multi-room booking (plan § 2.5) */
          group_id: string | null;
          /** schema-customer-booking.sql § 4 — the calendar's part of `price`; null likewise */
          surcharge: number | null;
          /** 'staff' for every row a staff member or tool made; 'web' for request_booking() */
          source: 'staff' | 'web';
          /** for people, shared by the rows of one request; grants nothing */
          reference: string | null;
          guest_email: string | null;
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
          /** computed by the trigger, which overwrites anything supplied (plan Rule 2) */
          price?: never;
          base_price?: never;
          extra_guest_price?: never;
          surcharge?: never;
          group_id?: string | null;
          /** web rows come from request_booking() only; staff inserts leave the default */
          source?: 'staff';
          reference?: never;
          guest_email?: string | null;
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
          price?: never;
          base_price?: never;
          extra_guest_price?: never;
          surcharge?: never;
          group_id?: string | null;
          /** web rows come from request_booking() only; staff inserts leave the default */
          source?: 'staff';
          reference?: never;
          guest_email?: string | null;
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
          /** sql/schema-roles.sql § 1 — what this member may do (plan/tenant-management.md § 3.2); read on every request, never a claim */
          role: MemberRole;
          created_at: string;
        };
        Insert: {
          user_id: string;
          tenant_id: number;
          /** REQUIRED: the column has no default (every pre-roles row was backfilled to admin) */
          role: MemberRole;
          created_at?: string;
        };
        Update: {
          user_id?: string;
          tenant_id?: number;
          role?: MemberRole;
          created_at?: string;
        };
        Relationships: [];
      };
      /**
       * sql/schema-roles.sql § 1 — who runs the platform (the super user). No
       * tenant_id: a super user is not a member of anything. Rows are written
       * by the CLI (super:add) on service_role; a token reads only its own row.
       */
      platform_admins: {
        Row: {
          user_id: string;
          created_at: string;
        };
        Insert: {
          user_id: string;
          created_at?: string;
        };
        Update: {
          user_id?: string;
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
      /** sql/schema-roles.sql § 2 — the membership row's role for a staff token's user and tenant; null for a chat or platform token, or a non-member. */
      app_role: {
        Args: Record<never, never>;
        Returns: MemberRole | null;
      };
      /** sql/schema-auth.sql § 2, redefined in schema-roles.sql § 2 — owner or admin of the token's tenant. */
      app_is_admin: {
        Args: Record<never, never>;
        Returns: boolean;
      };
      /** sql/schema-roles.sql § 2 — any member of the token's tenant (owner, admin or staff). */
      app_is_staff: {
        Args: Record<never, never>;
        Returns: boolean;
      };
      /** sql/schema-roles.sql § 2 — app_super claim AND a platform_admins row. */
      app_is_super: {
        Args: Record<never, never>;
        Returns: boolean;
      };
      /** sql/schema-roles.sql § 9 — one tenant's members with their email and role; a member of that tenant or the platform, else 42501. */
      member_emails: {
        Args: { p_tenant_id: number };
        Returns: {
          user_id: string;
          email: string;
          role: MemberRole;
          created_at: string;
        }[];
      };
      /** sql/schema-roles.sql § 9 — an account's id by email (trimmed, any case), or null; an owner or the platform, else 42501 (R-42). */
      user_id_by_email: {
        Args: { p_email: string };
        Returns: string | null;
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
          fallback_messages: Json | null;
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
      /**
       * sql/schema-booking-types.sql § 8 — per_room only: priced, active rooms,
       * per (date, room, slot). Capacity and price, and still no guest data.
       * Zero rows for a whole_resort tenant.
       */
      check_room_availability: {
        Args: {
          p_tenant_id: number;
          p_from: string;
          p_to: string;
          /** slot name, or null for any; likewise unit and guests */
          p_slot: string | null;
          p_unit: string | null;
          p_guests: number | null;
        };
        Returns: {
          booked_date: string;
          unit: string;
          capacity: number | null;
          standard_capacity: number | null;
          extra_person_rate: number | null;
          slot: string;
          status: 'open' | 'taken';
          /** centavos: the BASE price for that date */
          price: number;
          /** for p_guests (0 when it is null): the extra-guest fee, and base + fee */
          extra_guest_price: number;
          total: number;
          /** sql/schema-day-price.sql (D-083): unit_quote()'s price with no guest count, the surcharge in */
          day_price: number;
        }[];
      };
      /**
       * sql/schema-rate-kind.sql § 3 — each date's rate kind, from rate_kind(),
       * the branch unit_price() prices by (D-082). Invoker; at most 366 days.
       */
      rate_kinds: {
        Args: { p_tenant_id: number; p_from: string; p_to: string };
        Returns: { day: string; kind: 'weekday' | 'weekend' | 'holiday' | 'peak' | 'closed' }[];
      };
      /**
       * sql/schema-customer-booking.sql § 11 — THE public write: pending rows only,
       * one per unit per night, priced by the trigger. Security definer; checks
       * the token's tenant itself.
       */
      request_booking: {
        Args: {
          p_tenant_id: number;
          p_slot_id: number;
          p_unit_ids: number[];
          p_guests: number[];
          /** "YYYY-MM-DD", the first night */
          p_check_in: string;
          p_nights: number;
          p_name: string;
          p_phone: string;
          p_email: string;
          p_notes: string | null;
        };
        Returns: {
          reference: string;
          booked_date: string;
          unit: string;
          slot: string;
          starts_at: string;
          ends_at: string;
          guests: number;
          base_price: number;
          extra_guest_price: number;
          surcharge: number;
          price: number;
        }[];
      };
      /** sql/schema-customer-booking.sql § 7 — THE price arithmetic (holidays included); no row = no rate. */
      unit_quote: {
        Args: { p_tenant_id: number; p_unit_id: number; p_slot_id: number; p_date: string; p_guests: number | null };
        Returns: { base_price: number; extra_guests: number; extra_guest_price: number; surcharge: number; price: number }[];
      };
      /** sql/schema-booking-types.sql § 5 — THE price of a (unit, slot, date), or null: no rate. */
      unit_price: {
        Args: { p_tenant_id: number; p_unit_id: number; p_slot_id: number; p_date: string };
        Returns: number | null;
      };
      /** sql/schema-booking-types.sql § 1 — 'whole_resort' unless config says 'per_room'. */
      booking_type_of: {
        Args: { p_tenant_id: number };
        Returns: 'whole_resort' | 'per_room';
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
