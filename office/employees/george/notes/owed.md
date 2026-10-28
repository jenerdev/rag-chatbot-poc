# Owed (George's digest; built 2026-10-27 at watermark `e1a41db`)

Everything the record calls owed, uncommitted, un-walked, waiting on the
user, or listed in `todo.md`, each with the file and heading that says so.
Oldest first within a section. The record wins any disagreement.

## 1. Owed walks and runs (a builder or QA; no money unless the line says)

| Item | Says so | Money? |
|---|---|---|
| Booking-types Phase 4 browser walk (the Rooms screen, Included / extra guests, by the user) | CLAUDE.md header ("Phase 4's browser walk is owed"); status.md:961, 989 | no |
| Promos: the walk | CLAUDE.md header ("the walk owed"); status.md:822 ("the plan marked complete, the walk owed"), 2444 | no |
| Dashboard: the walk | CLAUDE.md header ("the walk owed"); plan/dashboard.md | no |
| Notifications Phase 6: the phone walk, "gated on deployment or a tunnel" | plan/notifications.md:24; status.md:213 | no |
| Room types Phase 2/5: `pnpm eval` (63 cases; `rt-count`, `rt-count-full` never run) | status.md:106, 119, 125; CLAUDE.md Layout | **yes** (OpenAI), and needs northwind + harbor |
| Room types Phase 4: axe `plan/ui-refresh-a11y.mjs` started 2026-10-20, result not recorded | status.md:116–117 | no |
| Room types Phase 6: both isolation suites on tokens, the build grep, both harbor walks, the axe re-audit | status.md:129 ("Not runnable") | no; needs the test tenants |
| Audit log: the isolation suites' new checks | status.md:81 | needs the test tenants |
| `plan/public-brand-a11y.mjs` | status.md:79 ("needs harbor") | needs harbor |
| Free guests: the platform form's free-guest field ON SCREEN (checked over HTTP only); the staff form's and the platform's field photographed | status.md:65; whats-done.md:10047 | no |
| Free guests: `pnpm eval` and the bookings isolation suite | whats-done.md:10047, status.md:1909 | needs the test tenants |
| Date field Phase 4: the user's look at Holidays (submit with no date), Promos, Slots, the staff booking form, the booking page on a phone | status.md:69 | no |
| Native fields: the user's look at the receipt field on a real stay; `plan/ui-refresh-a11y.mjs` | status.md:71 | no |
| Staff app icon (D-146): the user installs on a phone | status.md:69 | no |
| Auth-rls: three email checks (the northwind invite, step 6, the reset email) owed to the email cap | status.md:49–50, 3490, 3519; R-21 | no; blocked on SMTP |
| The eight test chats left on villa and alteza 2026-10-26 ("what are your room rates?", 10:19–10:24 UTC) | whats-done.md:10038; status.md:1920 | no |
| Fix later: `plan/ui-refresh-phase5-walk.mjs` stale (three sections; four steps); `schema-manage-booking.sql` cannot be re-run | status.md:152; trap 25 | no |
| Manage booking Phase 7: guest email, gated on deployment | CLAUDE.md header (D-104 paragraph); status.md:83 ("guest email") | a provider |
| Voice: a policy-version bump for each tenant that turns voice on | status.md:98 | no |

## 2. Waiting on the user

