# QA: deps-upgrade, next 15.5.28 · sharp 0.35.5 · zod 4.6.7

- **Idea:** `deps-upgrade` (short lane: implementation, qa, security asked for by Finn as T-016, release).
- **By:** Quinn (QA), 2026-10-28. Task T-015 (from Finn), with Finn's notes in M-025.
- **Under test:** gate 6's entry, whats-done.md "2026-10-28 · Dependencies upgraded: next 15.5.28, sharp 0.35.5, zod 4.6.7 (T-013, deps-upgrade; D-022 amended, R-64)". The code that changed is `apps/web/package.json`, `pnpm-lock.yaml`, `apps/web/lib/schemas.ts` (zod 3 → 4 API, `v3Words`, five list caps) and `apps/web/lib/schemas.test.ts` (+6 tests). On branch `fix/deps-upgrade`. Nothing is committed.
- **Requirement source:** the user's ask, quoted in the entry: bump next to ≥ 15.5.28 (GHSA-2464-fhr4-w9xw), sharp past GHSA-wq5f-xc86-pv6w and zod past GHSA-mrhx-c7xc-m3w5, on the same major unless a fix needs more. D-022 as amended says every route answers in the words it answered before. T-015 lists four browser items.
- **Environment:** the user's `pnpm dev` at http://localhost:3000. Its log (`plan/ai-employees/deps-upgrade/dev.log`) reads "▲ Next.js 15.5.28". Installed in `apps/web/node_modules`: sharp **0.35.5**, zod **4.6.7**. The database is the shared Supabase project. I did not start, stop or build the dev server (trap 16). **No OpenAI money was spent:** no eval, no chat, no voice route. `free-guests-walk` check 6 runs the tool through `executeTool()`, which never calls the model.

## 1. Strategy

1. **Regression on the CLI.** Re-run what decides a framework bump, uncached: `pnpm test --force`, `pnpm typecheck --force`, `verify`, `rooms` and `pnpm audit --prod`.
2. **The zod 3 → 4 contract over HTTP.** I wrote a QA walk, `plan/deps-upgrade-walk.mjs`. Its oracle is the zod 3 schema file at HEAD (`git show HEAD:apps/web/lib/schemas.ts`).
   - Each probe gets exactly one field wrong, because a route answers only `firstError()`, the first issue.
   - Each probe must come back 400 with HEAD's sentence: the `required_error`, `invalid_type_error`, `errorMap`, `.min` or `.max` text, or zod 3's default wording.
   - It covers the booking page's quote and request routes on villa (whole_resort) and alteza (per_room), and the platform's create, Profile, Applications and Permissions routes.
   - Every refusal has a positive twin (trap 12).
3. **The advisory fix itself.** 100,000 empty `rooms` against the open quote route must be refused at the cap, in the cap's words, quickly.
4. **sharp.** `app-icon.png` at 180, 192, 512 and 999 on both tenants. Only alteza has a logo, so only alteza takes the sharp branch, which sets `X-App-Icon-Tile`. A grep finds no other `sharp` import, and no `next/image` is in use.
5. **next 15.5.28 page by page.** Every public page, a staff login, every admin page for an owner, and the 404s that must stay 404s. The existing walks that need no OpenAI and no deleted tenant run as written.
6. Read the dev server's log for anything other than the walks' expected refusals.

## 2. Traceability: requirement → test → result

| Req | What it asks | Test | Result |
|---|---|---|---|
| next ≥ 15.5.28 | the critical GHSA-2464-fhr4-w9xw closed | dev.log "▲ Next.js 15.5.28"; `pnpm audit --prod` | EXECUTED · PASS (audit 5, 0 critical) |
| sharp ≥ 0.35.5 | GHSA-wq5f-xc86-pv6w closed; the icon still drawn | installed 0.35.5; deps walk D; icons by curl | EXECUTED · PASS |
| zod past GHSA-mrhx-c7xc-m3w5 | the patched range is ≥ 4.6.6 (a major, said so in the entry) | installed 4.6.7; deps walk A (100,000 rooms) | EXECUTED · PASS |
| D-022 amended: the same words | each route's refusal reads as before | deps walk A (14 probes × 2 tenants, the 100,000-room one included), B (6), C (22): 56 refusals in words | EXECUTED · PASS |
| The caps | an over-cap list refused before parsing, in the package's words | deps walk A "11 rooms", "100,000 rooms" (337–357 ms); schemas.test.ts (100,000 elements, 1 issue) | EXECUTED · PASS |
| T-015 (1) | villa and alteza book: quote, request, missing-field words | deps walk A, B; customer-booking-phase3-walk (10); free-guests-walk 5 (a real villa request) | EXECUTED · PASS. An alteza request: **NOT RUN** (§ 4) |
| T-015 (2) | the platform saves Profile (welcome line, suggested questions), Applications → Bookings card, Permissions, with the same refusal words | deps walk C; welcome-text-walk (4); free-guests-walk 1; tenant-management-phase4-walk (13) | EXECUTED · PASS, over HTTP. On screen: NOT RUN (§ 4) |
| T-015 (3) | app-icon 192 and 512; a room photo upload on S-5 | deps walk D; curl ×8; booking-types-phase3-walk "photo: uploaded and served…" and "photo: reordered…" | EXECUTED · PASS |
| T-015 (4) | a staff login and one admin page per section | deps walk E (login, 13 villa admin pages, S-5 404 on villa and 200 on alteza, log out); page-pending-walk (5, browser) | EXECUTED · PASS |
| No regression elsewhere | the suites | test 810, typecheck 13/13, verify 243, rooms 57, manage-booking-phase3 (6) | EXECUTED · PASS |

