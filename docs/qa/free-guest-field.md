# QA — free-guest-field: the platform form's "Children stay free up to age" field, on screen

- **Idea:** `free-guest-field` (short lane: gates 6, 7 qa, 8 release; security and legal not asked for: no code changed).
- **By:** Quinn (QA), 2026-10-28. Task T-004 (from Finn); Finn's notes M-006.
- **Under test:** gate 6's entry, whats-done.md "2026-10-28 · Free guests: the platform form's field seen on screen (D-147, short lane free-guest-field)". The deliverable is a WALK (`plan/free-guests-platform-walk.mjs`) and five shots; no file under `apps/` or `packages/` changed (`git status`: no entry under either).
- **Requirement source:** plan/free-guests.md § 3.1 item 2 (the config check: 0–17 whole), § 3.3 (the platform field: number, 0–17, empty = nobody, written to `config.free_up_to_age`), § 3.4 a11y line (native labelled number input, 375 check), § 4 Phase 3 ("set, read back, refused"); D-147 (CLAUDE.md: "absent = nobody is free"); D-142 (native controls).
- **Environment:** `pnpm dev` at http://localhost:3000 (build `e1a41db+ · 2026-10-27`), the shared Supabase project, headless Chrome over CDP (`plan/ui-refresh-cdp.mjs`). Every browser run on a THROWAWAY super user and tenant (DPA signed, bookings on), removed by id at the end. **No OpenAI money spent** (the tool in the 7-check walk runs through `executeTool()`, never the model).

## 1. Strategy

1. Re-run Finn's on-screen walk as delivered (independent reproduction of 4/4).
2. Re-run the D-147 HTTP + browser walk (7 checks) as regression for the whole feature the field drives.
3. Write and run a QA edge walk for what Finn's walk did not cover (M-006 item 3): both bounds (0, 17), a decimal (3.5), a negative (-1), clearing the field (does the key leave the config?), dark mode, and axe over the Applications tab.
4. Regression suites: `pnpm test`, `pnpm typecheck`, `pnpm --filter @rag/db verify`, `pnpm --filter @rag/bookings rooms`.
5. Read the shots by eye.

## 2. Traceability — requirement → test → result

