# Flow — how a request actually travels through this code

> ### Current as of tenancy (2026-09-23)
>
> The Express POC became a Next.js app on a Turborepo monorepo (D-020, D-021),
> and then became multi-tenant (`plan.md`, D-025…D-030). Every request now
> starts by **resolving a tenant**, and every step after that is scoped to it.
> The pipeline itself (rewrite, embed, two searches, fuse, prompt, stream) is
> unchanged.

> **What this file is.** `architecture.md` § 3 has the *original MVP design*.
> This file has the **flow as built**, including the five post-MVP additions
> (D-015 hybrid search, D-016 query rewriting, D-017 prompt wording, D-018
> paragraph-aware chunking, D-019 streaming).
>
> Every box names the file and function that does the work, so you can read the
> diagram with the source open beside it.
>
> Last updated: 2026-09-23

---

## 1. The big picture

Three processes. The browser never talks to OpenAI or Supabase — that is the
only thing keeping your API key out of the page source (`risks.md` § R-1).
`@rag/db` imports `server-only`, so a Client Component that tried to import it
would fail the build.

```mermaid
flowchart LR
    subgraph B["Browser · React Client Components"]
        IDX["components/chat-screen.tsx<br/>at /t/&lt;slug&gt;"]
        BOOK["components/booking-page.tsx<br/>at /t/&lt;slug&gt;/book"]
        ADM["components/admin-screen.tsx<br/>at /t/&lt;slug&gt;/admin"]
        CHKB["@rag/chunker<br/>live chunk estimate"]
    end

    subgraph S["Next.js server · apps/web · owns every secret"]
        PAGE["app/t/[tenant]/*.tsx<br/>Server Components: tenant + branding as props"]
        RT["app/api/t/[tenant]/**/route.ts<br/>withTenantRoute → withRoute"]
        TEN["lib/tenant.ts<br/>slug → TenantContext, 404 on miss"]
        AUTH["lib/admin-auth.ts<br/>requireAdmin"]
        RAG["@rag/pipeline<br/>both pipelines, tenant first"]
        CHK["@rag/chunker<br/>pure, no imports"]
        AI["@rag/openai<br/>raw fetch"]
        DB["@rag/db<br/>one client, server-only"]
    end

    subgraph X["External"]
        OAI["OpenAI<br/>/embeddings<br/>/chat/completions"]
        PG["Supabase Postgres<br/>pgvector + full-text<br/>tenant_id on every row"]
    end

    IDX -- "POST /api/t/&lt;slug&gt;/chat" --> RT
    BOOK -- "book/quote, book/request" --> RT
    ADM -- "admin/session, documents" --> RT
    PAGE --> TEN
    RT --> TEN
    RT --> AUTH
    RT --> RAG
    RAG --> CHK
    RAG --> AI
    RAG --> DB
    TEN --> DB
    AI -- HTTPS --> OAI
    DB -- HTTPS --> PG
    ADM --> CHKB
```

**`@rag/chunker` appears twice on purpose.** It is pure (no imports, no I/O),
so the identical package runs in Node *and* in the browser. The admin page's
live "≈ 3 chunks" estimate uses the server's own constants rather than a copy
that would drift (D-018). It is an ordinary workspace import on both sides.

---

## 2. Adding a document — the ingest pipeline

