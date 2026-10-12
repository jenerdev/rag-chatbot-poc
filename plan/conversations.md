# Conversations plan: staff read what visitors asked the chatbot, one transcript at a time

> Every chat turn has been saved since Phase 3 (`saveMessages()` in
> `answer.ts`, both rows in one insert, refusals included), per tenant since
> tenancy. Nothing shows them. Staff see two slices: the Unanswered list
> (S-4, a refusal and the question before it, D-045) and the dashboard's
> counts (conversations per day, the refusal rate, D-098). A conversation
> that WAS answered, a follow-up that went wrong, a guest who asked three
> times before giving up: none of that is visible to anyone. This plan adds
> **S-16, Conversations**: a staff list of this tenant's chats, newest
> first, searchable, and a page per conversation that shows the transcript
> exactly as it was stored, a refusal marked as one.
>
> Written 2026-10-13, against `107d6fb` on `master`. **Status: Phases
> 0–6 done 2026-10-13, walk included,** on `feat/conversations`; the record
> is D-115 and R-50. § 7's six questions were answered 2026-10-13: every
> recommendation taken, by the user's instruction. Deviations from the text
> below: verify had grown to 167 checks, so the new ones are **168–172**,
> not 162–166; the function takes the keyset as two arguments
> (`p_before_at`, `p_before_id`) and a `p_refused` flag, and returns ONE
> `jsonb` (`timezone`, `days`, `total`, `more`, `rows`) rather than a table, so
> the page knows the tenant's zone and whether there is more; the
> transcript names a fourth kind, **interrupted** (a partial reply,
> answer.ts's second failure shape), beside answer, refusal and failed.
>
> Read [§ 0](#0-the-four-rules) first.

---

## What this plan covers

| | |
|---|---|
| **In scope** | One SQL function, `conversation_list()` (`sql/schema-conversations.sql`, the 28th file), `security invoker`, staff-gated: one row per conversation with its first question, turn count, refusal count, first and last message times, filtered by window and search, keyset-paged. `@rag/pipeline`: `listConversations()` and `getTranscript()` (staff). Two staff routes, a permission `conversations:read`, a nav item under Content. S-16 `/t/<slug>/admin/conversations` (the list) and S-16a `/t/<slug>/admin/conversations/[id]` (one transcript). Unanswered rows and the dashboard's chat card link into it. verify, isolation, a walk, the a11y run; the record: D-115, R-50 |
| **Out of scope** | Storing anything new per turn (sources, tool calls, the reply language, a visitor identity): the transcript is what `messages` already holds (§ 7 q3). Editing or deleting a transcript, or a retention sweep (§ 7 q4, R-50). Staff replying into a chat (there is no live channel; the chat is request/response). Visitor-side history (a sidebar on S-1). Telling a staff member's own test chat from a guest's. Any change to the chatbot: no prompt text, no tool text, no change to what is saved |

### What the request assumes, and what is actually here

| Assumption | What exists today | What the plan does |
|---|---|---|
| "The conversations are stored" | Yes: `conversations (id, tenant_id, created_at)`, `messages (id, conversation_id, tenant_id, role, content, created_at)`, composite FK on `(conversation_id, tenant_id)` | Reads them; no schema change to either table |
| "We can show what the bot showed" | Only the TEXT is stored. A refusal is stored as the `NO_ANSWER` marker (D-047), not the tenant's friendly words; the reply language is not stored; sources and tool results are not stored | The transcript shows the marker as a "Not answered" badge with the tenant's English fallback beside it (what `getMessages()` already does); tables and bold drawn by `ReplyText` (D-091); no sources panel |
| "Staff can already read messages" | Policy-wise, ANY token of the tenant can: `messages_read` is `tenant_id = app_tenant_id()`, the chat token included (`schema-auth.sql`) | The function refuses a non-staff caller itself (Rule 2), as `tenant_dashboard()` does (dashboard plan § 2b.3) |
| "There is a conversations API" | `GET /api/t/[tenant]/conversations/[id]/messages`: OPEN, no `requireAdmin`, a uuid is the only key. Nothing in the UI calls it | Left as it is, or removed (§ 7 q5); the staff routes are separate and admin-only |

---

## 0. The four rules

### Rule 1 — The transcript is read, never written

Nothing on this screen inserts, updates or deletes a `messages` or
`conversations` row. `messages` stays append-only (the reason
`unanswered_resolutions` is its own table, `schema-unanswered.sql`). No
new policy is added to either table; staff read through the policies that
exist.

### Rule 2 — A chat token gets a refusal, not a list

`conversation_list()` is `security invoker`, so it reads under the caller's
RLS, and it starts with `if not public.app_is_staff() then raise … 42501`.
Without that line a chat token, which may read every message of its tenant
by policy, would get the whole list. `getTranscript()` runs under the
staff token the route swapped in (`requireAdmin`), and filters
`tenant_id` itself (rule 6, wall 1). A positive twin for each (trap 12):
the staff count equals the service-role count for that tenant.

### Rule 3 — "Not yours" and "not there" are the same 404

An id from another tenant, a malformed uuid and a deleted conversation
all answer `404 No such conversation`. Ids are uuids already; the page
never shows one in a way that invites typing it.

### Rule 4 — The chatbot does not change

No line of `buildPrompt()`, `language.ts`, `dates.ts`, `tools.ts` or
`answer.ts`'s write path changes. The three snapshot baselines stay
byte-identical (`northwind-prompt-post-emoji.txt`,
`villa-tools-post-villa-prices.txt`, `harbor-tools-tables-phase0.txt`).
`pnpm eval` is run once at the end as a regression check, expecting the
usual 59/61 (CLAUDE.md rule 1), not because anything it judges moved.

---

## 2b. Traps

### 2b.1 A list by conversation is an aggregate PostgREST will not do

PostgREST's aggregate functions are off by default, and a turn count, a
refusal count and "the first user message" per conversation in JS would
read every message of the window. One SQL function does it in one round
trip (as `tenant_dashboard()` does), with `count(*) filter (where …)` and
a lateral `limit 1` for the first question.

### 2b.2 Empty conversations exist

`ensureConversation()` inserts the row before the first message, and a
failed turn (an OpenAI error) can leave a conversation with no messages.
Small talk (D-049) saves its rows. The list shows only conversations with
at least one message (`exists`), and the dashboard's count, which counts
the bare rows, may differ by those; § 6 says so rather than "fixing" the
dashboard.

### 2b.3 Search on `content` without an index

`ilike '%term%'` on `messages.content` is a sequential scan of the
tenant's messages. At today's volume (hundreds of rows a tenant) it is
milliseconds; Phase 0 records the real `explain analyze` as a STAFF token
(trap 11), and a `pg_trgm` index is the documented next step, not built
now (R-50's sibling note in § 7 q6). The term is passed as a parameter and
`%`/`_` are escaped in SQL, never concatenated.

### 2b.4 "Today" is the tenant's

The window (`?days=7|30|90`, clamped like the dashboard's) starts at the
tenant's local midnight (`localDate(timezone)`, trap 9), and every time on
the screen is shown in the tenant's zone, not the browser's.

### 2b.5 A stored reply is not always a reply

`storedReply()` saves the marker exact even when decorated (D-092), and a
failed request is saved as a failure marker, not a refusal (the
`unanswered.ts` header). The transcript names three kinds: an answer, a
refusal (`NO_ANSWER`), and a failure (that marker), each with its own
badge. The refusal count in the list counts only the first, the same
definition as Unanswered and the dashboard.

---

## 3. The data model

No table changes. One file, `sql/schema-conversations.sql`, the 28th:

```sql
create or replace function public.conversation_list(
  p_tenant_id bigint,
  p_days      int,             -- clamped to 7 | 30 | 90 by the caller AND here
  p_query     text default null,
  p_before    timestamptz default null,  -- keyset: last_at of the previous page's last row
  p_limit     int default 25
) returns table (
  id              uuid,
  started_at      timestamptz,
  last_at         timestamptz,
  turns           int,          -- user messages
  refusals        int,          -- assistant messages = the NO_ANSWER marker
  first_question  text          -- truncated to 200 chars in SQL
)
language plpgsql stable security invoker set search_path = ''
```

- Refuses a non-staff caller (Rule 2) and a `p_tenant_id` that is not the
  token's (wall 2 says the same; the check makes it a 42501 in words).
- Every name qualified (trap 19).
- `p_query` matches any message of the conversation, user or assistant.
- Ordered by `last_at desc, id desc`; the keyset is `(last_at, id)`.

Typed in `@rag/pipeline` (`ConversationSummary`, `Transcript`), parsed
field by field, never spread.

---

## 4. The page

### S-16 `/t/<slug>/admin/conversations` — the list

- Staff frame, Content section, after Unanswered. Every tenant.
- Toolbar: `ListSearch` (server-side, debounced, since the list is paged
  and the match is over every message, not the loaded rows), the window
  7 / 30 / 90 days (default 30), "Only with a refusal" toggle.
- One row per conversation: the first question (one line, ellipsised),
  when it started and how long ago the last message was, turns, and a
  danger badge "2 not answered" when `refusals > 0`. The whole row links
  to S-16a.
- `LoadState` while loading, `EmptyState` ("No conversations in the last
  30 days") with no add button, "Load more" by keyset.
- Phone: the row stacks; no sideways scroll at 390.

### S-16a `/t/<slug>/admin/conversations/[id]` — one transcript

- Header: started at, last message, turns, refusals; Back to the list
  (keeps its search and window in the query string).
- The messages oldest first as a read-only thread: the visitor's turns and
  the assistant's, each with its time. Assistant text through
  `ReplyText` (tables and bold, D-091; never HTML). A refusal: the
  "Not answered" badge and, muted, "The visitor saw: <the tenant's
  English fallback>"; a link "Open in Unanswered" when it is still open.
  A failure: its own badge.
- `?m=<message id>` scrolls to and highlights that message (how Unanswered
  links in).
- 404 page in the staff frame for an unknown or foreign id (Rule 3).

### Links in

- Unanswered: each row gains "View conversation" → S-16a `?m=<refusal id>`.
  `UnansweredQuestion` gains `conversationId`; the route is admin-only
  already, and the header comment that keeps the id on the server is
  amended to say why staff may have it.
- Dashboard chat card: "View conversations" → S-16 with the same window.

---

## 5. Phases

### Phase 0 — Baseline
Branch `feat/conversations` from `master`. Record: the three snapshot
diffs empty, `verify` 161/161, both isolation runs, a row count of
conversations and messages per tenant (service role, for the positive
twins), and `explain analyze` of a draft `ilike` as a staff token.

### Phase 1 — SQL
`schema-conversations.sql`; run it. verify checks 162–166: a chat token is
refused (42501); a staff token's row count equals the service-role count
of non-empty conversations for its tenant (the positive twin); a staff
token of tenant A asking for B's id gets 42501; `p_query` finds a seeded
phrase and only its conversation; the keyset returns no row twice over
three pages.

### Phase 2 — `@rag/pipeline`
`src/conversations.ts`: `listConversations(tenant, { days, query, before })`
over the function, `getTranscript(tenant, id)` (the conversation's
existence check, then its messages, both `.eq('tenant_id', tenant.id)`;
`null` on a miss), the days clamp shared with the dashboard's. Unit tests
for the parser and the kinds of message (answer / refusal / failure).
isolation check 24: a transcript of tenant A asked as B is `null`, on chat
and staff tokens, and in `--filters-only`.

### Phase 3 — Routes and permissions
`conversations:read` in `lib/permissions.ts` (roles per § 7 q1).
`GET /api/t/[tenant]/admin/conversations?days=&q=&before=&refused=1` and
`GET /api/t/[tenant]/admin/conversations/[id]`, both
`withTenantRoute` → `requireAdmin(request, tenant, 'conversations:read')`.
Under `admin/` so they cannot be confused with the open
`conversations/[id]/messages`. `navItems()` gains the item (its test too).

### Phase 4 — Screens
`conversations-screen.tsx`, `transcript-screen.tsx`, the two server pages,
the Unanswered and dashboard links. Styles in `screens.css` from tokens
only (D-101). A walk, `plan/conversations-walk.mjs`, against `pnpm dev`:
list loads, search narrows, the toggle filters, a row opens its transcript,
a refusal shows the badge and the fallback, `?m=` highlights, a foreign id
is 404, a staff member without the permission gets 403 (if § 7 q1 limits
it), Unanswered's link lands on the right message. Screenshots light/dark,
1280/390.

### Phase 5 — The walls and the walk
`pnpm --filter @rag/pipeline isolation` both ways, `pnpm --filter
@rag/db verify`, the three snapshot diffs, `pnpm eval` (59/61 expected,
Rule 4), `plan/ui-refresh-a11y.mjs` with the two new page states at 0
violations, the bundle grep (CLAUDE.md rule 2).

### Phase 6 — The record
D-115 in `decisions.md`; R-50 in `risks.md`; CLAUDE.md (a paragraph, the
layout lines, the 28th file, the command list); `flow.md` (where staff
read transcripts); `status.md` and `whats-done.md` with the observed
values.

---

## 6. What must not change

- What a chat turn saves, and when. `saveMessages()` is untouched.
- The dashboard's counts. They count conversation rows; S-16 lists
  conversations with messages (2b.2). If the two differ, that difference is
  the empty conversations, and it is recorded, not reconciled.
- Unanswered's definition of a refusal, and its resolve/reopen flow.
- The open `conversations/[id]/messages` route, unless § 7 q5 says remove.
- The three prompt and tool baselines, byte for byte.

---

## 7. Questions, each with a recommendation · **answered 2026-10-13, every recommendation taken**

1. **Who may read transcripts?** They are visitors' own words and may hold
   names, phone numbers, dates of a stay. *Recommendation:* every member
   (`staff` included), the same as Unanswered, which already shows the
   same words one question at a time. The alternative is owners and admins
   only, which would make Unanswered's new link a 403 for staff.
2. **Does the platform (super user) see transcripts?** *Recommendation:*
   no. A platform token has no tenant claim, so every policy is false for
   it already (D-076); it keeps the counts it has. A super user who needs
   to read them makes itself an owner, as for any tenant content.
3. **Store sources and tool calls per turn, so a transcript can show what
   each answer was built from?** *Recommendation:* not in this plan. It is
   a write-path change in `answer.ts` and a schema change on a table the
   open chat token inserts into. Ship the reader first; if staff ask "why
   did it say that", that is a follow-up plan with its own measurements.
4. **Delete or retain?** *Recommendation:* no delete button and no sweep
   now; record R-50 (transcripts are guest PII, kept indefinitely,
   accepted until a retention policy is chosen). A delete would also
   remove Unanswered's history through the cascade.
5. **The open `GET /conversations/[id]/messages`.** It reads any
   transcript of the tenant to anyone holding its uuid, and nothing calls
   it. *Recommendation:* remove it in Phase 3 (the pipeline's
   `getMessages()` stays, used by isolation and eval). It is the only
   unauthenticated transcript read, and S-16a replaces its purpose.
6. **Search: `ilike` now, `pg_trgm` later?** *Recommendation:* `ilike`,
   with Phase 0's `explain analyze` recorded; add the trigram index only
   when a staff-token query over a real tenant passes 100 ms.