## 3. Execution results (EXECUTED, with the output)

Commands run from the repo root; the walks run from `packages/db` with `node --conditions=react-server --env-file=../../.env ../../plan/<walk>.mjs`.

1. **`pnpm test --force`**: EXECUTED, **13/13 tasks, 0 cached, 810 tests**:
   ```
   @rag/chunker 13 · @rag/push 10 · @rag/db 5 · @rag/openai 20 · @rag/bookings 137 · @rag/pipeline 376 · web 249 (29 files)
   Tasks: 13 successful, 13 total · Cached: 0 cached, 13 total
   ```
   These are Finn's "after" numbers exactly: web 243 → 249 with his six new tests. The `test` task depends on `^build`, which builds the packages only and never runs `next build` while dev is up.
2. **`pnpm typecheck --force`**: EXECUTED, **13/13**, "check-service-imports: OK — no @rag/db/service import under apps/ or packages/*/src (7 roots)."
3. **`pnpm --filter @rag/db verify`**: EXECUTED, **243/243 on the first run**, "OK — the database layer is wired correctly.", exit 0. The `fetch failed` flake that Finn saw did not appear in this run.
4. **`pnpm --filter @rag/bookings rooms`**: EXECUTED, **57/57 on the first run**, "ALL ROOMS CHECKS PASS", exit 0.
5. **`pnpm audit --prod`**: EXECUTED, "5 vulnerabilities found · Severity: 2 moderate | 3 high". This matches R-64: all five are in `next > postcss` 8.4.31 or `source-map-js` 1.2.1, and none is critical. The count before the bump was 11 (1 critical, 6 high, 4 moderate).
6. **App icon by curl** (`/t/<slug>/app-icon.png?size=…`): EXECUTED, **8/8 are 200 image/png of the right size**:
   ```
   villa  180 → 180×180 1957 B · 192 → 192×192 2108 B · 512 → 512×512 6395 B · 999 → 512×512 (clamped)
   alteza 180 → 180×180 15202 B · 192 → 192×192 16834 B · 512 → 512×512 104385 B · 999 → 512×512
   alteza: x-app-icon-tile: #2d3223 for a logo of #eae2c0   (the sharp branch; villa has no logo: next/og)
   ```
   The log has no `[app-icon] … could not be drawn` line, so sharp did not fall back to the initial.
