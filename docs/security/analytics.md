# Security review: plan/analytics.md (gate 5, architecture)

> **Round 2 (T-012, 2026-10-28): CLEAR.** No MEDIUM or higher finding is
> open. S-A1 and S-A5 are RESOLVED. S-A2, S-A3 and S-A4 are PARTLY resolved,
> and what is left of each is LOW. There are five new findings: one LOW and
> four INFORMATIONAL. See [Round 2](#round-2-2026-10-28-t-012) at the end.
> Round 1 follows unchanged.

> Sage, Security Reviewer, 2026-10-28. Task T-011 from Theo.
> **Verdict: CONCERNS.** The plan has no CRITICAL or HIGH finding. It has
> three MEDIUM, four LOW and four INFORMATIONAL findings. None blocks the plan's
> shape. The three MEDIUM findings should be folded into the plan before
> Phase 3 or Phase 5 is built.
> **Status of the thing reviewed:** Planned. Nothing is built, so this reviews
> a design against today's code. It is not an implementation review, and the
> gate-7 review happens after Phase 6.
> **Spent:** nothing (Rule 7). There was no OpenAI call, no dev server, no
> browser and no database query.

---

## Scope, method and limits

**Read:**
- `plan/analytics.md`, all of it.
- R-55, R-61 and R-63 in `risks.md`.
- Against the plan's claims:
  - `apps/web/next.config.mjs` (no `headers()`, no middleware today: R-55 confirmed);
  - `components/tenant-nav.tsx`, `public-footer.tsx`, `proof-viewer.tsx`, `booking-page.tsx:362`, `chat-screen.tsx`, `voice.tsx`;
  - `lib/service-worker.ts`, `lib/branding.ts`, `app/t/[tenant]/layout.tsx`;
  - `packages/bookings/src/payment-review.ts:174`;
  - `sql/schema-features.sql:54-60`, `schema-roles.sql:165-187`, `schema-assistant-avatar.sql:18`.
- Grepped `apps/web` for `<Link`, `router.push`, `replaceState`, `<iframe`, `dangerouslySetInnerHTML`, `next/image` and every direct call to a Supabase or foreign host from the browser. There are none: every upload goes through our own API.

**Ran:** `pnpm audit` and `pnpm audit --prod --json`. Those are the only commands that touched anything beyond reading.

**Not done:**
- No Google document was read, as in the plan itself (R-63). Every GA4 behaviour below is **[unverified]**, exactly as in the plan.
- No live database read. The Supabase server is not authorised in this session. So the live `logo_url` / `banner_url` / `assistant_avatar_url` hosts (S-A6) are unknown.
- No browser was run, so no CSP was measured.
- I did not run the `security-review` skill. I do not have the Skill tool.

**Assumptions:**
- Properties live in the operator's GA account (the plan's § 7 q1 recommendation).
- The app is served from one host, with tenants on paths.
- Next's App Router without a nonce needs `'unsafe-inline'` scripts, as the plan states.

This review does not say the design is secure. It says what was checked and what was found.

## The house's walls, re-checked against the plan

| Wall | Plan | Finding |
|---|---|---|
| No request holds a key that bypasses RLS (rule 2) | No new route. The platform PATCH stays on `withPlatformRoute()`. No definer, no policy, no `service_role` | Holds |
| Two walls, each tested alone (rule 6, D-038) | Wall 2: `tenant_public()` returns `analytics_id` null while off (verify 247 with its positive twin). Wall 1: the page passes no prop while off (a unit test) | Holds. The measurement ID is public by nature, so the walls guard *loading*, not a secret. That is the right thing to guard. The isolation suites cannot run (northwind and harbor were deleted), but this plan adds no tenant-scoped query, so nothing they would cover moves |
| Who can switch it on | `tenant_features` write is super only (`schema-features.sql:58`). `tenants_super_all` (`schema-roles.sql:185`) is what lets the step-4 invoker trigger bump `policy_version` under the super token | Holds. Verify 249 should also try an anon key, not only staff and chat tokens |
| A tool result carries nothing a visitor may not see (rule 7) | Prompt and tools untouched | Holds |
| The token signer mints one shape (rule 8) | Untouched | Holds |
| The `.next/static` grep | In Phase 6 | Holds. Add `G-` IDs to nothing: they are public |
| Rate limits (D-137), the private `payment-proofs` bucket (D-107), the audit log by Postgres alone (D-138) | No new open route. Proofs untouched. `audit_row()` gains `analytics_id` in `v_keep` | Hold. The proof VIEWER does not: see S-A1 |