| Item | Says so |
|---|---|
| Legal: confirm three provisional answers (chats 365 days, guest details 3 years; deletion by email; the platform's name and contact) | status.md:145–149; plan/legal.md § 0 |
| Legal: a lawyer replaces the texts in `lib/legal.ts`; a DPA date for villa (alteza's is signed 2026-10-01; harbor is gone) | status.md:150; R-60; status.md:1911 |
| Custom SMTP in Supabase before real staff | todo.md:11; R-21 |
| On deployment: daily `retention -- --remove` and `storage-orphans -- --expired --remove` | status.md:151; R-59 |
| Pre-deploy findings: security headers (R-55), CSRF (R-56), the first `X-Forwarded-For` entry (R-57), `pnpm audit --prod` advisories (R-58), deploy-time secrets checklist (R-61) | risks.md:851–963 |
| Rebuild the test tenants from `fixtures/`? ("Ask before rebuilding them; the user declined, 2026-10-20") | CLAUDE.md header, last paragraph |
| Decide whether `gpt-4o` is worth ~16× the input cost | status.md:1819 |
| A subdomain per tenant on Vercel (noted 2026-09-28, not built) | status.md:1823–1838 |
| Voice Phase 0: listen to `plan/voice/phase0/` (the peso amount, the Taglish) | status.md:89 |
| AI employees: Python for security-guidance's hooks; the three `/mcp` logins (Context7, GitHub, Supabase) | whats-done.md:10095, 10115 |
| ~~AI employees: q13, the user's APPROVE on gates 2 and 5 of `analytics`~~ DONE: both APPROVED by the user 2026-10-28 (office/pipeline.md). **Analytics ON HOLD by the user, 2026-10-28** ("we will put the analytics on hold for now"): T-018 (Finn, the build) dropped with that note; gates 1–5 stand. To resume: the user's word, then re-task Finn from plan/analytics.md Phase 0 (needs Context7 authorised; BR-7 still holds real guests until a lawyer confirms docs/legal/analytics.md § 6) | office/pipeline.md; T-018's note; M-028 |
| AI employees Phase 4: the interactive teammate run, the user's hand | whats-done.md:10105; plan § 8 Phase 4 |
| AI employees Phase 3: the tokens and seconds of this build and of a second wake, and security-guidance's Stop cost, "measured and recorded" (George cannot measure her own session; the user reads them) | plan/ai-employees.md § 8 Phase 3 |

## 3. Uncommitted (the user's hand: Rule 8; q6 says commit the office)

`git status --short` on 2026-10-27 at `e1a41db`:

- modified: `.claude/settings.json`, `package.json`, `status.md`, `whats-done.md`
- untracked: `.claude/agents/`, `office/`, `plan/ai-employees.md`, `plan/ai-employees/`

status.md:59 says of Phases 1 and 2: "Not committed." Everything before
them is committed: D-147 `cd1c21a`, D-148 `677defa`, D-149 `d000260`,
D-150 `34c7df7`, the record `e1a41db` (git log).

## 4. Small defects the record recorded and did not fix

| Item | Says so |
|---|---|
| R-62a: the chat's "3 guests" may include a free child (one extra-guest fee in the QUOTE; the chat does not book) | risks.md:988–998 |
| R-62b: the DPA gate fires on the upsert, so the platform cannot edit villa's bookings config until its DPA date is recorded (fix: an UPDATE path in `setApplication()`, or the trigger skipping `on conflict`) | risks.md:999–1008 |
| D-141 left alone: tenant resolution per request (measure first), OpenAI prompt caching (Rule 1, the battery cannot run) | status.md:1927 |
| D-149/D-150 closed unless measured: the session as a prop; one SQL read for the frame | status.md:61; whats-done.md:10085 |

## 5. The record's own stale pages (a documentation task)

Listed with evidence in `project-map.md` § 10: D-013 vs the deploy; the
status.md Snapshot (2026-09-30); screens.md "2 screens"; techstack.md and
architecture.md § 3, § 7 (the Express brief); CLAUDE.md's "alteza walk
owed" vs status.md:130; R-2's heading never closed.

## 6. `todo.md`, line by line (todo.md:1–11), with what the record already holds beside each

1. Facebook Messenger integration — nothing in the record; q12 names it "a second full run" (plan/ai-employees.md § 9).
2. Tool calls for dynamic data — `check_availability` exists since 2026-09-24 (D-037); the line was never struck.
3. The chatbot asks "what date?" then calls the tool — the model did ask, 6 of 6, and D-046 moved the date into code instead; a range is resolved too (R-15 half fixed). The line was never struck.
4. Google Analytics — nothing built; q12 recommends it as the first full-lane idea.
5. Record all questions that are not answered — S-4 Unanswered exists (D-045). Never struck.
6. Custom SMTP (R-21) — waiting on the user (§ 2).

## 7. Ideas: on the pipeline, and waiting for it (charter § 8, § 9)

The status of an idea is `node office/office.mjs pipeline`, never this
table (Rule 10); this table says where each one entered and who holds the
first task.

| Slug | Title | Lane | From | Entered | First task |
|---|---|---|---|---|---|
| analytics | Google Analytics on the public pages (the chat, the booking page, Manage booking) | full | user (todo.md:9); q12 | 2026-10-27, `idea add` | T-001 on ivy's board (gate 1, `docs/product/analytics.md`); M-001 carries the context (plan.md:678's seam, R-55, D-127, D-129–D-131, R-60). **ON HOLD 2026-10-28** (the user): Approved through gate 5, not built; T-018 dropped |
| free-guest-field | The platform form's free-guest field seen on screen | short (Approved at birth) | the record (status.md:65, whats-done.md:10047); q12 | 2026-10-27, `idea add` | T-002 on finn's board (gate 6, then quinn on gate 7); M-002 carries the context (plan/free-guests.md § 3.3 and Phase 3, R-62b, trap 26, trap 16, Rule 7: no money) |
| messenger | Facebook Messenger | full | user (todo.md:1) | not yet on the pipeline | "a second full run once the first has amended § 4.2" (q12) |