7. **`plan/deps-upgrade-walk.mjs`** (new, QA's): EXECUTED twice. Run 1 had sections A–D: 71/71. Run 2 added E: **101/101**, "deps-upgrade walk: all 101 passed", exit 0. Excerpts:
   ```
   PASS  A villa: a valid quote is a 200 with lines  — 200 available true total 1600000 lines 1
   PASS  A villa: unknown keys (extra, price) are stripped, as in zod 3: same 200 and total  — 200 total 1600000
   PASS  A villa: checkIn missing → 400 "Choose a date"  — 400 "Choose a date"
   PASS  A villa: 100,000 empty rooms → 400 in the cap's words, under 3 s (GHSA-mrhx-c7xc-m3w5)  — 400 "One request holds at most 10 rooms." in 357 ms
   PASS  A alteza: a valid quote is a 200 with lines  — 200 available true total 480000 lines 1
   PASS  A alteza: 100,000 empty rooms → …  — 400 "One request holds at most 10 rooms." in 337 ms
   PASS  A alteza: a body that is not JSON → 400  — 400 "Expected object, received null"
   PASS  B villa request: consent false → 400 "Please read and agree to the Privacy Policy and Terms."
   PASS  C Profile PATCH: an unknown key → 400 "Unrecognized key(s) in object: 'extra'"
   PASS  C Profile PATCH: a number as a question → 400 "Expected string, received number"
   PASS  C Profile PATCH: chat retention 30.5 → 400 "Expected integer, received float"
   PASS  C Profile PATCH: two suggested questions saved, trimmed, read back by tenant_public() (twin)  — 200 ["Do you have parking?","Is breakfast included?"]
   PASS  C Applications PUT: a valid shape reaches Postgres, whose DPA gate answers in words  — 400 "Record the signed data processing agreement first (the Legal tab), then switch bookings on."
   PASS  C Applications PUT: with the DPA signed, the Bookings card saves and reads back (twin)  — dpa 200 · put 200 {"timezone":"Asia/Manila","max_stay_nights":5}
   PASS  C Permissions PUT: a fixed permission → 400 "That permission cannot be changed per tenant"
   PASS  C Permissions PUT: one valid row saved and stored (twin)  — 200 stored [{"role":"staff","permission":"documents:read","allowed":false}]
   PASS  D alteza app-icon ?size=192: a 192×192 PNG drawn by sharp (X-App-Icon-Tile present)
   PASS  E public /, /platform, /t/villa, /book, /manage, /privacy, /terms, /t/alteza/book, manifest, sw.js → 200; /t/no-such-tenant-x → 404
   PASS  E villa: /admin/dashboard … /admin/activity → 200 (13 pages); /admin/accommodations → 404
   PASS  E alteza: /admin/accommodations → 200
   ```
   Each probe's expected words are HEAD's zod 3 strings. The three default-wording cases ("Expected object, received null", "Expected string, received number" and "Expected integer, received float") are zod 3's own defaults, and `v3Words` reproduces them. Cleanup is by the ids the run made (trap 26): the throwaway tenant, the super user, two owners, their memberships and their audit rows. Afterwards, no `deps-walk-%` tenant remains.
8. **`page-pending-walk.mjs`**: EXECUTED, **5/5**, "ALL PAGE PENDING WALK CHECKS PASS". This is a browser run of a staff login and the D-149 frame on next 15.5.28.
9. **`free-guests-walk.mjs`**: EXECUTED, **7/7**. It covers the platform Applications route, the quote, the booking page at 375, a staff stay, a real villa web request with Manage booking, and the tool note. Villa's config was restored afterwards (`{"timezone":"Asia/Manila"}`, read after the run).
10. **`welcome-text-walk.mjs`**: EXECUTED, **4/4**: the Profile welcome line through the platform route, tenant_public(), the chat at 375, and the audit row.
11. **`customer-booking-phase3-walk.mjs`**: EXECUTED, **10/10**, "ALL PHASE 3 WALK CHECKS PASS".
12. **`tenant-management-phase4-walk.mjs`**: EXECUTED, **13/13**, "ALL PHASE 4 WALK CHECKS PASS".
13. **`manage-booking-phase3-walk.mjs`**: EXECUTED, **6/6**. The proof upload route on next 15.5.28 works: the bytes decide the type, a 6 MiB file and HTML are refused in words, and the idempotency key holds.
14. **`booking-types-phase3-walk.mjs`**: EXECUTED, **6 PASS, 5 FAIL**, exit 1. **This is not a defect of this change.**
    - The five failing checks send request shapes that the staff routes stopped taking before this bump: `date`, `unitId` / `guestCount` and `guestName`. D-073 replaced them with `checkIn` + `nights` and D-111 with `rooms[]`, `name`, `phone` and `email`.
    - HEAD's zod 3 schema has none of those keys (`git show HEAD:apps/web/lib/schemas.ts | grep "date:\|guestName\|guestCount"` prints nothing), so the same bodies were 400s before the bump too.
    - The walk was last edited at tenant-management Phase 1 (`8b9925b`), and its last recorded run is whats-done.md:5293 (10/10, booking types).
    - **Its six passing checks are the ones this task needed:** S-5 photo upload (201, served 200; an SVG named .png, 3 MB and another tenant's room refused), reorder, removal with its object (objects 0), retire, and the 401s.
    - A stale test asset is mine to fix, under the § 6 follow-up.
15. **The dev server's log** across every run above: 0 `⨯`, 0 unhandled errors, 0 `[app-icon]` fallbacks. Every `[error]` line is a refusal the walks asked for, for example "Enter a mobile number like 0917 123 4567." ×11 and "Admin login required for …" ×14.

## 4. NOT RUN, and why

| What | Why |
|---|---|
| `pnpm eval`, `prompt-snapshot`, harbor's tool text | They need northwind and harbor, which were hard-deleted on 2026-10-20 and not rebuilt (the user declined). Rule 7: no OpenAI money. `git status -- packages/` is empty, so no prompt or tool source changed and eval is not owed. |
| `pnpm --filter @rag/pipeline isolation` and `@rag/bookings isolation`, both ways | They need northwind and harbor (deleted). Also, no query changed. |
| `nav-layout-walk.mjs` | Its throwaway OWNER is a member of **harbor** (`.in('slug', ['villa','harbor'])`), which is deleted. Its ground is covered by deps walk E and page-pending-walk. |
| A valid booking request on **alteza** | Alteza has 2 real push devices (`push_subscriptions`), so a request would chime a real phone. The alteza quote and every refusal were run. The request path itself ran on villa (free-guests-walk 5, customer-booking-phase3-walk on its own throwaway per_room tenant). |
| The platform form **in a browser** (typing into Profile, Applications and Permissions and reading the toasts) | Run over HTTP instead, against the same routes and words. The welcome-text walk did draw the chat at 375 in Chrome. The form posts to those routes and shows `firstError()`'s sentence, so the words a person sees are the ones checked. Not looked at by eye. |
| A room photo picked **in the S-5 file field** | The canvas resize is browser code that this bump did not touch, and sharp is not on that path. The upload route was run (#14). |
| axe passes (`*-a11y.mjs`) | No markup, CSS or component changed in this bump. |
| Voice routes, chat walks, `room-cards-check` | Rule 7 (OpenAI). |
| `pnpm build` | Not allowed beside a running dev server (trap 16). Finn's build is recorded: "Compiled successfully", Rule 2's grep 0 lines. |

## 5. FAILED

None attributable to the change. `booking-types-phase3-walk` has 5 FAILs, which are the walk's stale request shapes and pre-date the bump (§ 3 #14).

## 6. Defects and follow-ups

- **No defect found in deps-upgrade.** No task for Finn.
- **Follow-up (QA's own asset, low):** `plan/booking-types-phase3-walk.mjs` checks 3, 5, 6, 7 and 11 still send the pre-D-073/D-111 bodies. Rewrite them to `checkIn`/`nights`/`rooms[]`/`name`/`phone`/`email`. Until that is done, the walk is red for a reason unrelated to the code under test.
- **Seen, not mine:** a tenant `free-walk-e5384b` (id 2148, created 2026-10-26T11:42Z) is left over from an earlier free-guests walk run. It is not from this session. Left untouched.
- **Seen, from Finn's M-025 (a):** no screen printed more than one validation message. Every route returns `firstError()` alone, and every probe here got exactly HEAD's first sentence.

## 7. Regression

All earlier green suites stay green, with the same counts as Finn's "after" run: test 810, typecheck 13/13, verify 243, rooms 57. Five existing walks (page-pending, free-guests, welcome-text, customer-booking-phase3, tenant-management-phase4, 39 checks) and manage-booking-phase3 (6) pass on next 15.5.28.

## 8. Remaining risks

- **R-64:** `pnpm audit --prod` still reports **3 high and 2 moderate** advisories, all in postcss 8.4.31 and source-map-js 1.2.1, which next 15.5.28 pins. Finn assessed them as build-time only. **Sage's security review (T-016) has not written its gate**, and the user has not accepted the three highs in writing on the pipeline.
- `v3Words` reproduces zod 3's *first* message. 701 of Finn's 32,673 corpus inputs differ after the first issue (zod 4 adds a length issue to a value whose type already failed). No reader shows more than the first issue today. A future screen that lists every issue would show the zod 4 extras.
- The live app on Vercel runs 15.5.25 until the user commits and deploys.

## 9. Verdicts

- **Gate 7, qa: PASS.**
  - Every executed suite and walk that tests this change passed, with the counts above.
  - The zod 4 refusals read word for word as HEAD's zod 3: 56 refusal probes over two tenants and the platform.
  - The advisory's case is refused at the cap in about 0.35 s.
  - sharp draws the icon.
  - next 15.5.28 serves every public and admin page, keeps its 404s, and logs nothing unexpected.
- **Gate 8, release: NOT WRITTEN YET.**
  - My charter puts release after security and legal have written theirs. Security was asked for (T-016, Sage) and has not answered.
  - Release also needs the user's written acceptance of R-64's three remaining HIGH advisories on the pipeline, or Sage's word that they are not findings for this release.
  - Once those exist, my recommendation from QA's side is **READY WITH DOCUMENTED RISKS**: R-64, and the § 4 browser items not looked at by eye.
