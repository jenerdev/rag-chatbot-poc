# Phase 3 — George's first day, observed (2026-10-27)

[`plan/ai-employees.md`](../ai-employees.md) § 8 Phase 3, run on Claude Code
2.1.310 against `e1a41db`, every run `claude --agent george -p … --output-format
json` with Read, Grep, Glob, Bash, Write and Edit pre-allowed (the guard
still deciding). The JSON results are beside this file (`day1.json`,
`wake2.json`, `q1.json`). Her charter gained items 8–10 (intake, the
ladder, the organization's memory) before the day began.

## The measurements

| Run | Turns | Wall time | Output tokens | Cache written | Cache read | Cost |
|---|---|---|---|---|---|---|
| The first day: wake, build the four digests, the brief | 55 | 335 s | 27819 | 153359 | 1082696 | 4.73 USD |
| A second wake, a fresh session, nothing changed in the record | 14 | 28 s | 2180 | 50961 | 221059 | 1.18 USD |
| The ten questions, answered in ONE turn (see below) | 16 | 76 s | 6130 | 31250 | 381204 | 2.21 USD |

- The first day read the record by heading and offset (her charter § 1):
  1.08 M cache-read tokens over 55 turns, none of them a whole-file read of
  `whats-done.md` (10,125 lines). It wrote `project-map.md` (307 lines),
  `owed.md` (91), `briefs/2026-10-27.md` (49) and `README.md` (18), every
  fact with a file and line or a D-/R-number.
- A quiet wake is 14 turns and 28 s: she read her index and the old
  watermark, ran `index`, `inbox`, `task list`, `git log e1a41db..HEAD`
  (empty), `git diff --stat` of the record files and `git status`, found
  nothing new, amended nothing. Its cost is a quarter of the first day's,
  mostly the agent's own context (her charter, the organization's rules,
  the skill preloads to come): the wake is cheap in reads, not free in
  tokens.
- security-guidance's Stop review could not be measured: its hooks need
  Python, and this machine has only the Store stub (plan § 7.8). Owed with
  the user's install.

## The ten questions

The plan asked them one by one in a resumed session. The shell loop that
sent them piped the list on standard input, and the first `claude -p` call
read the remaining nine lines as its own input, so George received all ten
in one message and answered all ten in one 76-second turn, each with its
source. The result is kept as it happened; the per-question cost is lost
(trap: a `while read` loop around a command that reads stdin needs
`< /dev/null` on the command). The user grades the answers against the
record; an answer with no source is a fail by the plan's rule.

### Her answer, verbatim

**1. What is this project?**
A retrieval-augmented chatbot for resorts: a business pastes documents, visitors ask questions, and the bot answers only from those documents and refuses rather than invents (CLAUDE.md "What this is"; plan/ai-employees.md § 3.3 calls it "a multi-tenant RAG chatbot for resorts with bookings, payments, staff roles, a platform"). It is multi-tenant since 2026-09-23 (one database, each business at `/t/<slug>`, plan.md) and has grown bookings, a public booking page, guest self-service and payments, roles and a super-user platform, notifications, feature flags, the legal groundwork, room types, voice, an audit log and free children (CLAUDE.md header, D-032 through D-147). Its standing requirement is that it be understood: no library does a pipeline step, every number was measured, the why is in the code (D-001, D-002, CLAUDE.md "The thing to understand before changing anything", notes.md).

**2. Yesterday (2026-10-26)** — written up in `notes/briefs/2026-10-27.md`. Three commits, five `whats-done.md` entries (lines 10031–10068): the plain rate table straightened (villa's rate card drew as a staircase, D-094's grouping; `3773dce`); free guests, D-147, `plan/free-guests.md` Phases 0–6 with the walk 7/7, verify 243/243, rooms 57/57 (`cd1c21a`), with two amendments the same day (the party inputs on one line; the rule as a notice on the booking page); the build tag on every page, D-148 (`677defa`).

**3. Now** — `status.md:59`, the last sentence: "Next: q11 and q12 (names, the first idea), then Phase 3, George's first day …, and your hand: Python, the three `/mcp` logins." Phase 3 is this session. The office itself is not committed (status.md:59 "Not committed."; `git status`: `office/`, `.claude/agents/`, `plan/ai-employees.md`, `plan/ai-employees/` untracked). Everything above it in Next up (D-149, D-150, D-148, D-147) is done and committed.