## Findings

### S-A1 · MEDIUM · The base CSP breaks viewing a PDF proof of payment on S-13 and on staff review

- **Evidence:**
  - `components/proof-viewer.tsx:59` draws a PDF in `<iframe src={src}>`. `src` is a `blob:` URL on S-13 (the file the guest picked) or a 5-minute signed Supabase URL in the staff review drawer (`packages/bookings/src/payment-review.ts:174`).
  - The plan's base CSP (§ 4.7) has no `frame-src` or `child-src`, so `default-src 'self'` governs frames. That refuses both `blob:` and the Supabase origin.
  - Phase 5's walk opens *pages*. It never opens a PDF proof, so it would report 0 violations and miss this.
- **Impact:**
  - Staff cannot see a PDF proof before verifying a payment (D-107).
  - A guest's PDF preview on S-13, a measured page, is blank.
  - Under deploy pressure the likely "fix" is a broad loosening, such as `frame-src *` or dropping the CSP.
- **Remediation:**
  - Add `frame-src 'self' blob: <SUPABASE_URL origin>` to the base policy. It belongs in the base policy because S-14 and S-15 are staff pages.
  - Add `/t/villa/manage` with a PDF chosen, and the review drawer with a PDF proof, to `securityHeaders()`' table test and to Phase 5's walk.
  - Confirm in that run that Supabase's Storage response itself allows being framed.
- **Verification:** the Phase 5 walk opens a PDF proof on S-13 and on S-15's review drawer, with 0 `securitypolicyviolation` events and the frame drawn.

### S-A2 · MEDIUM · The wall between gtag.js and staff screens is two hand-edited links. The CSP cannot hold it.

- **Evidence:**
  - § 2.4 states it correctly: a client-side navigation keeps the first document's CSP. A staff screen reached by `<Link>` from S-1, S-6 or S-13 would run with `gtag.js` resident and Google's hosts allowed.
  - Today `public-footer.tsx:25` ("Staff login") and `tenant-nav.tsx:92` (`staffHome`, shown on a guest page when the visitor is signed in) are both `<Link>`. The plan converts these two.
  - But the guarantee is "no `<Link>` from any page reachable by `<Link>` from a measured page leads into `/admin`". That set includes the privacy and terms pages, which draw the same footer and nav, and every future edit.
  - The proposed test greps two files.
  - `ga-disable-<ID>` stops *hits*, not the script. A resident third-party script in a staff document can read that document's DOM: guest names, phones and emails on S-3 and S-15, and transcripts on S-16.
- **Impact:**
  - One future `<Link>` (or `router.push`) silently puts Google's code in the same document as guest PII on staff screens.
  - Nothing would error, and no hit would be sent to show it.
- **Remediation:**
  - Keep the two `<a>` changes.
  - Add a structural guard that does not depend on link discipline. `StaffFrame` (every staff screen's frame) checks, on mount, whether analytics was loaded in this document (the module's own flag or `window.gtag`). If it was, it calls `location.reload()`, so every staff screen starts a fresh document under the staff CSP.
  - Unit-test the guard. Phase 6 check 11 already asserts the result in a browser.
- **Verification:**
  - Walk check 11, plus a variant: Allow on S-1 → privacy by `<Link>` → Staff login, and the admin document has no `googletagmanager` script.
  - A forced `router.push('/t/villa/admin')` from S-1 in a test page shows the reload.

### S-A3 · MEDIUM · Part of what FR-011, 013 and 014 promise lives in each GA property's settings, outside the code and outside the walk

