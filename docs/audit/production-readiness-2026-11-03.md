# Production readiness audit — 2026-11-03

**Scope.** The whole repository at `master` `b380c1c`: `apps/web` (Next.js 15, App Router), `packages/*` (`@rag/db`, `@rag/bookings`, `@rag/pipeline`, `@rag/openai`, `@rag/push`, `@rag/chunker`), the 46 SQL files in `packages/db/sql/`, configuration, tests and process documents.

**How.** Five read-only reviews in parallel (API and web security; database, RLS and booking integrity; chatbot and AI security; deployment, privacy and testing; UX and admin), then every Critical and High finding re-checked against the code by hand before it went into this report.
- No code was changed and nothing was written to the database.
- No OpenAI call was made.
- Against the local dev server: GET requests and header reads only, and the booking page viewed at 390 px and 1280 px without sending a request.

**Status labels.**
- **VERIFIED**: read in the code, or observed.
- **POTENTIAL**: a real path, but it depends on something not seen.
- **MANUAL**: lives in a dashboard or a device, and cannot be checked from the repository.

---

## A. Executive summary

**Verdict: partially ready.** Not ready for real guests and real money yet. The core is unusually strong; what is missing is mostly the layer around the core.

### What is genuinely production-grade

**Tenant isolation is enforced twice.**
- Every query filters on `tenant_id`.
- Postgres RLS policies check the token's tenant on every table. All 30 tables have RLS on, and none has a `using (true)` policy.
- Requests never use `service_role`; a build check fails any import of the service client in app code.

**Money and availability are decided in Postgres, not the browser.**
- `unit_quote()` and its triggers overwrite every price column on insert, so a client cannot set a price.
- Double booking is refused by a per-room exclusion constraint (`bookings_no_overlap`), and rooms are assigned under an advisory lock.
- Confirm is a single statement. No path checks availability and then inserts.

**The chatbot cannot change anything.**
- It has one read-only tool, scoped to the tenant by the server.
- The tool's arguments carry no tenant, unit or booking id.
- A reply renders as React text: no HTML, no links.

**Staff routes are guarded consistently.**
- All 76 route handlers are wrapped.
- Each admin handler checks its named permission first, before any database access, and Postgres re-checks the role.
- Inputs are validated with zod. No client field can set a price, status, tenant or role.

**Uploads, cookies and logs are handled carefully.**
- Uploads are checked by their bytes, given server-built names, and proofs go to a private bucket.
- Cookies are HttpOnly, Secure and HMAC-signed.
- Staff actions are audited in `audit_log`.

### What stops a launch today

**1. The edges are open.** Each item below was re-checked by hand.
- ~~No security headers (clickjacking is possible on staff and platform screens).~~ **Fixed 2026-11-14** (D-156): `lib/security-headers.mjs`, `plan/security-headers-walk.mjs` 29/29.
- No rate limit on staff and super-user login or on password reset.
- Internal Postgres and OpenAI error text is sent to anonymous visitors.
- OpenAI calls have no timeout and no output cap.

**2. A data-integrity bug.** Approving a guest's reschedule drops their free children and their promo discount, so the stay is silently re-priced upward. Verified at `schema-manage-booking.sql:1541`.

**3. No operational layer.** None of these exist:
- CI, scheduled jobs, error monitoring, a health check.
- A migration runner or a record of which SQL files have run.
- A separate production database (dev, test and "prod" are one Supabase project).

`master` is currently red: one unit test fails (see B-1).

**4. Guests are never told anything.** No email is sent for a request, a confirmation, a decline or a verified payment. A guest who loses the reference shown once on the receipt has no way back.

**5. The legal texts are placeholders.** The privacy notice and terms say so in the file (`lib/legal.ts:3`). Under RA 10173 that matters before collecting personal data from real people.

**6. The safety net for the chatbot cannot run.**
- The 63-case regression battery needs two test tenants that were deleted on 2026-10-20.
- The cross-tenant isolation suites cannot run for the same reason.
- Several changes to what the model reads have shipped since its last run (59/61, 2026-10-16).

None of this is a sign of a weak codebase. Most of it is already listed honestly in `risks.md` (R-55 to R-61) and `release-process.md`. It is the work that remains between a well-built system and a live one.

