# Risks — RAG Chatbot POC

Ordered by how likely they are to actually bite you.

The honest framing: this is a local learning POC with no users and no data worth
stealing, so most "risks" here are not business risks — they are **the specific
ways this build goes wrong**. That is what makes them worth writing down.

---

## R-1 · Leaking the OpenAI API key · **High impact, easy to avoid**

**The risk:** an API key in client-side code is a key anyone can read. Key
scrapers crawl GitHub continuously, and a leaked key gets used within minutes —
against *your* prepaid credits.

**Why it can happen here:** it is genuinely tempting to call OpenAI directly
from `public/app.js`. It works instantly on localhost and skips writing a route.
Every "quick test" that does this is one commit away from a public repo.

**Mitigation — all three, non-negotiable:**

1. **All OpenAI calls happen in Express.** The browser calls your server; your
   server calls OpenAI. This is the reason the architecture has a backend at all
   (`architecture.md` § 2).
2. **`.env` is in `.gitignore` before the first commit,** not after. Commit
   `.env.example` with empty values instead.
3. **Set a spending limit** in OpenAI Billing (`costs.md` § Cost safety). It
   caps the damage of any leak to an amount you chose.

**If a key does leak:** revoke it at platform.openai.com immediately and create a
new one. Deleting the commit does not help — it is already indexed.

---

## R-2 · `service_role` key + no RLS becomes a real hole the moment this is deployed · **Low now, high later**

**The risk:** D-006 uses Supabase's `service_role` key, which **bypasses Row
Level Security entirely**, and the POC writes no RLS policies. Locally that is
fine — one user, one trusted server. The risk is that the shortcut travels.

**Why it can happen:** "let me just put this on Render to show someone" is a
five-minute action, and nothing in the code will complain.

**Mitigation:**

- The `service_role` key lives only in `.env`, only in Express, and is **never**
  sent to the browser — same rule as R-1.
- **Done 2026-09-20:** RLS is enabled on all four tables (no policies), so the
  tables are not readable or writable with the `anon` key even if it leaks. See
  the amendment to D-006.
- Treat deployment as a hard trigger: the first deploy means enabling RLS,
  writing policies, and switching the browser-facing path to the anon key. It is
  flagged in `decisions.md` D-006 and `mvp.md` Out of scope.
- If you deploy without doing that, the tables are readable and writable by
  anyone who finds the URL.

**Amended 2026-09-23, tenancy: this risk is now larger, not smaller.** The server
serves several tenants that do not trust each other, through a key that
bypasses RLS for all of them. A missing policy used to mean "a stranger could
read the one knowledge base". Now it also means "one tenant's reads are held
apart from another's only by application code". See R-11 and the D-006
amendment.