- **Evidence:**
  - § 1.1 and § 2.3 rest the "no query string, no path leak" guarantees partly on enhanced measurement (history-change page views, site search, form interactions) and user-provided data being OFF in the property (§ 6.2).
  - Those switches are set by hand in Google's UI, by whoever holds Editor on the property.
  - The walk (Phase 6) exercises the *walk* property only, not each tenant's.
  - The query string matters: `booking-page.tsx:362` links S-6 → S-13 as `/t/<slug>/manage?ref=<reference>` with a client-side `<Link>`. A booking reference is one half of S-13's credential (`guest_group()` takes reference + email or phone, D-104).
  - If history-change page views are on and gtag reads `location` for them rather than the `page_location` the module set **[unverified, Phase 0]**, the reference reaches Google.
- **Impact:**
  - One mis-set property, or an owner given Editor, or the q1 alternative where a tenant owns its property, sends guest booking references to Google.
  - Nothing in the app can see it.
- **Remediation:**
  1. q1 as recommended: properties in the operator's account, and owners Viewer only, never Editor. State this as a rule, not a preference.
  2. Phase 0 must answer specifically whether a history-change page view uses the `page_location` set by `config`/`set` or `document.location`.
  3. Record each tenant's checklist in R-61 with the date and who set it, before its switch goes on.
  4. Pass Uma's R-U5 (drop `?ref=` from the URL) to Rhea as a security recommendation, not only a UX one. If adopted, carry the reference in navigation state rather than in the URL. A `replaceState` after load is itself a history event.
- **Verification:**
  - Phase 0's row for history events.
  - Walk check 8 extended: S-6 → `<Link>` → S-13 with `?ref=`, and no intercepted `dl` or `dr` contains the reference.
  - The R-61 checklist is filled per property.

### S-A4 · LOW · Decline does not reliably remove GA's cookies, and expired consent or GPC leaves them in place

- **Evidence:**
  - § 4.3's `clearAnalyticsCookies()` expires cookies on "path `/` and the host".
  - GA's default `cookie_domain` is `auto` **[unverified]**, which on a custom domain sets the cookie on the registrable parent (`.example.com`). A host-only delete does not remove it.
  - The plan clears cookies on an explicit Decline only. A consent that expired, a version bump, or GPC turning on after an earlier Allow all give `decide() = 'none'` or `'ask'`, with the old `ga_<slug>*` cookies still present.
  - GA refreshes cookie expiry on each hit by default (`cookie_update`) **[unverified]**, so 180 days is rolling, not from consent.
- **Impact:** an identifier outlives the choice that permitted it. This is mainly legal (Lex Q3.3), but it is also Rule 6 not doing what it says.
- **Remediation:**
  - Set `cookie_domain: 'none'` **[unverified]** so the cookie is host-only, or delete on every domain GA could have used.
  - Clear this tenant's prefix on every `decide()` result other than `'load'`.
  - Consider `cookie_update: false` **[unverified]**.
- **Verification:** walk checks 5 and 13 read `document.cookie` and the browser's cookie jar (`context.cookies()`) after Decline, after a version bump, and with GPC: no `ga_villa*` cookie remains.

### S-A5 · LOW · The CSP's script wall is weak, and the measured pages gain an exfiltration channel. R-55 must stay open.

- **Evidence:**
  - § 4.7 keeps `script-src 'unsafe-inline'`, so an injected inline script runs. The CSP's value is `frame-ancestors`, `object-src`, `base-uri`, `form-action` and the host lists.
  - On the three measured pages `connect-src` allows `*.google-analytics.com`, and anyone can create a property there. It is a well-known channel for injected code to send page data to an attacker's own property. S-13 shows a guest's stay after lookup.
  - Mitigations already in place:
    - no known injection (React escaping, `lib/tables.ts` draws elements only);
    - navigation-based exfiltration is never stopped by CSP anyway.