**You paste text into `/t/<slug>/admin` (logged in as that tenant's admin) and press Add.**

```mermaid
sequenceDiagram
    autonumber
    participant U as You
    participant A as admin-screen.tsx
    participant E as documents/route.ts
    participant R as ingestDocument
    participant C as chunkText
    participant O as OpenAI
    participant P as Postgres

    U->>A: paste title + content
    A->>A: estimateChunkCount() — live "≈ N chunks"
    U->>A: click Add
    A->>E: POST /api/t/:slug/documents {title, source, content}
    E->>P: resolve tenant — withTenantRoute → getTenant(slug)
    Note over E: unknown slug → 404 "No workspace named …"
    E->>E: requireAdmin — this tenant's session cookie, or 401
    E->>E: validate — title, content, ≤100k chars
    E->>R: ingestDocument({ tenant, … })
    R->>C: chunkText(content)
    C-->>R: string[] — whole paragraphs, ≤1000 chars each
    Note over R: nothing to store? throw before touching the database
    R->>P: INSERT documents (tenant_id) → id
    Note over R,P: the row now EXISTS — everything below is in a try/catch
    R->>O: POST /v1/embeddings — ALL chunks in ONE call
    O-->>R: number[1536][]
    R->>P: INSERT chunks — tenant_id + content + chunk_index + vector
    Note over P: composite FK: a chunk's tenant must equal its document's
    R-->>E: {id, title, chunkCount}
    E-->>A: 201
    A->>A: green notice, refresh the list
```

**The `catch` is the part worth reading.** If embedding fails after the
`documents` row exists, you are left with a document that shows in the list,
has zero chunks, can never be retrieved, and explains nothing. So the catch
deletes the row and rethrows. Not a transaction — `supabase-js` speaks HTTP, so
there is no `BEGIN`/`COMMIT` to wrap it in (`risks.md` § R-7).

---

## 3. Asking a question — the query pipeline

**You type a question on `/t/<slug>` and press Enter.** This is the one to understand.

```mermaid
sequenceDiagram
    autonumber
    participant U as You
    participant A as chat-screen.tsx
    participant E as chat/route.ts
    participant R as answerQuestionStream
    participant O as OpenAI
    participant P as Postgres

    U->>A: type + Enter
    A->>E: POST /api/t/:slug/chat<br/>Accept: text/event-stream
    E->>P: resolve tenant — withTenantRoute → getTenant(slug)
    Note over E: unknown slug → 404. There is no default tenant.
    E->>E: mint a CHAT token for that tenant (5 min, no sub): tenant.db
    Note over E,P: every query below reaches Postgres as that token, under RLS (auth-rls)
    E->>E: validate, then choose stream vs JSON
    E->>R: answerQuestionStream({ tenant, … })

    rect rgb(245, 247, 250)
    Note over R,P: prepareAnswer() — shared by both delivery modes; every query filters tenant_id
    R->>P: find the conversation IF this tenant owns it, else create one
    R->>P: SELECT last 6 messages (by id, not timestamp)
    R->>O: rewriteQuestion() — resolve "when did they join?"<br/>into a standalone query  (skipped on turn 1)
    O-->>R: "When did Marisol Venn join?"
    R->>O: POST /v1/embeddings — embed the REWRITTEN query
    O-->>R: number[1536]
    par two searches at once
        R->>P: rpc match_chunks(p_tenant_id) — cosine, distance ASC
    and
        R->>P: rpc match_chunks_fts(p_tenant_id) — keyword, ts_rank
    end
    R->>R: Reciprocal Rank Fusion, trim to MATCH_COUNT
    R->>P: SELECT document titles for the sources panel
    end

    R-->>A: event: meta — sources appear NOW, before any answer
    alt no tools, and nothing cleared MIN_SIMILARITY
        R-->>A: event: delta — "I don't know based on the documents I have."
        Note over R,O: OpenAI is never called. Faster, free, unignorable.
    else chunks retrieved, or the tenant has tools
        R->>O: POST /v1/chat/completions (stream: true)<br/>system rules + chunks + history + ORIGINAL question<br/>+ tools, only if the tenant has any
        opt the model asks for a tool (at most MAX_TOOL_ROUNDS)
            O-->>R: tool_calls, streamed in fragments per index
            R->>P: executeTool → checkAvailability → rpc check_availability(p_tenant_id)
            R-->>A: event: tool — the call and its open/taken rows
            R->>O: ask again, with the tool result as a message
        end
        loop each fragment
            O-->>R: delta
            R-->>A: event: delta (HELD instead if there were zero chunks)
            A->>A: append to the answer (React escapes it; a pipe table block is drawn as a table, D-091)
        end
        Note over R: zero chunks and no tool call → the reply is replaced by the refusal (D-035)
    end
    R->>P: INSERT user + assistant messages
    R-->>A: event: done
```

### The same thing in words

1. **You press Enter.** `chat-screen.tsx` posts your question to
   `/api/t/<slug>/chat` with `Accept: text/event-stream`. The slug came from the
   server as a prop; it is never parsed out of the URL bar. Without that header
   the same route returns one JSON body instead, which is what `curl` gets
   (D-019).
2. **The tenant is resolved.** `withTenantRoute()` turns the slug into a
   `TenantContext`, or answers 404. Nothing ever picks a tenant on a request's
   behalf (D-027).
3. **The route validates** the message and picks a delivery mode. Everything
   after this is `@rag/pipeline`, which takes the tenant as its first argument;
   the route has no business logic in it.
4. **The conversation row** is found, but only if *this tenant* owns the id
   the browser sent. Otherwise, including an id from another tenant, a new one
   is created.
5. **The last 6 messages** are loaded. The model is stateless, so this array is
   re-sent and re-billed every single turn — which is why it is capped (D-011).
6. **Your question is rewritten into a standalone query** if there is history
   to resolve it against. "When did they join?" becomes "When did Marisol Venn
   join?" — because *retrieval never sees the conversation*, only the generator
   does (D-016). Skipped entirely on the first message.
7. **The rewritten query is embedded** — by the same function, reading the same
   env var, that embedded your documents. Different models produce vectors in
   unrelated coordinate spaces, and comparing them yields plausible numbers
   that mean nothing while erroring not at all (D-004, `risks.md` § R-3).
8. **Two searches run in parallel, both inside this tenant.** Cosine similarity finds things that *mean*
   the same; Postgres full-text finds exact tokens like `NL-220` that
   embeddings are bad at. Results are merged by **rank**, not score — the two
   numbers have no common scale (D-015). The tenant filter is inside both SQL
   functions, before their `limit`, so another tenant's chunk never takes a
   candidate slot.
9. **Document titles are fetched** so each source reads *"Northwind Labs
   Operations Handbook · 0.588"* rather than *"document 25"*.
10. **`meta` is sent.** The sources panel appears here, **before the model has
   written anything.** You can read what it was given while it decides what to
   make of it.
11. **Either** the tenant has no tools and nothing cleared the threshold, so
    the refusal is returned and **OpenAI is never called** (D-008). **Or** the
    prompt is assembled and streamed. Note the prompt carries your *original*
    words, not the rewrite; an answer addressing a silently reworded question
    reads wrong.
11a. **If the tenant has tools** (villa has `check_availability`), the model
    may ask for a call instead of answering. The pipeline runs it for **this
    tenant**. The model never names a tenant, because the tool's schema has
    nowhere to put one. It sends a `tool` event, so "Checked availability"
    appears on screen, and asks the model again with the result. With zero
    chunks, the reply is kept only if a tool was called, and it is held back
    rather than streamed until that is known (D-035).
11b. **A per_room tenant** (harbor) gets the same tool name with a different
    description and three optional arguments (`slot`, `room`, `guests`).
    executeTool picks the branch from the DATABASE, calls
    `check_room_availability`, and hands the model rows of `date, unit,
    capacity, slot, status, price`, the price as text ("₱3,500.00"). Villa's
    branch is unchanged (plan/booking-types.md Phase 6). Each row also says
    how many guests the price includes and the fee per extra guest; with a
    guest count, it carries that party's extra charge and total, from
    `unit_quote()`, the one function that makes a price (plan/extra-guests.md).
    **Villa gets the same columns since D-074:** a whole-resort tenant whose
    unit has a rate is priced from the same function
    (`checkPricedAvailability`), its tool takes `guests`, and its documents
    hold the rules but not the figures. A whole-resort tenant with no rate
    keeps the four-column result.
11c. **The chat never books** (D-069). "How do I book?" is answered from
    the documents, which say to press the **Book** button; "book it for me"
    may check availability and then points at the page. The button is a
    Link in the header, shown when `hasBookingPage()` is true, not a line in
    a reply: the chat renders no links, and no tool can write.
11d. **A list is a table** (D-091). The reply is text, and stays text,
    except for a pipe-table block (`| a | b |` over `|---|---|`), which
    `apps/web/lib/tables.ts` splits out and `reply-text.tsx` draws as a
    `<table>` with every cell a React child. The replies code writes (the
    room list, the rate card, the extra-guest terms) come from
    `packages/rag/src/tables.ts`; the model writes its own from an example
    in its instruction lines. The rate kind is said once in the sentence
    above the table. On a phone each row is a card.
12. **Both messages are saved**, including refusals, so a later "what about the
    second one?" has an unbroken transcript to resolve against.

---

## 4. Where the answer can go wrong

Each of these is measured in [`notes.md`](./notes.md). They are worth knowing
as a map of *which* step to suspect.

```mermaid
flowchart TD
    Q["your question"] --> RW{"rewritten?"}
    RW -->|"no history"| EMB
    RW -->|"rewritten"| EMB["embedded"]
    EMB --> SRCH["hybrid search"]
    SRCH --> GATE{"anything above<br/>MIN_SIMILARITY?"}
    GATE -->|no| REF["refusal — free, no OpenAI call"]
    GATE -->|yes| GEN["model writes the answer"]
    GEN --> OUT["answer + sources"]

    SRCH -. "chunk size wrong:<br/>fact split from its subject" .-> BAD1["retrieves the wrong chunk"]
    GATE -. "threshold too high" .-> BAD2["refuses something it knows"]
    GATE -. "threshold too low" .-> BAD3["wastes ~670 tokens, then refuses anyway"]
    GEN -. "only half the answer retrieved" .-> BAD4["invents the other half"]
    GEN -. "needs a one-step inference" .-> BAD5["refuses despite having the answer"]
```

**The rule of thumb Phase 5 produced:** open the sources panel first.

- **Wrong answer, sources look irrelevant** → a *retrieval* problem. Chunking,
  threshold, or the search itself.
- **Wrong answer, sources contain the right text** → a *generation* problem.
  Prompt wording, or the model. No amount of retrieval work fixes it.

That single distinction is what the sources panel exists to make visible, and
it is why D-012 calls it a feature rather than a debug toggle.

---

## 5. The routes

Every one is under a tenant. The old un-prefixed paths (`/admin`, `/api/chat`)
return 404, with no redirect.

| Method | Route | Does | Lives in | Access |
|---|---|---|---|---|
| `GET` | `/` | static page, no tenant list | `app/page.tsx` | public |
| `GET` | `/t/<slug>` | chat page | `app/t/[tenant]/page.tsx` → `ChatScreen` | public |
| `GET` | `/t/<slug>/admin` | knowledge base page | `app/t/[tenant]/admin/page.tsx` → `AdminScreen` | public page, admin data |
| `POST` | `/api/t/<slug>/chat` | ask — SSE or JSON | `answerQuestionStream` / `answerQuestion` | open |
| `GET` | `/t/<slug>/admin/conversations`, `…/conversations/:id` | S-16 the chats / S-16a one transcript, read-only (D-115) | `ConversationsScreen` / `TranscriptScreen` | public page, staff data |
| `GET` | `/api/t/<slug>/admin/conversations` | one page of chats: `?days=7\|30\|90&q=&refused=1&before=&beforeId=`, from `conversation_list()`, which refuses a non-member itself | `listConversations` | admin (any member) |
| `GET` | `/api/t/<slug>/admin/conversations/:id` | one transcript, every message named; 404 if not this tenant's. (The OPEN `/conversations/:id/messages` was removed, D-115.) | `getTranscript` | admin (any member) |
| `GET` | `/t/<slug>/admin/reset` | set a password from an invite or reset link | `app/t/[tenant]/admin/reset/page.tsx` → `ResetPassword` | public |
| `POST` / `GET` / `DELETE` | `/api/t/<slug>/admin/session` | log in (email + password) / status / log out | `lib/admin-auth.ts` | open |
| `POST` | `/api/t/<slug>/admin/password-reset`, `…/admin/password` | email a reset link / set the new password | `@rag/db` `staff-auth.ts` | open |
| `POST` | `/api/t/<slug>/documents` | chunk → embed → store | `ingestDocument` | admin |
| `GET` | `/api/t/<slug>/documents` | list with chunk counts | `listDocuments` | admin |
| `GET` | `/api/t/<slug>/documents/:id/chunks` | expand a row to show its chunks | `getChunks` | admin |
| `DELETE` | `/api/t/<slug>/documents/:id` | delete; chunks cascade | `deleteDocument` | admin |
| `GET` / `POST` | `/api/t/<slug>/bookings` | list (`?unit=` per_room; each pending row says `clash` when its night is already confirmed, D-099) / book one unit, or `rooms` as one group, born `pending` (D-095); a 409 in the trigger's words when that span is already confirmed (D-099) | `listBookings` / `createBooking(s)` | admin |
| `POST` | `/api/t/<slug>/bookings/quote` | the price of rooms on a date, from `unit_price()` (per_room) | `quote` | admin |
| `GET` / `POST` | `/api/t/<slug>/accommodations` | rooms with rates and photos / add a room (per_room; 404 otherwise) | `listAccommodations` / `createAccommodation` | admin |
| `GET` / `PATCH` | `/api/t/<slug>/accommodations/:id` | one room / change or retire it | `getAccommodation` / `updateAccommodation` | admin |
| `PUT` | `/api/t/<slug>/accommodations/:id/rates` | set rates, in centavos | `setRates` | admin |
| `GET` / `POST` | `/api/t/<slug>/accommodations/:id/images` | photos / upload one (multipart) | `listImages` / `addImage` | admin |
| `PATCH` / `DELETE` | `/api/t/<slug>/accommodations/:id/images/:imageId` | reorder / remove (row, then object) | `setImageOrder` / `removeImage` | admin |
| `GET` | `/t/<slug>/book` | the customer booking page (404 without the application or a priced unit) | `app/t/[tenant]/book/page.tsx` → `BookingPageScreen` | public |
| `POST` | `/api/t/<slug>/book/quote` | a stay's price night by night, and whether it is still open | `quoteRequest` | open |
| `POST` | `/api/t/<slug>/book/request` | send a request: `pending` rows via `request_booking()`; honeypot + per-IP window | `requestBooking` | open |
| `GET` | `/api/t/<slug>/bookings/requests` | every stay waiting for a decision, web or staff (D-100), one per group with its reference, `source` and `clash` | `listRequests` | admin |
| `PATCH` | `/api/t/<slug>/bookings/requests/:groupId` | `{ action: confirm \| decline }`, the whole group, any source; 409 on a clash | `confirmRequest` / `declineRequest` | admin |
| `GET` | `/t/<slug>/manage` | S-13, Manage booking: look up a stay, pay, ask for a change (404 without the application) | `app/t/[tenant]/manage/page.tsx` → `ManageBookingScreen` | public |
| `POST` | `/api/t/<slug>/manage` | `{ reference, contact }` → the stay through `guest_stay()`; every miss one 404 sentence | `guestStay` | open |
| `POST` | `/api/t/<slug>/manage/proof` | multipart proof → private bucket → `submit_payment()` | `submitProof` | open |
| `POST` | `/api/t/<slug>/manage/change`, `…/change/withdraw` | ask to cancel or move (`dryRun` quotes) / withdraw | `requestChange` / `withdrawChange` | open |
| `GET` | `/t/<slug>/admin/payments` | S-14, Payments: proofs, all payments, change requests, settings | `app/t/[tenant]/admin/payments/page.tsx` → `PaymentsScreen` | public page, staff data |
| `GET` | `/api/t/<slug>/payments`, `…/payments/:id/proof` | the queue (`?which=open\|all`) / a 5-minute signed proof URL | `listPayments` / `proofUrl` | payments:read |
| `PATCH` | `/api/t/<slug>/payments/:id` | verify (amount found, account checked, optionally confirm) or reject (reason) | `reviewPayment` | payments:write |
| `POST` | `/api/t/<slug>/payments/refund` | record a refund made elsewhere | `recordRefund` | payments:write |
| `GET` / `PUT` | `/api/t/<slug>/payments/settings` | ways to pay, fee, deadlines, hold, refund policy | `paymentSettings` / `setPaymentSettings` | payments:read / payments:settings |
| `GET` / `PATCH` | `/api/t/<slug>/payments/changes`, `…/changes/:id` | change requests / approve or reject | `listChanges` / `decideChange` | payments:read / payments:write |
| `GET` | `/api/t/<slug>/stays/:groupId/history` | a stay's `booking_events`, oldest first | `stayHistory` | bookings:read |
| `GET` / `PUT` | `/api/t/<slug>/holidays` | the holiday calendar / add or change a day | `listCalendar` / `setCalendarDay` | admin |
| `DELETE` | `/api/t/<slug>/holidays/:day` | remove a day (404 if not there) | `removeCalendarDay` | admin |
| `POST` | `/api/t/<slug>/holidays/copy` | copy chosen days to another year | `copyCalendarDays` | admin |
| `GET` | `/t/<slug>/admin/holidays` | the Holidays screen | `app/t/[tenant]/admin/holidays/page.tsx` → `HolidaysScreen` | public page, admin data |
| `GET` / `POST` | `/api/t/<slug>/promos` | the promos with their use counts (`?all=1` for retired) / create one (D-097) | `listPromos` / `createPromo` | admin (`promos:read` / `promos:write`) |
| `PATCH` / `DELETE` | `/api/t/<slug>/promos/:id` | edit or retire (`active: false`) / delete a never-used promo | `updatePromo` / `deletePromo` | admin |
| `GET` | `/t/<slug>/admin/promos` | the Promos screen | `app/t/[tenant]/admin/promos/page.tsx` → `PromosScreen` | public page, admin data |
| | | `book/quote` and `book/request` take `promoCode`; `bookings/quote` and `bookings` take `promoId`. The discount is the database's (`promo_discount()`), the code resolved by `promo_for_request()` | | |
| `GET` | `/api/t/<slug>/dashboard` | ONE JSON from `tenant_dashboard()` (D-098): every card and chart, `?days=7\|30\|90` clamped; `money` null unless the role is admin or owner, decided in SQL | `tenantDashboard` (`@rag/pipeline` dashboard.ts) | admin (`dashboard:read`, every member) |
| `GET` | `/t/<slug>/admin/dashboard` | the Dashboard screen (S-11), the first staff link | `app/t/[tenant]/admin/dashboard/page.tsx` → `DashboardScreen` | public page, admin data |
| `GET` | `/t/<slug>/admin/members` | the Members screen (S-8) | `app/t/[tenant]/admin/members/page.tsx` → `MembersScreen` | public page, OWNER data |
| `GET` / `POST` / `PATCH` / `DELETE` | `/api/t/<slug>/members` | list with emails / add an existing account / change a role / remove | `listMembers` … `removeMember` (`@rag/pipeline` members.ts) | owner (`members:manage`) |
| `GET` | `/platform`, `/platform/reset` | the platform screen; where a super user's invite lands | `app/platform/…` → `PlatformScreen`, `ResetPassword` | public page, PLATFORM data |
| `POST` / `GET` / `DELETE` | `/api/platform/session` | log in / status (with `userId`) / log out | `lib/platform-auth.ts` | open |
| `POST` | `/api/platform/password-reset`, `…/password` | email a reset link / set the password | `@rag/db` `staff-auth.ts` | open |
| `GET` / `POST` | `/api/platform/tenants` | every tenant, archived included / create one | `listTenants` / `createTenant` (platform.ts) | platform |
| `GET` / `PATCH` | `/api/platform/tenants/:id` | one tenant with its configs / edit names, urls, theme, fallbacks | `getTenant` / `updateTenant` | platform |
| `POST` / `DELETE` | `/api/platform/tenants/:id/archive` | archive (a 404 everywhere) / unarchive | `archiveTenant` | platform |
| `PUT` / `DELETE` | `/api/platform/tenants/:id/applications/:key` | switch on with a config, or replace it / switch off (409 while a booking is live) | `setApplication` / `removeApplication` | platform |
| `GET` / `POST` / `PATCH` / `DELETE` | `/api/platform/tenants/:id/members` | any tenant's members, the same four verbs; `POST { userId }` is "Make me an owner" | members.ts, on the platform token | platform |
| `GET` | `/api/platform/dashboard` | the Pulse strip: one row of counts per tenant from `platform_dashboard()` (definer, `app_is_super()` first); no content, no money (D-098) | `platformDashboard` (dashboard.ts) | platform |

**The booking page** (plan/customer-booking.md) is the one place a stranger
WRITES. The page's Server Component reads `bookingPage()` on the chat token
(units, rates, the calendar, never a booking row); the browser asks
`book/quote` as the choice changes (read-only, `unit_quote()` per night) and
sends `book/request` once. That route is `withTenantRoute()` with no
`requireAdmin()`, by design, and it calls `request_booking()`, a definer
function that can only insert `pending` rows (D-071). A request holds
nothing (D-070): staff see it in the Requests section of S-3 and confirm or
decline the whole group; `bookings_no_overlap` decides a clash at confirm.

"Admin" means `tenant = await requireAdmin(request, tenant, permission)`.
- The request must carry this tenant's signed session cookie, and its user
  must still be a member.
- The member's ROLE (`memberships.role`, read from the row on every
  request) must hold the permission, from the one table in
  `lib/permissions.ts`: owner everything; admin the knowledge base, rooms,
  holidays and bookings; staff bookings, unanswered and conversations, the knowledge base
  read-only; every role the dashboard. Otherwise a 403 that names both.