---

## B. Critical and high-severity issues (must fix before launch)

| # | Issue | Severity | Status | Location |
|---|---|---|---|---|
| B-1 | `master` is red: `guest.test.ts` fails after D-154 (`extraGuestCount` added, test not updated); `pnpm test` exits 1 | High | VERIFIED | `packages/bookings/src/guest.test.ts:44` (introduced by `8215020`) |
| B-2 | ~~No security headers: no CSP, `frame-ancestors`/X-Frame-Options, HSTS, nosniff or Referrer-Policy; `X-Powered-By` sent~~ | High | **FIXED 2026-11-14** (D-156) | `apps/web/next.config.mjs` (no `headers()`), no `middleware.ts` |
| B-3 | Approving a reschedule drops `free_guests` and `promo_id`; the stay is re-priced without its discount and the child disappears | High | VERIFIED | `packages/db/sql/schema-manage-booking.sql:1541-1546` (`decide_change()`) |
| B-4 | No rate limit on staff or platform login, nor on password reset. Supabase's own limit counts the SERVER's IP, so one attacker can lock out every staff member or burn the email quota | High | VERIFIED (code); Supabase side MANUAL | `app/api/t/[tenant]/admin/session/route.ts`, `app/api/platform/session/route.ts`, both `password-reset/route.ts` |
| B-5 | OpenAI `embed`, `chat` and `chatStream` have no timeout; a closed tab does not abort generation; answers have no `max_tokens` | High | VERIFIED | `packages/openai/src/index.ts:256,310,441`; `chat/route.ts:98-101` |
| B-6 | Internal error text (Postgres, PostgREST, OpenAI) returned to clients on every 500, including the open guest routes and the chat stream | Medium-High | VERIFIED | `apps/web/lib/route.ts:64-66`; `chat/route.ts:120-122` |
| B-7 | No CI: no typecheck, tests, service-import check or audit on push; no branch protection; no release tags, so the documented rollback is on paper only | High | VERIFIED | no `.github/` |
| B-8 | One Supabase project serves dev, test data and "production"; no migration ledger or runner; 46 files pasted by hand, some unsafe to re-run (traps 20, 25) | High | VERIFIED (process); prod state MANUAL | `release-process.md`; no `schema_migrations` |
| B-9 | No scheduled jobs: retention (the privacy policy's promised periods), payment-proof expiry and `expire_due_stays` run by hand or only when staff load a list | High | VERIFIED | no `vercel.json`/cron; `deadlines.ts:10` |
| B-10 | No guest notifications of any kind (no email or SMS); the reference is shown once with no recovery | High (business) | VERIFIED | no mail code in `apps/` or `packages/` |
| B-11 | Privacy notice and terms are placeholders; operator, address and privacy contact are `[bracketed]`; no cross-border transfer disclosure (OpenAI US; Supabase and Vercel Singapore) | Critical for real guests | VERIFIED | `apps/web/lib/legal.ts:3` and `PLATFORM` |
| B-12 | Chatbot regression battery (63 cases) and both isolation suites cannot run (test tenants deleted); prompt-affecting changes D-133, D-147 and D-154 shipped unmeasured | High | VERIFIED | `packages/rag/tools/prompt-eval.mjs`; CLAUDE.md |
| B-13 | No error monitoring, health endpoint or alerting; when Postgres is down every open route fails (the rate limiter fails closed) and nobody is told | Medium-High | VERIFIED | no Sentry, no `/api/health` |
| B-14 | Backups and plan unconfirmed (PITR, restore drill); Auth settings unconfirmed (signups off, custom SMTP, leaked-password protection, MFA for super users); OpenAI spend cap unconfirmed | High | MANUAL | Supabase, OpenAI and Vercel dashboards |

---

## C. Missing features

### Essential before launch
- **Guest email:** request received (with the reference), confirmed, declined or expired, payment verified or rejected. Needs custom SMTP or Resend; plan/manage-booking.md Phase 7 already describes it.
- **Recover a lost reference:** look up by email and phone, then re-send the reference by email.
- **Payment, deposit and cancellation/refund terms shown BEFORE "Send request".** Today they appear only after sending; `legal.ts:165` claims they are on the booking page.
- **A rate editor for whole-resort tenants.** Villa's rates and extra-guest fee can only be changed by a script, because S-5 returns 404 for `whole_resort` (`admin/accommodations/page.tsx:31`).
- **A data-subject request procedure:** access, correction, erasure, export of one guest's data across stays, bookings, messages, proofs and logs. The privacy text promises it.
- **Scheduled maintenance jobs (B-9),** and the operational items in B-7, B-8, B-13 and B-14.

### Strongly recommended
- **Staff can edit a stay directly:** guest name and contacts, party, dates. Today dates move only on a guest's request.
- **Reminders:** a pay-by reminder and a pre-arrival reminder.
- **"Talk to a person" from the chat:** a per-tenant phone or Messenger line in the welcome and under each refusal.
- **Front desk:** check-in and no-show states; an arrivals and departures list to print or export as CSV.
- **Sessions:** revoke a staff or super-user session (logout everywhere; end on password change).

### Optional / later
- Add-to-calendar (.ics) on the receipt.
- Rate-kind label (weekend / holiday) on the guest summary.
- Saving a booking draft.
- A WhatsApp hand-off.

Already present and complete (for credit): booking lookup and management by the guest, payment proof upload and staff verification, refunds, cancellation and reschedule requests, an availability calendar, holidays and closed dates, promos, a dashboard with occupancy and revenue, conversations, unanswered questions, push notifications for staff, an admin activity log, roles and per-tenant permissions, consent capture, a DPA gate, and a retention tool.

---

## D. Security assessment

| # | Issue | Severity | Status | Location | Potential impact | Recommended fix |
|---|---|---|---|---|---|---|
| S-1 | ~~No security headers / CSP~~ | High | **FIXED 2026-11-14** (D-156) | `next.config.mjs` | Staff and platform screens can be framed: clickjacking on Confirm, Verify payment, Archive tenant. Any future XSS has no second wall | `headers()`: `frame-ancestors 'none'`, a measured CSP, HSTS, nosniff, `Referrer-Policy`, `Permissions-Policy: microphone=(self)`; `poweredByHeader: false` |
| S-2 | Login and reset not rate limited | High | VERIFIED | session and password-reset routes | Password guessing; locking out all staff via Supabase's server-IP bucket; email-quota exhaustion | `allow()` per IP and per email-hash before sign-in and reset; audit failed logins |
| S-3 | Error messages leak internals | Medium-High | VERIFIED | `lib/route.ts:64`; chat stream | Schema mapping (constraint, function and column names); OpenAI key fragments in a 401 body | 500/502 → a fixed sentence plus a request id; log the detail on the server; map OpenAI 401 → 502 |
| S-4 | Change-request door never counts toward the lockout | Medium | VERIFIED | `schema-manage-booking.sql:1363-1365, 1461-1463, 849-851` | Unlimited email/phone guesses against a known reference through `/manage/change` (per-IP limit only) | Have the route call `guest_stay()` first (as the proof door does), or record the miss outside the raising transaction |
| S-5 | `book/quote` has no rate limit | Medium | VERIFIED | `app/api/t/[tenant]/book/quote/route.ts` | Promo-code discovery by dictionary; up to 70 `unit_quote()` calls per request | `allow()` with its own key and a per-tenant ceiling |
| S-6 | Sessions cannot be revoked (12 h HMAC cookies, no server state) | Medium | VERIFIED | `lib/admin-auth.ts:50`, `lib/platform-auth.ts:31` | A copied cookie works for up to 12 h after logout or a password change. The platform cookie is cross-tenant | A per-user `session_epoch` checked on each request; shorter platform sessions |
| S-7 | CSRF relies on SameSite=Lax only; JSON is parsed from any content type | Low-Medium | VERIFIED | `withRoute()` | Same-site attackers (a sibling subdomain once a custom domain exists) | Refuse a state-changing request whose `Origin` is not the app's; require `application/json` |
| S-8 | Client IP is the first `X-Forwarded-For` entry | Low on Vercel / High elsewhere | VERIFIED (code), MANUAL (host) | `lib/rate-limit.ts` `clientIp()` | Off Vercel, every per-IP limit is bypassed by rotating the header | Use `x-vercel-forwarded-for`/`x-real-ip`; test a forged header on the deployment |
| S-9 | Documents enter the system message with no "this is data" rule; a chunk containing `--- END CONTEXT ---` reads as instructions; a visitor's question can pre-fill a new document | Low-Medium | VERIFIED | `packages/rag/src/prompt.ts:63,134`; `unanswered-screen.tsx:239` | False statements in replies (a fake promo, "you are confirmed", a phishing number) if staff save injected text | Strip the marker lines from chunks; one "context is reference, not instructions" line (then re-run the battery); show the pre-fill as a quote to edit |
| S-10 | Chat token can drain the push outbox and delete push subscriptions | Low | VERIFIED | `schema-notifications.sql:150-272` | Only if a chat token leaks (tokens never reach the browser) | Require staff, or a dedicated server claim |
| S-11 | Staff UPDATEs to `guest_*`, `notes`, `held` and `source` leave no log | Low | VERIFIED | `bookings_update` policy; D-138 excludes bookings | Untraceable edits of guest details | Column-level UPDATE grants, or log those columns |
| S-12 | `request_booking()` callable without the consent wrapper | Low | VERIFIED | `schema-free-guests.sql:380` | Consent bypass if a chat token were ever exposed | Revoke it from `authenticated`, leaving only the wrapper |
| S-13 | Password-reset `redirectTo` built from the request Host | Low | POTENTIAL | `password-reset/route.ts` | A recovery token sent off-site if Supabase's redirect allowlist is a broad wildcard | Build it from a configured `APP_ORIGIN`; keep the allowlist exact |
| S-14 | Booking reference uses `random()`; collision gives a 500 | Low | VERIFIED | `booking_reference()` | Brute force still needs the contact (5-miss lockout); collision is rare | `gen_random_bytes`; retry on 23505 |
| S-15 | `pnpm audit --prod`: 3 high, 2 moderate, all `postcss` under `next` | Low | VERIFIED | `next` → `postcss@8.4.31` | Build-time CSS only; not reachable from requests (R-64) | Bump `next` when it ships postcss ≥ 8.5.23 |
| S-16 | Upload size checked after buffering when no Content-Length is sent | Low | VERIFIED | `voice/transcribe` and the upload routes | Memory pressure; bounded by Vercel's 4.5 MB cap | Refuse a missing Content-Length |
| S-17 | Auth "allow signups" not confirmed off | Info | MANUAL | Supabase dashboard | A self-signed-up user gets a token with no tenant claim; policies and definers refuse it, but turn signups off anyway | Turn signups off |

**Checked and sound:**
- No `dangerouslySetInnerHTML`, `innerHTML` or `eval` in app code.
- Theme colours are regex-checked on write and on read.
- Image URLs must be https.
- No open redirect.
- No CORS headers set.
- No secret names in the built client bundle; the only `NEXT_PUBLIC_*` variable is the build tag.
- Unauthenticated admin calls get 401.
- The cookie MAC is compared in constant time, and the slug inside it is bound to the URL.
- Login and reset do not reveal whether an email exists.
- Push endpoints are on an allowlist (no SSRF).
- `.env` was never committed.

---

## E. UX/UI recommendations

From viewing the guest pages at 390 px and 1280 px, and reading the staff screens' code. Ordered by impact on bookings completed.

1. **Phone, Review step: the Send button is out of sight.** The step's footer has only Back; consent and "Send request" sit in the summary card, below the whole form on a phone (`booking-page.tsx:1015` vs `:1020,1080`). Show them inside the review step on narrow screens, or use a sticky bottom bar "Total ₱X · Send request".
2. **Phone: the price is ~1,500 px below the controls** on a per-room tenant (alteza, step 2). Add a sticky one-line total on screens under 900 px that opens the summary.
3. **Room cards carry no price.** Show "from ₱X / night" (from `unit_quote()`) and "N left" for the chosen date.
4. **Terms after the fact.** Show the deposit, the pay-by window, what happens if unpaid, and the refund policy on the Review step, before Send.
5. **After sending, nothing reaches the guest** (C, Essential). At least say on the receipt, in large type: "Save this reference: you will need it."
6. **The date picker does not show full or closed nights;** a guest learns a night is taken only after picking it. Shade full and closed days; optionally mark weekend and holiday rates.
7. **The chat is silent to screen readers.** Add `role="log" aria-live="polite"` on the turns, announcing the finished answer rather than every token.
8. **Touch targets.** Buttons are 36–40 px, fields ~37 px, the consent checkbox 16 px, footer links 20 px. Use 44 px under `pointer: coarse` and make the whole consent row tappable.
9. **The chat composer autofocuses,** which likely opens the phone keyboard over the welcome and suggested questions (MANUAL on a device). Autofocus only on fine pointers.
10. **A chat is lost on Back or reload** (the id lives in memory). Keep the conversation id in `sessionStorage`.
11. **No human hand-off from the chat** (C, Strongly recommended).
12. **Each room checkbox's accessible name includes the whole description.** Use `aria-labelledby` for the name and `aria-describedby` for the description.
13. **Two `<h1>`s on guest pages** (the brand and the page title). Make the brand an H2 or a paragraph on inner pages.
14. **Smaller items:**
    - The slot field is labelled "What": use "Day use or overnight".
    - The build tag and "Staff login" sit in guest footers: tone them down.
    - `/favicon.ico` returns 404.
    - Separators "·" are read aloud in the chat's links.
    - alteza's "Casa Uno" description is placeholder text (data, staff to fix).

**Strong already:**
- "A request is not a booking" is said consistently.
- The price breakdown is server-made and clear (including "1 extra guest").
- Steps keep what was typed.
- Focus moves to each step's heading.
- Native `<dialog>` is used for confirmations; every destructive staff action needs a note.
- Missing fields are now said, not greyed out (D-155).
- iOS does not zoom on fields.
- Reduced motion is respected.
- No horizontal scroll at 390 px.

---

## F. Production deployment checklist

**Code and repository**
- [ ] Fix `guest.test.ts` so `pnpm test` is green (B-1).
- [ ] GitHub Actions on every push and PR: `pnpm install --frozen-lockfile`, `pnpm typecheck` (includes the service-import check), `pnpm test`, `pnpm audit --prod --audit-level=critical`. Protect `master` (B-7).
- [ ] Release tags (`v1.0.0`) and a written rollback: Vercel "promote previous deployment" plus the additive-SQL rule.
- [ ] ~~Security headers~~ (S-1, done 2026-11-14, D-156) and the Origin check (S-7); a generic 500 body (S-3).
- [ ] Rate limits: login, password reset, `book/quote`; the change-door lockout (S-2, S-4, S-5).
- [ ] OpenAI: request timeouts, abort on disconnect, `max_tokens` on answers (B-5).
- [ ] Fix `decide_change()` (B-3), with a rooms check for a rescheduled stay carrying a free child and a promo.
- [ ] Redact the visitor's question in the `[rewrite]` log line (`packages/rag/src/retrieve.ts:87`).
- [ ] `.playwright-mcp/` in `.gitignore`; a `.vercelignore` for `plan/`, `office/` and `docs/`.
- [ ] Check GitHub repo visibility, and the screenshots in `plan/`, for guest data before it is ever public.

**Database**
- [ ] A NEW Supabase project for production (never promote the current one), on Pro with PITR; one restore rehearsal.
- [ ] A migration ledger (`schema_migrations`) and a script that applies the 46 files in order to an empty project; run `verify` there.
- [ ] A staging project with the fixture tenants (northwind, harbor) to run `pnpm eval`, both isolation suites, the walks and the axe pass (B-12). Re-date verify check 27's fixture.
- [ ] Auth: signups off; custom SMTP; leaked-password protection; MFA for super users; the redirect allowlist exact.
- [ ] Storage: `payment-proofs` private (re-check in the dashboard).
- [ ] Scheduled daily jobs: `retention --remove`, `storage-orphans --expired`, `expire_due_stays` for every tenant, a notification-drain fallback (B-9).

**Hosting and third parties**
- [ ] Vercel: Function region `sin1`; `SUPABASE_SERVICE_ROLE_KEY` NOT set; production values for the 7 required variables.
- [ ] Fresh `TENANT_SIGNING_JWK`, `ADMIN_COOKIE_SECRET` and VAPID keys for production.
- [ ] OpenAI: a production key with a monthly spend cap and usage alerts.
- [ ] Custom domain, HTTPS (Vercel), HSTS.
- [ ] Error monitoring (Sentry or log drains with alerts), `/api/health` (Postgres check), an uptime monitor.
- [ ] Grep the deployed build for secret names and values (CLAUDE.md rule 2); `pnpm audit --prod` on the deployed commit.

**Legal and business**
- [ ] A lawyer's privacy notice and terms; fill the `PLATFORM` placeholders; disclose cross-border transfers.
- [ ] Each tenant's privacy contact, retention periods and `dpa_signed_on`.
- [ ] A data-subject request runbook.
- [ ] Guest email (Phase 7), and lost-reference recovery.
- [ ] Remove probe and walk data, `operator` members and throwaway super users from whatever becomes production.

---

## G. Prioritized action plan

**Sizes:** S = under a day; M = 1–3 days; L = more than 3 days or depends on others.

### P0 — security or data integrity; must fix before launch

| # | Action | Size |
|---|---|---|
| 1 | Fix the failing `guest.test.ts` (B-1) | S |
| 2 | ~~Security headers + `poweredByHeader: false` (S-1)~~ done 2026-11-14 | S |
| 3 | Rate limits on staff and platform login and on password reset; audit failed logins (S-2) | S–M |
| 4 | Generic 500/502 body in production; keep the detail in server logs (S-3) | S |
| 5 | OpenAI timeouts, abort on disconnect, `max_tokens`; OpenAI spend cap (B-5) | S |
| 6 | `decide_change()` keeps `free_guests` and `promo_id`, with a test (B-3) | S |
| 7 | Change-door lockout and `book/quote` rate limit (S-4, S-5) | S |
| 8 | CI with branch protection (B-7) | S–M |
| 9 | A new production Supabase project with backups, the migration ledger and an in-order apply script, rehearsed on an empty project (B-8, B-14) | M |
| 10 | Lawyer-reviewed privacy notice and terms; cross-border disclosure (B-11) | L (external) |

### P1 — essential production functionality; must fix before launch

| # | Action | Size |
|---|---|---|
| 11 | Guest email: received, confirmed, declined/expired, payment verified/rejected; custom SMTP for staff email (B-10) | L |
| 12 | Recover a lost reference by email (C) | M |
| 13 | Scheduled jobs: retention, proof expiry, stay expiry, drain fallback (B-9) | M |
| 14 | Staging with fixture tenants; run the battery, isolation suites, walks and axe; restore the battery as a release gate (B-12) | M |
| 15 | Monitoring, `/api/health`, uptime alerts (B-13) | S–M |
| 16 | Phone booking flow: Send visible on Review, sticky total, terms before Send (E-1, 2, 4) | M |
| 17 | Rate editor for whole-resort tenants (C) | M |
| 18 | Revocable sessions (epoch); short platform session (S-6) | M |
| 19 | Data-subject request runbook or tool; redact question text in logs | S–M |
| 20 | Dashboard settings: signups off, MFA, leaked-password protection, redirect allowlist, the bucket private, `sin1`, no service key on Vercel (B-14) | S |

### P2 — important; ideally before launch

| # | Action | Size |
|---|---|---|
| 21 | Origin check for cookie-authenticated writes (S-7) | S |
| 22 | Prompt hardening: strip context markers, a "reference not instructions" line; check currency figures in replies against the tool and chunks (S-9, chatbot F8); re-run the battery | M |
| 23 | Price and "N left" on room cards; availability shading in the date picker (E-3, 6) | M |
| 24 | Chat accessibility (`aria-live` log), touch targets 44 px, the chat id in `sessionStorage`, no phone autofocus (E-7 to E-10) | S–M |
| 25 | "Talk to a person" contact in the chat (C) | S |
| 26 | Staff edits of guest details, party and dates; arrivals export/print; check-in and no-show states (C) | L |
| 27 | Refund row lock and idempotency; a cumulative-payment cap (chatbot F8 is separate) | S |
| 28 | Column-level UPDATE grants on `bookings`, or log those edits (S-11) | S |
| 29 | Accept or mitigate the per-tenant chat ceiling as a denial-of-service vector (20 IPs can exhaust 600/10 min) | S (decision) |

### P3 — after launch

| # | Action | Size |
|---|---|---|
| 30 | Revoke `request_booking` from `authenticated` (S-12); staff-only push drain (S-10) | S |
| 31 | `gen_random_bytes` references with retry (S-14); refuse a missing Content-Length (S-16) | S |
| 32 | Two `<h1>`s, the "What" label, footer build tag, favicon, separators read aloud (E-13, 14) | S |
| 33 | Reminders (pay-by, pre-arrival); .ics on the receipt; rate-kind label for guests | M |
| 34 | A Playwright smoke suite in CI against a preview deployment; unit tests for `route.ts` error mapping, cookie tampering, `clientIp()` spoofing, the rate limiter's fail-closed path | M |
| 35 | Bump `next` for postcss (S-15) | S |

---

## H. Production readiness scores

Scored on evidence seen in this audit, not on intentions in the documents.

| Category | Score | Why |
|---|---|---|
| Application architecture | **82** | Clean separation (pure packages, one error map, one price function, one taken test); every number documented. Lost points: no migration tooling, manual operations, a 46-file SQL history where order matters. |
| Security | **62** | Strong core (two-wall tenant isolation, RLS on every table, server-side prices, no service key in requests, byte-checked uploads, constant-time cookies). Lost points: no headers, unthrottled login and reset, leaking error text, irrevocable sessions, CSRF on one wall. |
| Booking functionality | **74** | Double booking structurally prevented; consent, holds, payments, refunds, change requests. Lost points: the reschedule bug, no guest notifications, manual expiry, no lost-reference path, villa's rates not editable in the app. |
| Chatbot functionality | **68** | Grounded, read-only, tenant-scoped, prices from the tool, refusal by default. Lost points: no timeouts or output cap, unmeasured since 2026-10-16, no figure check, no human hand-off. |
| Admin dashboard | **74** | Broad coverage (confirm/decline/cancel, proofs, refunds, rooms, holidays, promos, slots, dashboard, conversations, activity log, roles). Lost points: no stay editing, no export, no check-in/no-show, whole-resort rates missing. |
| UX/UI | **66** | Careful foundations and wording. Lost points: phone review step, price far from controls, terms after Send, no notifications, a11y gaps in the chat, touch targets. |
| Data privacy | **45** | Consent recorded, DPA gate, retention tool, minimal push payloads, OpenAI disclosed. Lost points: placeholder legal texts, retention not scheduled, no DSR procedure, chat text in logs, partial erasure, no cross-border disclosure. |
| Performance | **65** (not measured) | Region pinned next to the database, embedding cache, per-request caching, capped tool ranges. No load test, no latency figures on the deploy, unbounded OpenAI calls; `book/quote` can run 70 price calls per request. |
| Testing | **50** | 55 offline unit files (about 810 tests); a 243-check database suite; 57 rooms checks; many walks. Lost points: `master` red, no CI, the battery and isolation suites blocked, verify 241/243 on dated fixtures, no E2E in CI, missing negative unit tests. |
| Deployment readiness | **25** | Process written (release-process.md) but not built: no CI, no tags, no separate production database, no migration ledger, no cron, no monitoring, no health check, legal placeholders, dashboards unconfirmed. |

**Overall: about 61 / 100. Partially ready.** The product logic is closer to ready than the score suggests. The score is held down by the operational and legal layers, which are where a first live incident or complaint would come from.

The P0 list is mostly small changes; the large items are email, the production database setup, and the lawyer.

---

## Not verified (needs a person)

- **Supabase:**
  - plan, PITR and backups, a restore drill;
  - Auth settings (signups, SMTP, MFA, leaked-password protection, the redirect allowlist);
  - bucket privacy;
  - which SQL files have run in each environment, including file 46.
- **Vercel:**
  - the region;
  - environment variables (no service key);
  - whether `X-Forwarded-For` is overwritten as expected (send a forged header and read `rate_windows`).
- **OpenAI:** spend cap and alerts.
- **GitHub:** repository visibility; whether `plan/` screenshots show guest data.
- **Real devices:** the booking Review step and receipt on a phone; staff screens at phone width; chat autofocus on iOS and Android; dark-mode contrast.
- **Load:** behaviour under concurrent guests and a traffic spike (no load test exists).