**Amended 2026-09-26, auth-rls: the hole this describes is closed for
requests.**
- The web app no longer holds `service_role` at all: it is off the REQUIRED
  list, `next build` passes without it, and `pnpm typecheck` fails on any
  import of `@rag/db/service` under apps/ or packages/*/src.
- Requests use the publishable key plus a tenant token, under RLS policies
  on all ten tables (D-038, D-039).
- `service_role` remains in `.env` for tools. A leak of it is still a full
  compromise, and so is a leak of the signing key (R-19).

---

## R-3 · Silent retrieval failure — the answer looks right and isn't · **Most likely to actually happen**

**The risk:** RAG fails quietly. Every failure mode below produces a confident,
fluent, wrong answer with no error anywhere:

| Failure | Cause |
|---|---|
| Mismatched embedding models | Question embedded with a different model than the documents. Similarity scores are computed, look reasonable, and mean nothing (D-004). |
| Threshold too low | Irrelevant chunks retrieved for an unrelated question, then answered from (D-008). |
| Threshold too high | Refuses questions it actually has the answer to. |
| Bad chunk boundaries | The answer is split across two chunks and neither one alone contains it. |
| Embedding stored as a string | `supabase-js` sends the array as JSON; if the column type or the insert is wrong you can end up with text where a vector should be. Search then behaves bizarrely. |

**Mitigation:**

- **The sources panel (D-012) is the primary defence.** Every answer shows the
  chunks it used and their scores. A wrong answer with visible sources is
  immediately diagnosable; without them it is a mystery.
- **Phase 1.2 of the roadmap** verifies a stored embedding round-trips as 1536
  numbers, not a string — before any pipeline exists to confuse the issue.
- **Phase 3.1** requires reading real similarity scores before tuning the
  threshold, so the number is chosen from evidence.
- **Phase 5.3 and 5.5** deliberately break retrieval to see what the failure
  looks like, so you recognise it later.

**This is the risk with the highest expected cost, because it is the one you
cannot see.** Everything else at least throws.

---

## R-4 · Scope creep turning a POC into a product · **The most likely way this doesn't finish**

**The risk:** it works, it's satisfying, and then it needs auth, and streaming,
and PDF upload, and deployment. Six weeks later there is a half-built product
and the learning goal was met in week one but never marked done.

**Why it can happen:** every addition is individually reasonable.

**Mitigation:**

- `mvp.md` § "Explicitly OUT of the MVP" is a long, specific list for exactly
  this reason. Read it when tempted.
- **The test:** does this feature teach me something about retrieval-augmented
  generation? If no, it is post-MVP.
- **Phase 5 is the finish line, not Phase 4.** The project is done when you
  understand it, not when the UI is pretty.
- If it genuinely deserves to become a product, that is a **new folder in
  `ideas/`** with a fresh intake — not a mutation of this one.

---

## R-5 · Blocked in Phase 0 on OpenAI billing · **Low, but it stops everything**

**The risk:** an API key with no credits behind it returns a quota error on
every call. If you assumed a ChatGPT subscription covers it (see `costs.md`),
this is confusing rather than obvious — the key exists, it is valid, and it
still fails.

**Mitigation:** Phase 0.1 adds credits *before* the key is created. Phase 1.1's
throwaway embed script proves billing works before any real code exists.

---

## R-6 · pgvector setup problems · **Low**

**The risk:** `create extension vector` not run, dimension mismatch between
column and model, or the HNSW index failing to build.

**Mitigation:**

- `schema.sql` is a single runnable file (`architecture.md` § 4) — run it once,
  in order, rather than assembling statements ad hoc.
- Phase 0.6 verifies the extension is enabled with an explicit query.
- HNSW (not ivfflat) is specified precisely because it builds on an empty table;
  ivfflat needs existing rows to train on and errors or degrades if created
  first.
- A dimension mismatch fails loudly at insert time, which is the good kind of
  failure.

---

## R-7 · Partial ingest leaves an unsearchable document · **Low impact, easy to miss**

**The risk:** the `documents` row inserts, the embedding call then fails, and
you are left with a document that appears in the list but has zero chunks. It
can never be retrieved, and nothing indicates why.

**Mitigation:** delete the `documents` row in a `catch` before rethrowing, and
show a "⚠ 0 chunks" badge in the admin list (`screens.md` § S-2). Not a
transaction — just cleanup and a visible symptom.

---

## R-8 · Model or API changes before you build · **Low, and cheap to check**

**The risk:** `gpt-4o-mini`, `text-embedding-3-small` and the prices in
`costs.md` were current on 2026-09-20. Model lineups move; a deprecated model id
returns a 404 that reads like a routing bug.

**Mitigation:** Phase 0 checks the current model list. Both models are env vars
(D-005), so switching the chat model is a config change. Switching the
*embedding* model is not cheap — it means a schema change and a full re-ingest
(D-004) — so confirm that one before ingesting anything real.

---

## R-9 · Shipping this build's tuned numbers to a different corpus · **Certain, if you forget**

**The risk:** every tuned value in this repo was measured against **one invented
2,607-character test document**. `MIN_SIMILARITY = 0.25`, `CHUNK_SIZE = 1000`,
`MATCH_COUNT = 5`, and the choice of `gpt-4o-mini` are all defensible *here* and
none of them transfer. Deploy them unexamined against a real corpus and the
failure is the quiet kind: plausible answers, no errors.

**Why it can happen:** the numbers look considered, because they are — they have
measurements written next to them in the source. It is easy to read a
well-justified constant as a settled one.

**Mitigation — two commands, both kept in `tools/` precisely so they survive:**

- **`npm run scores`** — prints real similarity scores with the threshold
  disabled. Reset `MIN_SIMILARITY` from the gap between your genuine questions
  and your off-topic ones.
- **`npm run eval`** — the prompt battery. Rewrite its cases to use your own
  documents' facts, then run it against each candidate chat model. It checks
  both directions: that real questions get answered, and that absent facts are
  still refused.

**This also decides the model.** `gpt-4o-mini` scored 5/6 and `gpt-4o` 6/6 on an
identical prompt at ~16× the input cost (D-017). The difference was applying a
general rule where the document also stated an exception — so whether it matters
depends entirely on whether your documents have carve-outs.

Full list in `README.md` § "Before you put this in production".

---

## R-10 · HNSW post-filtering loses recall as tenants multiply · **Low now, grows with every tenant**

**The risk:** one HNSW graph holds every tenant's chunks (D-025). When the
planner uses that index for a tenant-scoped search, it walks the graph in
distance order and throws away other tenants' rows *after* the walk. If the
walk ends before enough of this tenant's rows have passed, the search returns
short, or empty.

**Measured in tenancy Phase 2** (northwind 4 chunks, villa 30, pgvector
0.8.2). With HNSW forced and `hnsw.ef_search = 2`, villa got **0 rows**: both
chunks the walk visited were northwind's. The pipeline then logs
`[retrieve] villa vector:0`, the D-008 short circuit fires, and the bot refuses
a question its documents answer. Nothing errors.

**Why it is low today:** at this size the planner does not use HNSW for a
tenant-scoped search at all. It reads `chunks_tenant_idx` and sorts exactly.

**Mitigation:** `match_chunks` sets `hnsw.iterative_scan = 'strict_order'`, and
with that the same forced query returned **5**. The walk keeps going instead of
giving up. It is still bounded by `hnsw.max_scan_tuples` (default 20,000).
**Re-measure at ten tenants and at fifty**, the way `notes.md` § "Tenancy
Phase 2" did. The symptom to watch for in the logs is `[retrieve] <slug>
vector:0` on a question that should hit.

---

## R-11 · Isolation is enforced by application code, not by the database · **The one that would be a breach**

**The risk:** `service_role` bypasses RLS (D-006). The composite foreign keys
protect *writes*: a chunk or message cannot be filed under the wrong tenant.
But every *read* is a `tenant_id` filter that someone remembered to write. One
missed filter is a cross-tenant read that throws no error, logs nothing, and
returns plausible answers.

**Why it can happen:** the next feature adds a query, and the query works,
because it returns rows.

**Mitigation, all observed passing 2026-09-23:**

- The pipeline cannot be called without a tenant (D-027). The grep of every
  `from(...)`/`rpc(...)` line in `packages/rag/src` shows a tenant on 15 of 15.
  Re-run it and read it after any change there.
- **`pnpm --filter @rag/pipeline isolation`: 11/11.** It covers cross-tenant
  list, chunks, delete, answer, conversation reuse, transcript read and ingest.
- **The eval battery's leak cases:**
  - leak-1: northwind refuses villa's parking fact;
  - leak-2: northwind refuses villa's Wi-Fi password, and a control proves it
    is findable from villa;
  - leak-3: a villa transcript read as northwind is `null`.
- `verify.mjs` check 14: a search as another tenant returns 0 rows.

The real fix is RLS policies that carry the tenant (R-2). Until then, those
suites are the only things that will catch a regression.

**Amended 2026-09-26, auth-rls: reads now have a second wall (D-038).**
- A missed filter under a token now returns only the token's tenant's rows.
  Measured: villa's chat token with NO filter reads 30/30 of villa's chunks
  and 0 foreign rows, and `match_chunks` naming another tenant returns 0.
- The filters stay, and `isolation -- --filters-only` proves they still hold
  alone (11/11, bookings 12/12).
- What is left of this risk: a query run on `@rag/db/service` (tools only),
  and a table added without a policy (R-22).

---

## R-12 · A persona erodes refusals over time · **Re-opened by every prompt edit**

**The risk:** the per-tenant persona (D-029) is a line that invites the model to
be helpful. A later edit that makes it friendlier, more confident or more
"expert" can quietly turn a refusal into an answer from training data.

**Measured so far:** adding the persona changed **none** of the six Northwind
verdicts, on two runs. The battery reads 9/10.

**Mitigation:** tenancy Phase 4's gate is the mechanism. Diff the six verdicts
against `plan/baseline/eval-pre-tenancy.txt`, and treat a single flipped verdict
as the persona being wrong, not the battery being strict. CLAUDE.md rule 1 is
what keeps that gate applied.

---

## R-13 · No rate limit on the admin key · **Low while local; the first thing to add if public**

**The risk:** `POST /api/t/<slug>/admin/session` accepts as many attempts as it
is sent. Nothing throttles them, and failed attempts are not logged anywhere
beyond the normal request log.

**Why it is low:** the key is 32 random bytes (43 characters, base64url), so
guessing it is not a real attack. Each attempt also costs the server an scrypt
hash, about 50 ms measured.

**Why nothing was added:** it was deliberate. A rate limit needs state that
outlives a request, and `architecture.md` § 9 rules out retry loops and hidden
in-memory state. **Add it before a public URL**, together with audit logging of
admin actions.

**Partial answer (auth-rls Phase 0, 2026-09-26):** auth-rls replaces the admin
key with Supabase Auth passwords, and Supabase throttles those. The dashboard
shows a limit of **30**, one limit shared by sign-ups and sign-ins. That covers
password guessing at sign-in. It does not cover what happens after sign-in,
and there is still no audit log.


**Amended 2026-09-26, auth-rls Phases 5–6: the admin key is gone.**
- Staff log in with Supabase Auth, which throttles sign-ups and sign-ins
  together at **30** per window (dashboard, Phase 0).
- Our login gives one message for a wrong password, an unknown email and a
  non-member, so failures reveal nothing.
- Still missing: a rate limit on our own endpoints (the open chat, the reset
  request, which Supabase's email cap throttles hard, R-21) and an audit
  log.
---

## R-14 · The model states availability without calling the tool · **Re-opened by every tools-block edit**

**The risk:** villa's documents say *"The owners reply with whether the date is
open."* A model can answer an availability question from that chunk, or from
nothing, and never call `check_availability`. It reads fine and is wrong.

**Measured:** `tool-open`, `tool-taken`, `tool-partial` and `tool-slotfill`
assert that the tool WAS called and that its result matches the reply. All
four pass. D-035 blocks the zero-chunk version: with no tool call, the reply is
replaced with the refusal.

**Mitigation:** the battery, and the "ALWAYS call check_availability; the
documents cannot know" sentence (D-036). A tool case that fails because the
model answered from `04-booking-and-payment.md` means the wording is wrong,
not that the check is too strict.

---

## R-15 · A relative date resolved wrongly · **Visible, not prevented**

**The risk:** "this Saturday" or "the 12th" becomes the wrong `date_from`, and
the answer is right about the wrong day.

**Measured:** "8 October", with no year, on a second turn became `2026-10-08`,
because the prompt states "Today is 2026-09-24 (Thursday), Asia/Manila".
Today is the TENANT'S date. At 01:04 SGT the server's UTC date was still
2026-09-23.

**Mitigation:** the "Checked availability" box shows the dates the model sent,
not the ones typed, and availability replies must name the date (D-036).
Nothing stops a wrong resolution; it just cannot be silent.


**Found 2026-09-27 (booking-types Phase 6):** a RANGE is not resolved as a
range. For "which rooms are free from X to Y?", D-046's resolver checked the
two end dates as two single days, and the model never asked the tool for the
range: 7, 14 and 31 days all came back as 8 rows. It predates booking types
and applies to villa too. Not fixed there, because `dates.ts` is prompt text
and a change to it needs its own battery run.

---

## R-16 · Availability is a snapshot · **Harmless while the bot cannot book**

**The risk:** "open" at 10:00 can be booked by staff at 10:01.

**Why it is low:** the chatbot only reads. When a `request_booking` tool
exists, the exclusion constraint makes the losing insert a 409, not a double
booking (D-034), and the bot must say so rather than confirm.

---

## R-17 · Price is still answered from the documents · **Deliberate**

**The risk:** holiday rates, the 24/25/31 December surcharge and the per-head
charge are in `02-rates-and-schedules.md`. The bot prices from those, not from
live data.

**Why deferred:** a price tool would copy that logic and give it a second
source of truth. It becomes worth it when prices change often enough that the
documents go stale.

**2026-09-27, booking types:** a per_room tenant is now priced by the
database (D-052), and its chatbot quotes from the tool (R-23). A whole-resort
tenant, villa, is still priced from its documents, by decision
(plan/booking-types.md § 8 q3).

---

## R-18 · A tools-block sentence costs a documents answer, and one run can miss it · **Measured once, will recur**

**The risk:** the tools block sits in every prompt a tool tenant sends,
including documents questions. A sentence meant for availability answers can
change how the model answers anything.

**Measured:** "start with one sentence that answers the question and names the
date", unscoped, passed every tool case. It made `leak-2`'s villa control
("What is amihanpansol2019?", with the Wi-Fi chunk retrieved) refuse in **2
of 3** runs. The previous wording passed 3 of 3, and the scoped wording 3 of 3.
The battery runs each case once, so a 1-in-3 failure can pass a whole run.

**Mitigation:** run the full battery, not only the targeted cases
(`--only` is for before/after comparisons, not for deciding). When a verdict
flips, repeat that case under both wordings before blaming either the prompt
or noise. Write every tools-block sentence for the answers it applies to, and
say which.

---

## R-19 · The token signing key is a master key · **A leak is a full compromise**

**The risk:** `TENANT_SIGNING_JWK` is the private half of a key Supabase
trusts (D-039). Whoever holds it can mint any token, `role: service_role`
included, and PostgREST will accept it. That is the same blast radius as the
service key.

**What limits it:**
- It is read in ONE function, `mintTenantToken()`, which has no role
  parameter and mints only `authenticated`, a tenant, and five minutes.
- It is server-only: `server-only` guards `@rag/db`, and the Phase 7 bundle
  grep found neither its name, its kid nor its private `d` in 36 static
  files.
- It is never printed. The Phase 3 key went from a file to the dashboard
  through the clipboard.

**Rotating it (the procedure):**
1. Generate a new P-256 JWK with a kid into `scratch/`, printing only the kid.
2. The dashboard holds ONE standby key at a time, so remove the old standby
   first. From here until step 4, no tenant token verifies: schedule it.
3. Import the new private JWK as a **standby** key. Never rotate it to
   active, or Supabase Auth would start signing with it.
4. Put the one-line JWK in `.env` as `TENANT_SIGNING_JWK`, restart, and run
   `pnpm --filter @rag/db verify`.
5. Revoke the old key, then check that a token it signs gets `401 PGRST301`.

That is what Phase 3 did, measured.

---

## R-20 · A transcript is readable by anyone holding its conversation uuid, within the tenant · **Unchanged by RLS**

**The risk:** `GET /api/t/<slug>/conversations/:id/messages` is open, like
chat. Anyone with a conversation's uuid can read it back. RLS isolates
tenants, not visitors, so villa's chat token can read every villa
transcript.

**Why it is tolerable today:** the uuid is random (122 bits) and appears
only in the visitor's own browser. The route does not list conversations.

**What would fix it:** a per-visitor claim on the chat token, which needs a
guest identity. That is out of scope (plan/auth-rls.md § 6), and it is the
same prerequisite as `request_booking`.

---

## R-21 · Supabase's built-in email sender caps staff email · **Blocks real staff; configuration fixes it**

**The risk:** invites and password resets go by email. Supabase's built-in
sender allows only a few emails an hour.
- Observed in auth-rls Phase 5: an invite plus two reset requests used it up.
  The next reset got `429 over_email_send_rate_limit`.
- A real team onboarding, or one person who forgot a password twice, runs
  into it.

**Also measured:** the sender refuses undeliverable addresses (`example.com`)
with `Email address … is invalid`.
- The reset route surfaces that as a 500, while an unknown email gets the
  generic 200.
- So for accounts at undeliverable addresses, the tools' operators included,
  the reset route shows that the account exists.
- Those addresses are documented in the code anyway, and real staff addresses
  are deliverable. It is kept visible rather than swallowed (architecture.md
  § 9).

**What fixes it:** custom SMTP (plan/auth-rls.md § 2.6), before any real staff
are invited.

---

## R-22 · A policy that is too tight looks like a wrong answer, not an error · **Caught by the battery**

**The risk:** RLS denies by returning nothing. A chat token that cannot read
`documents` makes the sources panel say "(deleted document)". One that cannot
read `slots` gives a tool with no slot names, and one that cannot read
`chunks` gives a polite refusal. None of these errors, and all of them look
like the model or the data.

**What catches it:**
- **The eval, verdict by verdict** (auth-rls Rule 3): 18/19, identical to
  the pre-auth baseline, on chat tokens.
- **verify's count matches:** every table's row count under a token equals
  the service-role count for that tenant.
- **A new table needs its policy in `schema-auth.sql`** in the same change,
  or every token reads 0 rows from it.

---

## R-23 · The model quotes a room price without the tool, or from a document · **Guarded by the battery; reopens with every prompt edit**

**The risk:** harbor's documents hold an out-of-date ₱3,000 brochure rate and a
₱40,000 whole-inn rate. A model that reads them could quote either as a room
price.

**What guards it:** the per_room tools block ("Quote a room's price only from
the tool result"), and `rt-price` / `rt-mix`, which compare the reply with
the TOOL's price for that row. 30/30 over three runs. The same shape as R-14.

---

## R-24 · Base rate only: holidays and surcharges are not modelled · **Accepted (booking-types § 8 q2)**

**The risk:** a per_room tenant with holiday rates gets too low a quote on a
holiday. **Accepted:** weekday/weekend was enough for the first tenant. The
tool calls it a base rate; the fix is a `rate_overrides (unit, slot, date)`
table, read by `unit_price()`.

---

## R-25 · Retiring a room with future bookings · **By design**

The bookings stay valid, keep their room, and block nothing new. The Rooms
screen counts them in the next 92 days and asks before retiring; it does
not cancel them.

---

## R-26 · A per_room tool result grows with rooms × slots × days · **Measured and capped**

36.3 input tokens a row (Phase 6); MAX_AVAILABILITY_ROWS 150 ≈ 5,400 tokens;
a month of harbor's four rooms is 124 rows. Beyond the cap, the tool returns
an error that says how to narrow the question.

---

## R-27 · Free plan Storage egress is 5 GB a month · **Low while photos are staff-only**

Browser-resized WebP keeps each view small: a real phone photo measured 86.8
KB at 1600×1067 (2026-09-28), so 5 GB is roughly 60,000 photo views a month.
Showing photos to chat visitors would change this sum.

---

## R-28 · Storage might not accept our minted tokens · **Closed 2026-09-27**

The Phase 1 spike: 9/9. Our ES256 tokens are accepted and Storage policies see
`tenant_id` and `app_admin`.

---

## R-29 · A direct POST can skip the browser resize and keep EXIF/GPS · **Accepted**

Staff-only route. The size and type checks still hold; only the metadata
stripping is the browser's.

---

## R-30 · Objects can outlive their rows · **Low; invisible**

Deleting a tenant cascades to `unit_images`, not to Storage, and a failed
object delete is logged, not retried. A leftover object is invisible and
costs space. The isolation and rooms suites remove their own; there is no
orphan sweeper yet (plan § 2.8 named one, `storage-orphans.mjs`; not built).

---

## R-36 · Giving an existing room a fee raises its future prices · **By design; stored prices are safe**

Setting a standard capacity and a rate on a room makes its NEXT booking for
more than the standard dearer. Bookings already made keep their stored
breakdown (D-068). harbor's rooms were given standard 2 / ₱250 on purpose
(extra-guests § 7 q1); nothing else changed.

---

## R-37 · The model quotes a party total it added up itself · **Guarded by the battery**

The tool gives the total only when it knows the guests, and the
instructions say "never add up a total yourself". `rt-extra`, `rt-guests` and
`rt-standard` compare the reply with the tool's total: 39/39 over three runs.
It reopens with every prompt edit, like R-14 and R-23.

**Related, found 2026-09-28:** a Tagalog availability question that the
date pre-check (D-046) did not recognise ("May bakanteng kwarto…") was left
to the model, which then asked for a date it had been given. Fixed in
`dates.ts`; the lesson is that a missing pre-check looks like a prompt
failure (CLAUDE.md trap 18).

---

## Explicitly still missing after tenancy

Not risks of the build as it stands, but things a real multi-tenant product
needs and this one does not have: RLS policies, tenant self-signup, per-tenant
OpenAI keys or spend caps, usage metering, audit logging of admin actions, and
any way for a tenant to export or delete everything it owns (`plan.md` § 6).

**After bookings (2026-09-24):** guests cannot book through the chat (the only
tool is read-only). Tool calls are not saved with the transcript, because
`messages.role` allows only user and assistant (plan/bookings.md § 2.6). There
is no turnover gap between bookings, no price tool (R-17), and no calendar
view beyond a 14-day list.

---

## What to validate before committing real time

Ordered. The first two are Phase 1 and take under an hour combined.

1. **An embedding call works and returns 1536 numbers.** Proves billing, key,
   network and model name in one go.
2. **A vector round-trips through Supabase intact** — inserted as an array, read
   back as 1536 numbers. Proves the schema.
3. **`match_chunks` returns sensible ordering** on three hand-written chunks with
   obviously different topics. Proves the search.

If all three pass, nothing significant is left to derisk — the rest is assembly.

**After booking types (2026-09-27):** guests still cannot book (tools stay
read-only; plan/payments.md is the next plan). No holiday or per-head pricing
(R-24), no orphaned-photo sweeper (R-30), photos only on the staff screen,
and date ranges reach the tool as their two end dates (R-15).