- The handler then runs on a **staff** token, so Postgres reads the same
  row again on every write (`app_role()` under `app_is_admin()` and
  `app_is_staff()`).
- Otherwise the request gets a 401.

"Platform" means `withPlatformRoute()`: the `rag_platform` cookie, then
`platformClient()`, which mints a token with `app_super` and NO tenant and
reads the `platform_admins` row through it. Under RLS that token reads and
writes `tenants`, `tenant_applications` and `memberships` (the `*_super_*`
policies) and nothing of any tenant's documents, chunks or bookings: there
is no tenant claim for those policies to match (D-076). A platform cookie
at a tenant route, or a tenant cookie at the platform, is a 401.

---

## 6. The knobs, and what each one moves

All named constants at the top of their module, so Phase 5 could find them.

| Constant | Value | File | Moves |
|---|---|---|---|
| `CHUNK_SIZE` | 1000 | `packages/chunker/src/index.ts` | retrieval quality, more than anything else |
| `CHUNK_OVERLAP` | 150 | `packages/chunker/src/index.ts` | whether a split fact survives somewhere |
| `MATCH_COUNT` | 5 | `packages/rag/src/constants.ts` | cost per question, and whether a whole answer is present |
| `MIN_SIMILARITY` | 0.25 | `packages/rag/src/constants.ts` | cost — **not** correctness. Measured, not guessed |
| `MAX_HISTORY` | 6 | `packages/rag/src/constants.ts` | cost growth over a long conversation |
| `CANDIDATE_COUNT` | 10 | `packages/rag/src/constants.ts` | how much each search contributes before fusion |
| `RRF_K` | 60 | `packages/rag/src/constants.ts` | how sharply rank 1 dominates in the fusion |

**Changing either chunker constant requires re-ingesting every document.**
Stored chunks are not touched by a code change.