- **Impact:** small today. It matters only if an injection is found later.
- **Remediation:**
  - In Phase 7, mark R-55 **amended, not closed**: the script wall is q4's nonce plan.
  - Record for that later plan: with `'strict-dynamic'` and a nonce, keep `www.googletagmanager.com` out of `script-src`. An allowlisted GTM host lets any container ID load, which is a known CSP bypass. Load gtag.js from the nonce'd loader instead.
- **Verification:** R-55's text after Phase 7.

### S-A6 · LOW · `img-src` versus brand image URLs on any https host

- **Evidence:**
  - `logo_url` and `banner_url` are checked as `'^https://[^[:space:]]+$'` (`schema-roles.sql:165-166`), and so is `assistant_avatar_url` (`schema-assistant-avatar.sql:18`). Any host is allowed.
  - The plan's `img-src` allows only `'self' data: blob:` and the Supabase origin.
  - D-123 uploads to the Supabase bucket, but the column does not require it.
- **Impact:**
  - A live tenant whose logo is on another host loses it under the CSP. This is functional.
  - Until the CSP ships, any such host receives every guest's IP and our origin on every page load, before any consent. That is the same class of disclosure this plan builds a consent bar for.
- **Remediation:**
  - Before Phase 5, a read-only query of the three columns' hosts for every tenant.
  - Then either narrow the three checks to the Supabase Storage public prefix (a new constraint, with the platform form's error in words), or list each foreign host in `img-src` deliberately.
  - The CSP is the browser's enforcement either way.
- **Verification:** the query's result recorded in Phase 5. `plan/public-brand-a11y.mjs`'s logo tenant is drawn under the CSP with 0 violations.

### S-A7 · LOW · One document must never configure two tenants' measurement IDs

- **Evidence:**
  - § 4.3: `loadAnalytics()` runs "once per document, guarded by a module flag", and later mounts call `gtag('set', …)` and send a page view.
  - The guard is not keyed on the ID. If a document that loaded villa's ID ever mounts a measured page with another ID, a second `config` would send to both properties.
  - No `<Link>` crosses tenants today. `/` lists no tenants and there is no cross-tenant nav.
- **Impact:** cross-tenant data in a property (FR-022), if a cross-tenant link is ever added.
- **Remediation:** key the guard on the ID. If a mount asks for a different ID, set `ga-disable-<old>` and reload, or do nothing.
- **Verification:** a component test with two IDs in one fake window shows one `config` call.

### S-A8 · INFORMATIONAL · Validate the measurement ID on the client too

- The ID goes into a script URL and a `window['ga-disable-' + id]` key.
- The SQL check (`^G-[A-Z0-9]{6,12}$`) makes injection impossible from the database.
- Even so, the module should re-test the same regex (export it from `lib/analytics.ts`) and build the URL with `URLSearchParams`. Then wall 1 holds even if a future source of the ID skips the check.

### S-A9 · INFORMATIONAL · Notes for implementing § 4.7

- Set *response* headers: `const res = NextResponse.next(); res.headers.set(…)`. Passing `headers` to `NextResponse.next({ headers })` sets request headers.
- The middleware runs on the edge runtime. Read `SUPABASE_URL` directly; do not import `lib/env.ts` or anything `server-only`.
- HSTS without `preload`.
- Add `/t/villa%2Fadmin` and a trailing-slash shape to the table test.
- `Permissions-Policy`: also deny `camera`, `geolocation` and `payment` explicitly.
- Consider shipping the first deploy as `Content-Security-Policy-Report-Only` alongside the enforced headers. Do not add a report endpoint: it would be a new open route to rate-limit.
- React runs a removed page's effect cleanup before the new page's effects. That ordering is what makes `ga-disable` correct on S-6 → S-13. Walk check 9 should include that `<Link>` and expect exactly one `page_view` on S-13.

### S-A10 · INFORMATIONAL · Rule 2's "nothing … is in reach of the module" is true of our module, not of gtag.js

- Google's script runs with the page's full privilege on S-1, S-6 and S-13. It can read the DOM: typed chat, the booking form, S-13's stay. It also can't be pinned with SRI.
- The guarantee is contractual: Google's terms, with user-provided data collection OFF. It is not technical.
- State this residual risk in R-63, and in Lex's privacy text if Lex agrees.

## Outside this plan: dependency audit (for the release gate, not this gate)

`pnpm audit --prod` (2026-10-28) reported **1 critical, 6 high, 4 moderate**:

- **next 15.5.25:**
  - GHSA-2464-fhr4-w9xw (critical, Image Optimization RCE with SVG, fixed in 15.5.28). The app uses no `next/image` and configures no `images.remotePatterns`, but the `/_next/image` endpoint exists by default. I did **not** assess whether it is exploitable here.
  - GHSA-p3m5-59mp-jv5r (high, Server Actions DoS).
  - Two moderate cache-poisoning advisories.
- **sharp 0.35.4:** GHSA-wq5f-xc86-pv6w (high). `app-icon.png` runs sharp on a tenant's logo.
- **zod 3.25.76:** GHSA-mrhx-c7xc-m3w5 (high, memory on oversized constrained collections). Routes validate with zod.
- **postcss 8.4.31 / source-map-js:** build-time, high or moderate.

The full `pnpm audit` adds critical and high advisories in dev-only `vitest`, `tinypool` and `vite`, which do not ship.

**Recommendation:** bump `next` to ≥ 15.5.28, `sharp` to ≥ 0.35.5 and `zod` per the advisory before any public URL. Then re-run the build, the web tests and the walks. This is Finn's work, through Theo. It is not a fix I make.

## Residual risks and open items

- Every GA4 behaviour is **[unverified]** until Phase 0 (R-63). A wrong fact there can change S-A3 and S-A4's severity.
- The isolation suites cannot run (the test tenants were deleted). This plan does not depend on them, but the release gate still does (R-61).
- The gate-7 review after Phase 6 re-checks:
  - the built CSP in a browser;
  - the intercepted payloads (walk check 7);
  - the `.next/static` grep;
  - S-A1, S-A2, S-A4 and S-A7 as implemented.

---

## Round 2 (2026-10-28, T-012)

> **Verdict: CLEAR** for gate 5.
> - **The rule I applied:** CLEAR means no MEDIUM or higher finding is open.
> - **What is left:** the LOW and INFORMATIONAL items below. They are small
>   edits inside the phases that already exist, and none changes the plan's
>   shape. They are owed in those phases, and gate 7 re-checks each one.
> - **This is not a statement that the design is secure.**
>
> **Spent:** nothing (Rule 7). No OpenAI call, no `pnpm eval`, no dev server,
> no browser and no database query.

### Scope and method

- **Read:**
  - `plan/analytics.md` round 2, all 1,254 lines, against round 1 of this
    file;
  - `components/staff-frame.tsx:85-174`, to see where the S-A2 guard would
    sit and which branches it covers;
  - `app/t/[tenant]/admin/reset/page.tsx`'s imports;
  - `sql/schema-tenancy.sql:43`, the slug's shape.
- **Grepped:** the guest-page components for any link to `/platform`. There
  is none.
- **Commands:** `node office/office.mjs inbox sage`, `task list sage`, the
  gate and the task commands below. No `pnpm audit` re-run: the plan bumps
  the dependencies in Phase 0 and re-runs the audit there.
- **Assumptions:** none were asked of the user.
  - Every GA4 behaviour is still **[unverified]**: Context7 was skipped by
    the user, and no Google page was read.
  - Rhea's D-1, which keeps `?ref=` in S-13's URL, is a requirements
    decision. I do not reopen it. I judge the controls the plan puts in its
    place.
  - The gate rule above (CLEAR means nothing MEDIUM or higher is open) is
    mine. Theo or the user may read the PARTLY items as CONCERNS instead.

### The round-1 concerns

| Id | Round 1 | Round 2 | Where in the plan | What is left |
|---|---|---|---|---|
| S-A1 | MEDIUM | **RESOLVED** | Rule 8 (`plan/analytics.md:260`); § 4.7, `frame-src 'self' blob: <SUPABASE_URL origin>` in the base policy (`:764`, `:774-782`); `csp.test.ts` pins it on every row (`:806`, `:903-904`); Phase 5 opens both PDF proofs (`:954-956`) | Verification only. Phase 5 must show the two frames drawn with 0 violations. It must also record whether Storage's own response allows framing. The plan already says a refusal there comes back to me rather than loosening the CSP (`:780-782`) |
| S-A2 | MEDIUM | **PARTLY** (LOW left) | Rule 4 (`:191-196`), § 2.3 (`:370-374`), § 4.4 (`:707-709`), Phase 3's unit test and widened grep (`:926-933`), walk 11a and 11b (`:1017-1024`) | The mechanism I asked for is adopted. Its reach and its timing are not stated: see **S-A11** |
| S-A3 | MEDIUM | **PARTLY** (LOW left) | Rule 9 (`:266-284`); Phase 0 row H (`:349-350`, `:834-838`); the § 6.2 checklist (`:1108-1130`); R-61 per property (`:1070`); walk check 8 follows S-6's real `?ref=` `<Link>` (`:1003-1006`). Part 4 (R-U5) was declined by Rhea (D-1, `:92-93`) | Parts 1–3 are resolved, and part 4 is answered by `page_location` plus check 8. But check 8 runs against the WALK property. Its result depends on that property's own enhanced-measurement settings **[unverified: that gtag.js takes them from the property]**. If the walk property has history-change page views OFF, check 8 passes whether or not the code's `page_location` holds, and it proves nothing about the code. **Remediation (LOW):** set the walk property up as the worst case, with every enhanced-measurement toggle ON, especially page changes on history events. Then check 8 proves the code holds even without Rule 9's setting. Also re-confirm each tenant's R-61 row at every release gate, because a property's settings can drift after the date recorded |
| S-A4 | LOW | **PARTLY** (LOW left) | Rule 2 (`:140-142`); Rule 6 (`:233-237`); § 2.5 (`:390-404`); § 4.2's `cookieDomains` (`:641`); § 4.3's clear (`:686-688`); walk checks 5c, 13 and 14 | (a) **The "switch off" case cannot be built as specified.** Rule 6 says the clear also runs when "the switch [is] off with a cookie left". But when the switch is off, § 4.1 passes `analytics={null}` (`:614`), and with `null` the `AnalyticsRoot` "renders its children and nothing else" (`:654-656`). Nothing then knows the slug, so nothing clears. Walk check 1 asserts only that no cookie is *set* while off, not that one is *cleared*. The cookies are first-party, so with gtag absent they are sent only to our own host, which does not log them. The impact is that an identifier outlives the switch. **Remediation:** pass `{ slug }` even when off; on `id === null`, `AnalyticsRoot` runs `clearAnalyticsCookies(slug)` and nothing else. Extend walk check 1: Allow while on, switch off, reload, and no `ga_villa*` cookie is left. (b) **`cookieDomains()` is "the host, then its parent".** GA's `auto` uses the highest domain it can set **[unverified]**, which on a host of three or more labels is not the immediate parent. Return every ancestor down to two labels. A browser ignores a delete on a public suffix, so trying it is harmless. This is defensive only, because `cookie_domain: 'none'` applies from the first load |
| S-A5 | LOW | **RESOLVED** (as a plan) | § 0's table (`:107`); § 4.7's `'unsafe-inline'` and GTM-host notes (`:783-791`); Phase 7, R-55 amended, not closed (`:1062-1066`) | Verification only: R-55's text after Phase 7 |

The other round-1 items are also adopted: S-A6–S-A10, the anon key in
verify 249 (`:873-874`) and the dependency bump (`:842-849`, § 9). I spot-
checked S-A7 (`:668-683`, `:923`) and S-A8 (`:121-123`, `:629`). Both match
what I asked for.

### New in round 2

#### S-A11 · LOW · The StaffFrame reload guard covers StaffFrame only, and it runs after the staff page has rendered

- **Evidence:**
  - **The reach.** Rule 4 places the guard in `StaffFrame` (`:191-196`).
    These pages under `/admin` or `/platform` do not use StaffFrame:
    - `app/t/[tenant]/admin/reset/page.tsx` draws `BrandHeader`,
      `TenantNav` and `ResetPassword`. That page holds a recovery token in
      the `#fragment` and a new-password field.
    - `/platform` and `/platform/reset` (`platform-screen.tsx`) hold every
      tenant's record and members' emails.
  - No guest page links to any of them today (the grep found no
    `/platform` link in the guest components). That is the same
    link-discipline argument S-A2 said not to rely on.
  - **The signed-out branch.** StaffFrame returns early: `checking` at
    `:163`, and signed out at `:165-173`, which renders `children`, the
    login form with its password field. Hooks must come before those
    returns, so a hook-based guard would cover both branches. The plan
    should still say so, and the unit test should cover the signed-out
    branch.
  - **The timing.** The guard is "its first effect" (`:191-192`, `:707`).
    `useEffect` runs after commit and paint. Children's effects run before
    the parent's, so the staff page's own fetches have already started.
    The page's DOM exists, in a document where gtag.js is resident, for at
    least one task before `location.reload()` takes the document away.
- **Impact:**
  - **The reach:** a later `<Link>` into the reset page or into
    `/platform` from a measured page would put gtag.js in a document with a
    password field and a recovery token, or with every tenant's record.
  - **The timing:** a window measured in milliseconds in which a resident
    third-party script shares a document with staff data.
  - Both are LOW: no such link exists, and Google's script is not hostile
    by contract (S-A10).
- **Remediation:**
  - Make the guard ONE hook or function, for example
    `useFreshDocument()` beside `analyticsLoaded()`.
  - Call it from StaffFrame (before its early returns), `ResetPassword`
    and `PlatformScreen`, and from any later staff or platform root. Write
    that rule into the CLAUDE.md convention Phase 7 adds (`:1077-1078`).
  - Run the check during render, not in an effect: if
    `typeof window !== 'undefined' && analyticsLoaded()`, call
    `location.reload()` and return `null`.
    - A fresh document hydrates with the flag false, so the server HTML
      and the first client render agree. This works on a fresh document
      for that reason.
    - Children are then never committed into a document that held
      gtag.js.
    - A side effect in render is impure, but it is idempotent, and it
      only runs in a state that should never happen.
- **Verification:**
  - Phase 3's unit test covers the signed-out branch and the two other
    callers.
  - Walk check 11b is repeated with `router.push('/t/villa/admin/reset')`
    and `router.push('/platform')`: each reloads, with no
    `googletagmanager` script.
  - In 11a, the admin document's DOM is never observed holding the staff
    page together with the script. A `MutationObserver` registered before
    the push records it.

#### S-A12 · INFORMATIONAL · The measured-path regex matches a path the table test calls unmeasured

- **Evidence:**
  - § 4.7's regex is `^/t/[^/]+(/book|/manage)?/?$` (`:767`).
  - The table test lists `/t/villa%2Fadmin` as "not measured" (`:802`).
  - `[^/]+` matches `villa%2Fadmin`, because `%2F` is not a `/`. Either the
    test fails as written, or someone loosens it to make it pass.
- **Impact:**
  - The response is a 404 ("No such workspace"), so no analytics loads.
    Google's hosts would only be allowed on a page that loads nothing.
  - The real cost is a test that does not say what the regex does.
- **Remediation:** use the slug's own shape from `schema-tenancy.sql:43`,
  `[a-z0-9][a-z0-9-]{1,30}[a-z0-9]`, in place of `[^/]+`. Keep the `%2F` row
  as "not measured".

#### S-A13 · INFORMATIONAL · The two-trigger gate on the switch has a write-skew window. It fails safe.

- **Evidence:** § 3 step 3 (`:544-549`) has two triggers that each read the
  other table.
  - The `tenant_features` trigger reads `tenants.analytics_id` and
    `analytics_instructed_on`.
  - The `tenants` trigger reads `tenant_feature_on()`.
  - Under read committed, two concurrent transactions can each pass the
    other's check, and the result is ON with a null ID or a null date:
    - transaction A switches on;
    - transaction B clears the ID or the date.
- **Impact:**
  - **A null ID fails safe:** `tenant_public()` returns `case … then
    t.analytics_id end`, so it returns null, and the page loads nothing.
  - **A null date breaks FR-028 in the record:** the switch is on with no
    written instruction.
  - Only super users write either table.
- **Remediation:**
  - In the `tenant_features` trigger, read the tenant row with
    `select … for update`. Then the `tenants` update in B waits for A, and
    its trigger sees A's commit.
  - In step 4, write the first-switch-on bump as ONE
    `update … where id = … and analytics_since is null`, never as a SELECT
    followed by an UPDATE. Two concurrent first switch-ons then bump once.

#### S-A14 · INFORMATIONAL · A Report-Only copy of the enforced policy reports nothing new

- **Evidence:** § 4.7 ships "the same CSP as
  `Content-Security-Policy-Report-Only`" beside the enforced one
  (`:807-810`).
- **Impact:**
  - An identical Report-Only policy reports exactly what the enforced one
    already blocks, so the console shows each violation twice. My round-1
    note (S-A9) was unclear on this.
  - The point of a Report-Only header is to try the *next*, stricter
    policy without breaking the page.
- **Remediation:** either drop it, or make it the candidate for R-55's next
  step. That candidate is `style-src` without `'unsafe-inline'`, or (once
  the nonce plan exists) `script-src` without it. Phase 5's walk then
  records what that stricter policy would break.

#### S-A15 · INFORMATIONAL · The duplicate-ID trigger and the unique index (FR-020)

- **Checked, and no finding:**
  - The trigger reads other tenants' rows. It is not a new definer
    (`:581`), so it reads under the super token (`tenants_super_all`).
  - Only a super user can reach it (verify 249), so its sentence tells
    nobody else that an ID is in use.
  - The ID is public in every hit anyway.
  - The partial unique index is the race guard. T-A4's generic 409 is
    acceptable.
  - `analytics_instructed_on` and `analytics_since` stay out of
    `tenant_public()` (`:563`). That is correct.
- **One note:** an archived tenant keeps its ID, and so blocks reuse. That
  is a functional matter, for Rhea if it ever matters.

### The house's walls, re-checked on round 2

| Wall | Round 2 | Finding |
|---|---|---|
| No request holds a key that bypasses RLS | Still no new route, no definer and no policy (`:580-586`, `:1102-1103`). T-A2 gives the analytics gates no `service_role` exemption | Holds, and T-A2 is the stricter choice |
| Two walls, each alone | Wall 2 is verify 247 with its positive twin. Wall 1 is the component test (`:918-919`) | Holds |
| Who can switch it on | `tenant_features` stays super-only. Verify 249 adds the anon key | Holds. S-A13 is a race between two super users, not a widening |
| A tool result carries nothing a visitor may not see; the signer's one shape | Untouched (`:1092-1093`) | Holds |
| The `.next/static` grep | Phase 6 (`:1056`) | Holds |
| D-137 limits, D-107 bucket, D-138 audit log | No open route. The proof viewer is fixed by S-A1. `audit_row()` gains three columns, re-applied 43 → 46 (`:574-578`) | Holds |

### Residual risks, round 2

- Every GA4 fact is still **[unverified]**. Phase 0 rows A, B, D, G and H
  can each change S-A3's or S-A4's severity. If row H says a history change
  reads `document.location`, S-A3 goes back to MEDIUM until the walk
  property's worst case (above) shows `page_location` holding.
- The isolation suites still cannot run (northwind and harbor deleted).
  This plan adds no tenant-scoped query.
- Gate 7, after Phase 6, re-checks:
  - S-A1's two frames;
  - S-A11's three callers and its render-time check;
  - S-A4(a)'s switch-off clear;
  - S-A3's walk-property settings;
  - S-A12's regex;
  - the intercepted payloads (check 7) and the `.next/static` grep;
  - `pnpm audit --prod` after Phase 0's bump.