| Req | What it asks | Test | Result |
|---|---|---|---|
| § 3.3 field exists, label, 0–17 | "Children stay free up to age", number, min 0 max 17 | platform walk 1; edges E6 (375 dark) | EXECUTED · PASS |
| § 3.3 empty = nobody | empty field shows "none"; saving empty leaves the key OUT of the config | platform walk 1 (empty, placeholder "none"); edges E5 | EXECUTED · PASS |
| § 3.3 written to `config.free_up_to_age` | a saved value is on the row and reads back on a fresh page | platform walk 2 (3); edges E1 (0), E2 (17) | EXECUTED · PASS |
| § 3.1 item 2 / § 4 Phase 3 "refused" — above range | 18 refused in the trigger's words | platform walk 3 (native: 0 PUTs; forced: toast "config.free_up_to_age is a whole number of years from 0 to 17"); 7-check walk 1 (HTTP 400, same words) | EXECUTED · PASS |
| § 3.1 item 2 — whole number ("3.5" refused) | a decimal refused | edges E3 (native stepMismatch, 0 PUTs; forced with step="any": 1 PUT, the same words, record unchanged) | EXECUTED · PASS |
| § 3.1 item 2 — from 0 | a negative refused | edges E4 (native rangeUnderflow, 0 PUTs; forced: 1 PUT, the same words, record unchanged) | EXECUTED · PASS |
| § 3.4 a11y / D-142 | native labelled number input; fits at 375; 0 axe violations | platform walk 4 (309 px, right 342 of 375); edges E6 (axe light 1280, dark 1280, dark 375: 0, 0, 0) | EXECUTED · PASS |
| Dark mode (conventions, D-101) | field legible in dark | edges E6 (text rgb(236,236,239) on rgb(24,24,27)); `qa-free-dark-1280.png`, `-375.png` | EXECUTED · PASS |
| D-147 downstream (the field's effect) | setup route, quote unchanged by free, booking page, S-15, list, Manage booking, tool note, restore | free-guests-walk.mjs 2–7 | EXECUTED · PASS |
| verify 89b / 103 (SQL shape of `p_free` and `free_up_to_age`) | the config check in SQL | `pnpm --filter @rag/db verify` | EXECUTED · PASS (run 3, 243/243; runs 1–2 network flakes, § 3) |
| rooms 24b (free guests priced as paying count) | quote and row agree | `pnpm --filter @rag/bookings rooms` | EXECUTED · PASS (57/57) |

## 3. Execution results (EXECUTED, with the output)

All commands from the repo root unless `packages/db` is shown.

1. **`(cd packages/db && node --conditions=react-server --env-file=../../.env ../../plan/free-guests-platform-walk.mjs)`** — EXECUTED, **4/4 PASS**:
   ```
   PASS  1. 1280: … {"label":"Children stay free up to age","value":"","placeholder":"none","min":"0","max":"17",…,"width":678,"right":1115,"vw":1280}
   PASS  2. … toasts ["ok: Bookings config saved."] · stored 3 · shown "3"
   PASS  3. … validity {"value":"18","overflow":true,"message":"Value must be less than or equal to 17.","invalid":true} · PUTs 0 then 1 · toasts ["error: config.free_up_to_age is a whole number of years from 0 to 17"] · stored 3
   PASS  4. 375: … "value":"3",…,"width":309,"right":342,"vw":375}
   free-guests platform walk: all passed
   ```
2. **`(cd packages/db && node --conditions=react-server --env-file=../../.env ../../plan/free-guests-walk.mjs)`** — EXECUTED, **7/7 PASS**:
   ```
   PASS  1. platform: … 18 → 400 "config.free_up_to_age is a whole number of years from 0 to 17" · 3 → 200, stored 3
   PASS  2. … setup 3 · 1600000 vs 1600000 · free 1 / 0 · 51 → 400 "Free guests must be a whole number from 0 to 50."
   PASS  3. … label "Children aged 3 and below" · hint "Children aged 3 and below stay free. Enter them apart from the guests."
   PASS  4. … VIL-F4QC4A · listed 4+1 total 1600000 (quote 1600000) · head "Whole property · 4 guests + 1 child (free) · Overnight"
   PASS  5. … request 201 VIL-DQVD9U lines free 2 · lookup 200 rooms [{"unit":"Whole property","slot":"Overnight","guests":2,"free":2}]
   PASS  6. … {"rule":"Children aged 3 and below stay free.", …}
   PASS  7. … restore ok · tool null · setup null
   free-guests walk: all 7 passed
   ```
3. **`(cd packages/db && node --conditions=react-server --env-file=../../.env ../../plan/free-guests-platform-edges-walk.mjs)`** — NEW (written by QA), EXECUTED twice.
   - Run 1: 5/6, **E3 FAILED — a defect in the TEST, not the product**: the bypass removed `step`, but a number input with no `step` attribute still steps by 1, so the browser kept refusing 3.5 (`PUTs 0 then 0`). The native half had passed (`"step":true`, "Please enter a valid value. The two nearest valid values are 3 and 4."). Fixed the bypass to `step="any"`.
   - Run 2: **6/6 PASS**:
   ```
   PASS  E1. 0 saves, the record holds 0, a fresh page shows 0  — toasts ["ok: Bookings config saved."] · stored 0 · shown "0"
   PASS  E2. 17 saves, the record holds 17, a fresh page shows 17  — … stored 17 · shown "17"
   PASS  E3. 3.5: … validity {"value":"3.5",…,"step":true,…,"invalid":true,…} · PUTs 0 then 1 · toasts ["error: config.free_up_to_age is a whole number of years from 0 to 17"] · stored 17
   PASS  E4. -1: … validity {"value":"-1","under":true,…,"message":"Value must be greater than or equal to 0."} · PUTs 0 then 1 · toasts ["error: config.free_up_to_age is a whole number of years from 0 to 17"] · stored 17
   PASS  E5. cleared and saved: … config {"timezone":"Asia/Manila","max_stay_nights":7} · shown ""
   PASS  E6. dark mode: … {"value":"3","color":"rgb(236, 236, 239)","background":"rgb(24, 24, 27)",…} · light 1280: 0 · dark 1280: 0 · dark 375: 0
   after: 0 tenants left by the free-platform-qa- prefix
   free-guests platform edges walk: all passed
   ```
   Shots: `plan/free-guests/qa-free-decimal-native-1280.png`, `qa-free-negative-native-1280.png`, `qa-free-cleared-1280.png`, `qa-free-dark-1280.png`, `qa-free-dark-375.png`.
4. **`pnpm test`** — EXECUTED, exit 0: chunker 13, openai 20, db 5, push 10, bookings 137, pipeline 376, web 243 = **804 passed, 0 failed** (64 files).
5. **`pnpm typecheck`** — EXECUTED, exit 0: 13/13 tasks (the service-import check first).
6. **`pnpm --filter @rag/db verify`** — EXECUTED three times:
   - Run 1: **242 PASS, 1 FAILED**: `FAIL  a chunk cannot belong to another tenant's document — TypeError: fetch failed` (the network to Supabase, not an assertion).
   - Run 2: **FAILED, 1 check**: `FAIL  conversations: probe setup — create user: fetch failed` (238 PASS; the probe's dependent checks did not run). Check 13, which had failed in run 1, PASSED: `23503 … violates foreign key constraint "chunks_document_tenant_fk"`.
   - Run 3: **243/243 PASS**, exit 0, "OK — the database layer is wired correctly."; "audit: swept 22 system row(s)". The D-147 lines: `PASS roles: max_stay_nights, max_advance_days and free_up_to_age (D-147) validated by the trigger — 7 refused · 7 / 90 / 3 accepted · 0 accepted`; `PASS request_booking: p_free stored and returned, priced as if absent; 51 and a mismatched list refused (22023)`.
   - Reading: two transient `fetch failed` at two different checks, each passing on the next run, are the network and not this idea. They are recorded as a flake risk, not hidden (§ 6).
7. **`pnpm --filter @rag/bookings rooms`** — EXECUTED, **57/57 PASS**, exit 0, "ALL ROOMS CHECKS PASS".

### NOT RUN, and why

| Suite | Why |
|---|---|
| `pnpm eval` (the battery) | needs northwind and harbor, hard-deleted 2026-10-20; also money (Rule 7), not asked. No prompt or tool text changed. |
| `pnpm --filter @rag/pipeline isolation` (both ways) | needs northwind and harbor (deleted 2026-10-20). No query changed. |
| `pnpm --filter @rag/bookings isolation` (both ways) | needs harbor (deleted 2026-10-20). No query changed. |
| prompt-snapshot / tool baselines diff | no file under `packages/` changed; not re-diffed. |
| `plan/ui-refresh-a11y.mjs` (160 states) | no screen code changed; E6's axe covered the Applications tab in light and dark (0). |
| Real (painted) native validation bubble | headless Chrome does not paint it (Finn's M-006 item 2); its TEXT was read through `validationMessage` (E3, E4, walk 3). A headed check by a person remains. |

## 4. Defects

| Id | Severity | What | Steps | Routed |
|---|---|---|---|---|
| D-1 | LOW (record wording) | The record says the field is on the platform form's "Bookings tab"; there is no such tab: it is the **Applications** tab, Bookings card, Limits section. | /platform as a super user → a tenant → tabs read Profile / Applications / Members / …; the field `#bk-free` is under Applications. Wrong text at CLAUDE.md:400, decisions.md:4722 (D-147), plan/free-guests.md:39 and :182. | T-005 to Finn. Not blocking. |

Observations, not defects against this idea's requirements:
- At 375 the platform top bar's breadcrumb truncates to "Tenants › F" (D-119's bar; Finn saw it too, M-006 item 5). Seen again in `qa-free-dark-375.png`.
- The server's refusal names the config key ("config.free_up_to_age is a whole number …"). On a super-user screen this is acceptable and matches § 3.1's "the message names both"; the native control means a real user reaches it only by bypassing the browser.

## 5. Regression

No production code changed for this idea. The regression run above (804 unit tests, typecheck, verify, rooms, the 7-check D-147 walk) is what stands; the three NOT RUN suites are not runnable without the deleted tenants, and none touches a file this idea changed.

## 6. Verdicts

- **Gate 7, qa: PASS.** Every § 3.3 / § 3.1-item-2 behaviour of the field was executed on screen with evidence; the one failure was in QA's own test and was fixed and re-run; the one defect is a LOW record wording, filed.
- **Gate 8, release: READY WITH DOCUMENTED RISKS.** The risks: (1) `pnpm eval` and both isolation suites NOT RUN (northwind and harbor deleted; no code changed, so the exposure is nil for this idea); (2) the painted validation bubble not seen by a person; (3) D-1's wording open on Finn's board; (4) verify took three runs to reach 243/243: two transient `fetch failed` at different checks (network to Supabase), each passing on re-run. Short lane: no security or legal gate was asked, and none is open. Not committed; the user commits and marks it released.