**4. Owed** — the full list is `notes/owed.md`; the headlines:
- Walks never recorded done: booking-types Phase 4 (CLAUDE.md header), promos (status.md:822), dashboard (plan/dashboard.md), notifications' phone walk (plan/notifications.md:24), date-field Phase 4 and the receipt field (status.md:69, 71), the staff app icon on a phone (status.md:69).
- Runs that need the deleted tenants: `pnpm eval` (63 cases; `rt-count`, `rt-count-full` never run), both isolation suites on tokens, the harbor walks, `public-brand-a11y.mjs`, the axe re-audit (status.md:106–129).
- Free guests: the platform form's field seen on screen, checked over HTTP only (status.md:65).
- Waiting on the user: the three legal answers, a lawyer's texts, villa's DPA date (status.md:145–150, R-60); custom SMTP (R-21); the pre-deploy risks R-55–R-58, R-61; daily `retention`/`storage-orphans` on the deploy (R-59); q11, q12; Python and the `/mcp` logins (whats-done.md:10115, 10124).
- Recorded, not fixed: R-62a (the chat's "3 guests" may include a free child), R-62b (the DPA gate blocks editing villa's bookings config on the platform); eight test chats left on villa and alteza 2026-10-26 (whats-done.md:10038).
- Stale pages in the record (project-map.md § 10): D-013 still says local-only; status.md's Snapshot dated 2026-09-30; screens.md "2 screens"; techstack.md and architecture.md describe the Express brief.
- `todo.md`: Messenger, Google Analytics, custom SMTP; three lines already done and never struck.

**5. Why a page, not the chat** — D-069 (decisions.md:2074): the user chose it for the MVP: "booking and payment are a page's job; the chat's is to answer." It keeps D-037 intact (tools stay read-only; the chat route is open, so a write tool would be an unauthenticated write) and needs no prompt edit, which rule 1 says is where a helpful change costs a refusal. Measured: prompts and tool definitions byte-identical, the `book-*` cases 5/5; a request holds nothing until staff confirm (D-070), and `request_booking()` is the one public write (D-071).

**6. Tenants** — `villa` (whole_resort, DPA unsigned, R-62) and `alteza` (per_room, voice on, `free_up_to_age: 3`) are live; `northwind` and `harbor` were hard-deleted 2026-10-20 by the user, who declined rebuilding them (CLAUDE.md header, last paragraph; status.md:129). Cannot run as written: `pnpm eval` (rule 1 needs three tenants), `@rag/pipeline isolation` on tokens (24) and `@rag/bookings isolation` on tokens (42), every harbor walk, the northwind prompt snapshot and harbor's tool baseline. Still runs: verify (243), rooms (57), the package tests, typecheck, the villa and alteza walks (project-map.md § 9).

**7. The price function** — `unit_quote(tenant, unit, slot, date, guests)`, D-066 (decisions.md:2024): the only price arithmetic, returning base, extra guests, extra charge and total; the trigger overwrites anything a request sends. Callers, confirmed in code: the bookings insert trigger (`schema-customer-booking.sql:282`), the staff quote (`bookings.ts:606`), `check_room_availability()` for the tool (`schema-holds.sql:409–410`, the live definition; `tools.ts:622`), `request_booking()` (`schema-free-guests.sql:337`), and `unit_price()`/`rate_kind()` under it (D-082). It is still called with the PAYING count: free children never reach it (D-147).

**8. Who reads the sources** — D-140 (decisions.md:4377): a signed-in member whose role has `sources:read`; owners and admins by default, configurable per tenant and grantable to staff on the platform's Permissions tab. The chat route asks `sessionCan()` before answering and removes `sources` and `searchQuery` for everyone else; the tool evidence ("Checked availability") stays for all (rule 7).

**9. Trap 8** — CLAUDE.md "Traps", 8: "Check, then insert" double-books. Never read availability and then insert; insert, and let `bookings_no_overlap` refuse the loser with `23P01`, which `@rag/bookings` maps to a 409 (D-034). Trap 21 is its screen-side twin: the disabled Confirm button is not the guard.

**10. The next employee and the first task** — The Full-Stack Engineer (recommended name Finn, q11; plan § 4, the sixth row), on the short lane: the platform form's free-guest field seen on screen, the one item the record calls owed with its plan already written (status.md:65; plan § 8 Phase 7: "the short lane on the platform form's free-guest field on screen"; `owed.md` § 7, slug `free-guest-field-on-screen`). It spends nothing, needs only villa or alteza, and ends with QA (gate 7) on `plan/free-guests-walk.mjs`. But the plan's order puts Phase 5 (guards by profile, the pipeline) and Phase 6 (the hires, needing q11) before any hire, so the first thing is still yours: answer q11 and q12, and commit the office (q6).

## What it decides

- **The digests work as the plan said (q1 taken):** a wake reads a few
  hundred lines, not the record, and the answers cite file and line.
- **The record's own contradictions are now a list** (`project-map.md`
  § 10: D-013 still "local only" after the deploy; status.md's Snapshot
  dated 2026-09-30; screens.md "2 screens"; techstack.md and
  architecture.md describing the Express brief; CLAUDE.md's "alteza walk
  owed" vs status.md:130; R-2's heading never closed). Each is a
  documentation task for the engineer, through George, not a fix by her.
- **Her own last answer agrees with the plan's order:** Phases 5 and 6
  before any hire; q11 and q12 were answered in the session that ran this
  phase ("proceed with your recommendations": the nine names, Google
  Analytics), which the record did not yet carry when she read it.
