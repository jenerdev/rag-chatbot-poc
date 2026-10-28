# Analytics plan: Google Analytics 4 on the three guest pages, loaded only after a guest allows it, with the security headers R-55 owes

> The user's line in `todo.md` was "google analytics". Gate 1 (Ivy,
> `docs/product/analytics.md`) approved the PROBLEM: nobody can see how many
> people open the chat, the booking page and Manage booking, where they came
> from, and how many go on to chat, see a price, send a request or find a
> stay. Gate 2 (Rhea, `docs/requirements/analytics.md`) was approved by the
> user on 2026-10-28 with **Q1 = A, GA4**, and the defaults for Q2, Q4, Q5
> and Q7. Rhea amended it after gate 2 (§ 12 there, A-1…A-22): the FRs are
> now FR-analytics-001…028 and AC-01…32. Lex's advice
> (`docs/legal/analytics.md`, M-009) answers Q3 and Q9. Uma's UX
> (`docs/ux/analytics.md`, M-012) and Vera's design
> (`docs/design/analytics.md`, M-013) place the consent bar and the
> privacy-page control.
>
> This plan says HOW:
> - a per-tenant switch that is off with no row;
> - a GA4 measurement ID per tenant, unique across tenants, that Postgres
>   will not hand out while the switch is off;
> - the tenant's written-instruction date, without which the switch cannot
>   go on (FR-028);
> - ONE client module that loads nothing from Google until Allow, and then
>   sends only addresses and four step names the code wrote itself;
> - the privacy text per tenant;
> - the security headers (R-55) that keep Google's hosts off every page but
>   those three.
>
> Written 2026-10-28 by Theo (gate 5). **Round 2**, the same day, answers
> three things:
> - the user's answers to § 7 (M-021);
> - Rhea's amendments (M-023);
> - Sage's review (`docs/security/analytics.md`, M-020, CONCERNS).
>
> What changed is listed in [§ 8](#8-round-2-what-changed-and-why).
>
> **Status: Planned.** Nothing here is built, and nothing is committed by
> this plan.
>
> **Spent:** nothing (Rule 7): no OpenAI call, no `pnpm eval`, no dev
> server, no browser, no database query.
>
> **No Google document was read.** The user skipped Context7 (M-021), so
> every GA4 fact below is marked **[unverified]**. Phase 0 is the read that
> confirms or kills each one before any code is written (§ 2.1, R-63).
>
> Read [§ 0](#0-the-nine-rules) first.

---

## What this plan covers

### In scope

- **The switch:** the tenth feature key, `analytics`, OFF with no row
  (D-134's shape).
- **Four `tenants` columns** in `sql/schema-analytics.sql`, the 46th file:
  - `analytics_id`, a GA4 measurement ID: refused by shape, unique across
    tenants, required before the switch goes on, and returned by
    `tenant_public()` ONLY while the switch is on;
  - `analytics_instructed_on`, the tenant's written-instruction date
    (FR-028), required before the switch goes on;
  - `analytics_since`, stamped on the first switch-on;
  - (the fourth, `policy_version`, exists) bumped on that first switch-on
    (FR-019, A-R5).
- **The client code:**
  - `lib/analytics.ts`, pure: the stored choice, GPC/DNT, the address and
    referrer GA4 is given, the four step names, the ID's shape;
  - `components/analytics.tsx`: the ConsentBar, the loader, `track()`;
  - both placed on S-1, S-6 and S-13 as Uma and Vera specified.
- **The privacy page:** its analytics paragraphs and its AnalyticsChoice
  control.
- **The platform form:** the Features tab's Analytics row with the ID
  field, and the Legal tab's instruction date.
- **StaffFrame's reload guard** (S-A2).
- **The security headers of R-55**, for the whole app, with Google's hosts
  on the three measured paths only.
- **The dependency bump** Sage found (§ 9, outside S-A1–S-A10).
- **The evidence and the record:** verify checks, unit tests, a walk that
  intercepts every request to Google and lets none through, the GA property
  checklist per tenant in R-61, and the record.

### Out of scope

- **Pages that are never measured:** any staff page, `/platform`, `/`,
  `/privacy`, `/terms`, and the tenant privacy and terms pages (Q5 = no).
- **Analytics on S-11:** no figure is drawn there (FR-023; owners read in
  GA4).
- **Other Google products and modes:** Consent Mode in any form (§ 2.2), the
  Measurement Protocol, Google Tag Manager and server-side tagging.
- **Excluding signed-in staff** (Q7 = no).
- **Bot filtering** beyond GA4's own.
- **Removing `?ref=` from S-13's address bar.** Uma's R-U5 was declined by
  Rhea (D-1, Q10); it is a separate idea for George.
- **A nonce CSP** (q4: left open in R-55).
- **A DPA precondition** (Q11 default: no in v1).
- **Done by the user, by hand (§ 6.2):** creating the GA4 properties,
  granting Viewer, and accepting Google's terms.

### What the user asked, and what the plan does with it

| The user's words | What exists today | What the plan does |
|---|---|---|
| "google analytics" (`todo.md:9`) | S-11 counts only guests who acted (D-098). Nothing counts visits or sources | GA4 on S-1, S-6 and S-13, per tenant, after consent |
| Gate 2: Q1 = A (GA4); Q2 default | No GA anywhere, and no CSP (R-55) | ONE GA4 property per tenant (§ 1.2) |
| M-021 q1: "one GA4 property per tenant in the user's GA account, each owner a Viewer on their own only" | No property exists | The plan is built on it. Viewer-only is a RULE (Rule 9), not a preference, and each property's checklist is recorded in R-61 before its switch goes on |
| M-021 q2: the written-instruction rule only if Rhea adopts it | Rhea ADOPTED it as FR-028 (A-16) | `analytics_instructed_on`, the trigger that refuses ON without it, the Legal tab field, and verify 251–252 |
| M-021 q4: a host-allowlist CSP now; the nonce stays open in R-55 | No headers | § 4.7. R-55 is amended, not closed, at Phase 7 (S-A5) |
| M-021: Context7 skipped | Nothing read | Every GA4 fact stays **[unverified]**, and Phase 0 confirms each one before code (R-63) |

---

## 0. The nine rules

### Rule 1: Nothing from Google before Allow

- Nothing from Google is in the HTML: no `<script src>`, no inline `gtag`
  stub, no `preconnect`.
- The ConsentBar decides on the device, after hydration.
- Only an Allow (a click now, or a valid stored allow) runs
  `loadAnalytics()`, which writes `window.dataLayer` and appends ONE
  `<script src="https://www.googletagmanager.com/gtag/js?id=…">`. The URL is
  built with `URLSearchParams` from an ID that passed `ANALYTICS_ID_SHAPE`
  on the client too (S-A8).
- Consent Mode is NOT used, basic or advanced. A default-denied consent
  command is itself Google code running before a choice (Lex Q3.1).
- In every other case the function is never called: declined, ignored, GPC,
  DNT, unwritable storage, a 404, the switch off, or no ID.
- The walk proves it from the network log, not from reading the code.

### Rule 2: The app sends only what it wrote itself

- `config` gets exactly these settings, and nothing else:
  - `send_page_view: false`;
  - `page_location` from `measuredLocation()`;
  - `page_referrer` from `measuredReferrer()`;
  - `page_title`, one of three fixed words: Chat, Booking page, Manage
    booking;
  - `allow_google_signals: false` and `allow_ad_personalization_signals:
    false`;
  - `cookie_prefix` per tenant, `cookie_expires` of 180 days,
    `cookie_domain: 'none'` and `cookie_update: false` (§ 2.5, S-A4)
    **[unverified, each]**.
- The page view is sent by the module.
- `track(step)` takes ONE argument, a `StepEvent`, the union `'chat_started'
  | 'quote_shown' | 'request_sent' | 'stay_found'`. It has no parameter
  object, so no caller can attach a property. That is FR-014's list 1, held
  by the compiler.
- Nothing typed, spoken, priced, referenced or identified is in reach of
  OUR module. It is given the slug, the page, the ID and the step name, and
  nothing more.
- **This is not a guarantee about gtag.js** (S-A10). Google's script runs
  with the page's full privilege and can read the DOM. What keeps it from
  collecting form data is contractual: Google's terms, with user-provided
  data collection OFF. It is not technical. That residual risk is written
  into R-63 at Phase 7.

### Rule 3: Two walls, each alone (D-038)

- **Wall 1, the code:** the page passes `analyticsId` to the client only if
  `flags.analytics` is on. The module does nothing without an ID that
  matches the shape.
- **Wall 2, Postgres:** `tenant_public()` returns `analytics_id` as `null`
  while the switch is off, whatever the column holds.
- **Triggers** refuse three things, each in words:
  - switching on with no ID, or with no instruction date;
  - clearing either while the switch is on;
  - setting an ID another tenant already has.
- **verify proves wall 2 alone:** the column is set, the switch is off, and
  `tenant_public()` gives null. The positive twin is the switch on, which
  gives the ID.
- **A unit test proves wall 1 alone:** the flag is off and an ID is passed,
  and nothing renders and nothing loads.

### Rule 4: Only the three pages, and they leave nothing behind

- The bar and the loader are rendered by `page.tsx` of S-1, S-6 and S-13,
  and only after their `notFound()` checks. The tenant layout is NOT the
  place (plan.md:678's seam is refused): the layout also wraps `/admin/**`,
  privacy and terms.
- **The loader is keyed on the ID** (S-A7). It configures one ID per
  document. A mount that asks for a different ID loads nothing, and
  `track()` stays a no-op for it.
- Moving to an unmeasured page with a Next `<Link>` keeps the window and the
  loaded `gtag.js`. So the module sets `window['ga-disable-<ID>'] = true`
  when the measured page unmounts, and clears it when a measured page mounts
  with consent **[unverified]**.
- **Staff links are plain `<a>`.** Every link from a guest page into
  `/t/<slug>/admin` is a plain `<a>`, which opens a fresh document under the
  staff CSP. Today that is `public-footer.tsx`'s "Staff login" and
  `tenant-nav.tsx`'s staff link.
- **StaffFrame is the structural guard** (S-A2). Its first effect checks
  whether analytics was loaded in this document: the module's exported
  `analyticsLoaded()`, or `typeof window.gtag === 'function'`. If it was,
  StaffFrame calls `location.reload()`. Every staff screen therefore runs in
  a document that never held gtag.js, whatever link or `router.push`
  brought it there.
- The CSP (Rule 8) is the browser's wall: on every other path, Google's
  hosts are not allowed.

### Rule 5: A step is a success the screen already drew

Each step event fires where the screen has already drawn the success, and
only once:

| Event | Fires when | Fires at most |
|---|---|---|
| `chat_started` | `sawDone` on the first turn of a conversation, at the point where `conversationId` goes from null to a value | Once per conversation. "New chat" starts a new one |
| `quote_shown` | the quote state first holds a `RequestQuote` | Once per load |
| `request_sent` | `setSent()` | Once per accepted request |
| `stay_found` | `setStay()` with a stay | Once per load |

- A 429, 409, validation error, `error` event or network failure fires
  nothing, because those branches throw or return before the success line.
- Nothing is replayed after a late Allow (R-U6). The count means "steps
  taken after allowing".

### Rule 6: The choice is the guest's, kept on the device, per tenant

- **The stored choice** is under the localStorage key `analytics:<slug>`,
  with the value `{ choice: 'allow' | 'decline', at, version, via: 'bar' |
  'privacy' }`. That is FR-008's "slug, choice, time, policy version": the
  slug is in the key, and `via` is a fact about the choice, not about the
  guest.
- **A choice is valid** while it is under `ANALYTICS_CHOICE_DAYS` (180) old
  and its `version` equals the tenant's `policy_version` (FR-026). Anything
  else is no choice.
- **GPC or DNT is a Decline with no bar** (FR-027): GPC is
  `navigator.globalPrivacyControl === true`, DNT is `navigator.doNotTrack
  === '1'` **[unverified: the property names]**. Only a valid allow made on
  the privacy page (`via: 'privacy'`) overrides the signal (Lex Q9).
- **Unwritable storage:** if storage cannot be written there is no bar and
  nothing loads.
- **Every decision other than `'load'` deletes this tenant's GA cookies**
  (S-A4): a Decline, an expired or other-version choice, GPC or DNT, and the
  switch off with a cookie left. The deletion covers the prefix (§ 2.5), on
  the host and, in case an older load used the default domain, on the
  registrable parent too.
- **Nothing about the choice reaches the server** (Lex Q3.1: no server log).

### Rule 7: The pages never wait on Google

- The loader is `async`, created after the choice.
- `gtag` failing to load, being blocked or answering slowly changes nothing
  a guest sees. There is no `onerror` UI, no retry and no `await` in any
  flow.
- `track()` returns `void` and never throws: it is wrapped, and a missing
  `window.gtag` is a no-op (FR-018).

### Rule 8: The security headers are this plan's, for every page (C4, BR-8, R-55)

- One pure function, `securityHeaders(pathname, env)` in `lib/csp.ts`, is
  unit-tested and applied by `middleware.ts`.
- **Every response gets:**
  - HSTS, without `preload`;
  - `X-Content-Type-Options: nosniff`;
  - `Referrer-Policy: strict-origin-when-cross-origin`;
  - `frame-ancestors 'none'`, with `X-Frame-Options: DENY`;
  - `Permissions-Policy`: microphone self only (for voice), and camera,
    geolocation and payment denied;
  - the base CSP, with `frame-src` for the proof viewer (S-A1).
- **Only the three measured path shapes** (`/t/<slug>`, `/t/<slug>/book`,
  `/t/<slug>/manage`) add Google's hosts.
- The chatbot is untouched: no prompt text, no tool text, and the three
  baselines are byte-identical at the end.

### Rule 9: The property's settings are part of the guarantee, so they are a rule (S-A3)

- Some promises live in each property's settings, not in the code:
  - FR-011, FR-013 and FR-014 rest partly on settings that are set by hand
    in Google's UI: enhanced measurement off, user-provided data off,
    granular location and device off;
  - FR-022 rests on the access grants.
- So these are rules, not preferences:
  - the properties live in the user's GA account (M-021 q1);
  - an owner is a **Viewer** on their own property, never Editor,
    Administrator or Marketer;
  - nobody but the account holder can change a property's settings;
  - a tenant's switch goes on only after that tenant's § 6.2 checklist is
    recorded in R-61, with the date and who set it.
- The code also does not rely on them alone. The module sends its own
  page view with its own `page_location` (Rule 2). Phase 0 answers whether
  a history-change page view would read `document.location` regardless.
  Walk check 8 follows S-6's real `?ref=` link into S-13 and greps every hit
  for the reference.

---

## 1. Q8 answered: can GA4 meet FR-analytics-006 and 011–014?

**Short answer, after Rhea's amendments.**
- **006, 011 and 012: yes, by construction.**
- **013: yes,** as Rhea amended it (A-6: an internal referrer is our own
  origin, or none).
- **014: yes,** as amended (A-7): list 1 is closed by the app, and list 2
  names GA4's own fields.
- **022: yes,** by one property per tenant (A-11, M-021).
- **024: yes,** as Lex worded it (A-12).
- Each answer rests on GA4 behaviour that is **[unverified]**. Phase 0 reads
  it. If a fact is wrong, that FR's answer changes and Rhea is told; the FR
  does not relax.

### 1.1 FR by FR

| FR | Answer | How | Rests on |
|---|---|---|---|
| **006**, **AC-32** Nothing before a choice | **Yes** | Rule 1: no Google code at all before Allow, so there is no Consent Mode and no ping. The walk checks the network log for zero requests to `*.google*.com` or `*.googletagmanager.com` in four cases: before Allow, after Decline, with GPC, and with the switch off | Our code alone |
| **011** S-13 sends no query string | **Yes** | `page_location` is origin + `/t/<slug>/manage`, set before the first hit, with `send_page_view: false`. Enhanced measurement is OFF (Rule 9). `Referrer-Policy: strict-origin-when-cross-origin` makes the Referer header of the request to Google the origin only. Walk check 8 covers both S-13 opened directly with `?ref=` and S-6's `<Link>` into it | gtag uses `page_location` for `dl` instead of `document.location`, including on a history change **[unverified, Phase 0 row H]** |
| **012** Only `utm_*` on S-1 and S-6 | **Yes** | `measuredLocation()` rebuilds the URL: origin, path, then the five `utm_*` keys in a fixed order, the first value of each. Every other key and every fragment is dropped | GA4 reads campaign data from `page_location`'s `utm_*` **[unverified]** |
| **013** (A-6) Referrer: an origin, or none | **Yes** | `measuredReferrer()` sets `page_referrer` on every hit. An external `document.referrer` gives its origin. An internal one, or the previous measured page after a `<Link>`, gives our own origin. The module keeps the previous page in memory, because `document.referrer` does not change on a `<Link>`. "None" is not used: an empty `page_referrer` may be refilled by gtag from `document.referrer` | gtag uses `page_referrer` instead of `document.referrer` **[unverified]** |
| **014** (A-7) Two closed lists | **Yes** | List 1 is closed by Rule 2. List 2 is GA4's own fields, named by Rhea. Granular location and device collection are OFF (Rule 9). The walk (check 7) fails on any field outside both lists and reports its name to Rhea | Google's parameter reference **[unverified]** |
| **020** (A-9) The tenant's own ID, unique | **Yes** | The shape check, a partial unique index, and a trigger that refuses another tenant's ID in words (§ 3 step 2) | The ID's shape **[unverified]** |
| **021** (A-10) 7/30/90 days, in the tenant's day | **Yes** | Standard reports are aggregates. The 2-month retention setting limits explorations only, so a 90-day view works in Reports. Each property's time zone is the tenant's (§ 6.2). If Phase 0 finds otherwise, Rhea and Lex are told, and the retention is not lengthened | **[unverified]** |
| **022** (A-11) One tenant never reads another's | **Yes** | One property per tenant in the user's account, Viewer on their own only (Rule 9). Walk check 5b proves the request bodies: villa's hits carry villa's ID only | GA4 access is per account or property **[unverified]** |
| **024** (A-12) Shortest retention, stated | **Yes** | The property is set to 2 months (§ 6.2), and `ANALYTICS_RETENTION_MONTHS = 2` is the one value the privacy text states | GA4 offers 2 or 14 months **[unverified]** |
| **026**, **027** (new) | **Yes** | Rule 6 | The GPC and DNT property names **[unverified]** |
| **028** (new) | **Yes** | `analytics_instructed_on` and its triggers (§ 3 step 3). The Legal tab field is the DPA date's shape (D-130) | Our code alone |

### 1.2 Why one property per tenant

- **FR-022:** one platform property cannot restrict an owner to one
  tenant's rows **[unverified]**.
- **One setting each:** a single property has a single time zone and a
  single retention setting.
- **Cost:** a property per tenant costs one text field and one column.
- **Lex Q3.6:** it is legally the cleaner shape.
- **The user's choice:** M-021 q1, in the user's GA account.
- **Already designed:** Uma's U-A2 alternative, and Vera styles the field
  from existing rules.

---

## 2. Traps

### 2.1 Every GA4 fact here is unread

- No Google page has been read (Context7 skipped, M-021). Phase 0 reads
  Google's own pages in a browser, at no cost. Each row is recorded as
  confirmed or wrong, with its source URL, in `plan/analytics/phase0.md`:
  - **A.** the gtag `config` fields of Rule 2, including `cookie_domain`
    and `cookie_update`;
  - **B.** `ga-disable-<ID>`;
  - **C.** `cookie_prefix` and `cookie_expires`;
  - **D.** the enhanced-measurement, user-provided-data and granular-data
    toggles;
  - **E.** the data-retention options, and whether they govern explorations
    only;
  - **F.** the property access model and its roles;
  - **G.** the CSP hosts Google lists for GA4;
  - **H.** (S-A3) whether a history-change page view uses the
    `page_location` set by `config` or `set`, or `document.location`;
  - **I.** the measurement ID's shape;
  - **J.** `navigator.globalPrivacyControl` and `navigator.doNotTrack`;
  - **K.** where Google's GA data processing terms are accepted.
- A wrong fact stops the phase that needs it, and goes to the owner of the
  FR it breaks. It is not patched around.

### 2.2 Consent Mode is a trap for this design

- The standard snippet sets `gtag('consent', 'default', {…denied})` and
  loads the tag at once.
- With "advanced" behaviour, that sends cookieless pings before any choice,
  which fails FR-006 (Lex Q3.1).
- "Basic" behaviour still loads Google's script before the choice.
- This plan uses neither. The tag is simply absent until Allow.

### 2.3 A `<Link>` keeps the tag

- Next's client-side navigation keeps `window`, `dataLayer` and the loaded
  `gtag.js`.
- **Into a staff page**, a resident gtag.js could read guest PII on S-3,
  S-15 and S-16. `ga-disable` stops hits, not the script (S-A2). The guards:
  1. staff links as `<a>`;
  2. StaffFrame's reload (Rule 4), which holds whatever link a future edit
     adds.
- **Into an unmeasured guest page** (privacy, terms), no hit goes out
  because of `ga-disable-<ID>` on unmount and enhanced measurement OFF.
- **The walk** navigates S-1 → privacy (`<Link>`) → Staff login. It
  asserts zero hits after leaving S-1, and an admin document with no
  `googletagmanager` script.

### 2.4 The CSP of the first document is the CSP of the whole session

- A CSP header applies to the document that loaded it, and a client-side
  navigation keeps the first page's policy.
- So S-1's Google allowance reaches a privacy page opened with a `<Link>`.
  That is acceptable, because nothing loads there (Rule 4).
- It can never reach a staff screen. The staff screens always start their
  own document, because of the `<a>` links and the StaffFrame reload.

### 2.5 Cookies are per host, tenants are per path

- Every tenant is on one host (`/t/villa`, `/t/alteza`), so GA's default
  `_ga` cookie would be ONE client id across tenants.
- `cookie_prefix: 'ga_<slug>'` **[unverified]** gives each tenant its own
  cookies.
- `cookie_domain: 'none'` **[unverified]** keeps them host-only. GA's
  default `auto` would set the cookie on the registrable parent, where a
  host-only delete misses it (S-A4).
- `cookie_expires: 15552000` (180 days) with `cookie_update: false`
  **[unverified]** makes the cookie end 180 days after it was set, not 180
  days after the last hit. That is FR-008's "no identifier outlives the
  choice": the choice is also 180 days from when it was made.
- The deletion runs on every non-load decision (Rule 6). It expires every
  cookie with the prefix, on the host and on the parent domain.

### 2.6 `tenant_public()` is replaced for the fourth time (trap 20, trap 25)

- The 46th file drops and re-creates `tenant_public()` with
  `analytics_id`.
- `schema-welcome-text.sql` (the 44th) does the same with one column fewer.
  Its step 2 is guarded on `tenant_public()` returning `analytics_id`,
  exactly as `schema-legal.sql` was guarded on `welcome_text`.
- `schema-voice.sql` (the 41st) puts back a nine-key constraint and a
  `tenant_feature_on()` that knows only voice. A re-run after this file must
  skip both, so both are guarded on `tenants.analytics_id` existing.
- `audit_row()`'s `tenants` allowlist gains `analytics_id`,
  `analytics_instructed_on` and `analytics_since`. That is an edit to the
  43rd file, so the 43rd and every file after it are re-run in order
  (trap 25).

### 2.7 The version is bumped on the FIRST switch-on, not on every flip

- **Round 1 bumped `policy_version` on every flip.** Rhea's A-R5 and
  FR-019 say: bump on the first switch-on, and when the analytics text
  changes, not on every re-enable. The plan follows the FR.
- **The first switch-on** is the one that finds `tenants.analytics_since`
  null. The 46th file's trigger stamps `analytics_since = now()` and bumps
  the version in the same statement. It does this for every door: the
  platform route, a CLI, a hand.
  - A numeric version becomes n + 1.
  - A non-numeric one (the check allows `v1.2`) refuses the switch with a
    sentence: "Set the next policy version on the Legal tab before switching
    analytics on."
- **Later re-enables do not bump.** A guest's choice made under the first
  analytics text stays valid across an off-and-on, because the text it was
  made under has not changed.
- **A text change** is bumped by hand, on the Legal tab, as every
  privacy-text change is today (D-129). The plan makes it impossible to
  forget silently: `legal.test.ts` pins the analytics paragraphs, and the
  pin's failure message says "bump policy_version for every tenant with
  analytics_since set".
- **The audit:** the `tenants` update writes its own audit row
  (`policy_version` is in the allowlist already).

### 2.8 The bar is decided after hydration, so it lands one frame late

- The server cannot read localStorage, so the server and the first client
  render show nothing, and an effect decides.
- On S-6 and S-13 the bar is inserted above `<main>` one frame after the
  first paint. Uma's M-012 point 1 asked if that is acceptable: **yes**.
  - It lands before any field could hold focus.
  - A reserved slot would be a permanent empty gap for every guest who has
    already chosen (Vera: "no empty slot when hidden").
- The `role="status"` line is server-rendered and empty, outside the bar
  (Vera § 3.1).

### 2.9 A walk that sends real hits sends real data

- The walk never lets a request reach Google. Playwright routes
  `**/*google-analytics.com/**` and `**/*analytics.google.com/**`, records
  each request's URL and body, then aborts it.
- `gtag.js` itself is fetched from `www.googletagmanager.com`, a free GET.
  If it will not load for a test ID, the walk needs the walk property's ID
  (q5).
- The recorded payloads are the "raw events" of AC-11 and AC-15. The walk
  greps them for the PII strings it typed, and for every key outside the
  two lists.

### 2.10 Development and the CSP

- `next dev` needs `'unsafe-eval'` for its refresh runtime. So
  `securityHeaders()` adds it in development only, and the unit test pins
  that production has none.
- A Vercel PREVIEW deployment's toolbar (`vercel.live`) is blocked by the
  production CSP. That is accepted, and recorded in R-55.
- `middleware.ts` runs on the edge runtime. It reads `SUPABASE_URL` from
  `process.env` directly, and imports nothing `server-only` and not
  `lib/env.ts` (S-A9).
- It sets RESPONSE headers: `const res = NextResponse.next();
  res.headers.set(…)`. Passing `headers` to `NextResponse.next()` would set
  request headers (S-A9).

### 2.11 A brand image on a foreign host meets `img-src` (S-A6)

- `logo_url`, `banner_url` and `assistant_avatar_url` accept any `https://`
  host (`schema-roles.sql:165-166`, `schema-assistant-avatar.sql:18`).
- The CSP's `img-src` allows `'self' data: blob:` and the Supabase origin.
  A tenant with a logo elsewhere would lose it, silently.
- Phase 0 runs a read-only query of the three columns' hosts for every
  tenant, through the Supabase server (read-only, plan q9) or `psql`,
  SELECT only.
  - **If every host is the Supabase origin**, which is the likely case
    (D-123 uploads there), the 46th file narrows the three checks to
    `^https://<project>.supabase.co/storage/v1/object/public/brand-images/`.
    Because the project host differs per environment, the check is written
    against the Storage path, not the host: `'^https://[^/[:space:]]+/storage/v1/object/public/brand-images/[^[:space:]]+$'`.
    The platform form shows the constraint's words.
  - **If a live row uses another host,** that host is listed in `img-src`
    deliberately, by name, and recorded in R-55. The check is not narrowed
    for that row's tenant.
- Either way, the CSP is the browser's enforcement.

---

## 3. The data model

`packages/db/sql/schema-analytics.sql` is the 46th file. It runs in one
transaction, is idempotent, and is re-run in order after the 45th (§ 2.6).
Every function has `set search_path = ''` and qualifies every name
(trap 19). Every refusal is `check_violation` (23514) in words, which
`fromPostgrest()` maps to a 400.

```sql
-- 1. The tenth key, and no row = OFF for analytics as for voice.
alter table public.tenant_features drop constraint if exists tenant_features_key;
alter table public.tenant_features add  constraint tenant_features_key check (feature in (
  'dashboard','conversations','unanswered','suggested_questions',
  'booking_page','manage_booking','calendar','notifications','voice','analytics'));
create or replace function public.tenant_feature_on(p_tenant_id bigint, p_feature text) returns boolean
language sql stable set search_path = '' as $$
  select coalesce((select f.enabled from public.tenant_features f
                   where f.tenant_id = p_tenant_id and f.feature = p_feature),
                  p_feature not in ('voice','analytics'))
$$;   -- grants as schema-voice.sql

-- 2. The measurement ID (FR-020). Public by nature (it is in every hit), but handed out only while on (step 5).
alter table public.tenants add column if not exists analytics_id text;
alter table public.tenants drop constraint if exists tenants_analytics_id_shape;
alter table public.tenants add  constraint tenants_analytics_id_shape
  check (analytics_id is null or analytics_id ~ '^G-[A-Z0-9]{6,12}$');   -- the length is Phase 0 row I's
create unique index if not exists tenants_analytics_id_unique
  on public.tenants (analytics_id) where analytics_id is not null;      -- the race guard
--    tenants BEFORE INSERT OR UPDATE OF analytics_id: another row holds it →
--      'That measurement ID is already set for another tenant. Each tenant has its own Google Analytics property.'
--    (the trigger gives the sentence; the index holds under a race, where fromPostgrest()'s 23505 is a 409
--     with platform.ts's generic words — accepted, two super users saving the same ID at the same instant)

-- 3. The written instruction (FR-028) and the gates on the switch.
alter table public.tenants add column if not exists analytics_instructed_on date;
alter table public.tenants add column if not exists analytics_since         timestamptz;
--    tenants BEFORE INSERT OR UPDATE OF analytics_instructed_on:
--      a date after today in the tenant's zone → 'The written instruction date cannot be in the future.'
--      (the zone: tenant_applications' bookings config timezone, else 'Asia/Manila' — assumption T-A1)
--    tenant_features BEFORE INSERT OR UPDATE, feature = 'analytics' and new.enabled:
--      no analytics_instructed_on → 'Record the resort''s written instruction on the Legal tab first.'
--      no analytics_id            → 'Set the Google Analytics measurement ID before switching analytics on.'
--    tenants BEFORE UPDATE OF analytics_id, analytics_instructed_on, while tenant_feature_on(id,'analytics'):
--      analytics_id to null            → 'Switch analytics off before removing its measurement ID.'
--      analytics_instructed_on to null → 'Switch analytics off before clearing the written instruction date.'
--    No exemption for service_role (unlike the DPA gate): a tool or a walk sets the date and the ID first.

-- 4. The first switch-on bumps policy_version (§ 2.7, FR-019, A-R5).
--    tenant_features AFTER INSERT OR UPDATE OF enabled, feature = 'analytics', new.enabled,
--    and the tenant's analytics_since is null:
--      numeric policy_version → (n + 1)::text, analytics_since = now(), in one UPDATE;
--      otherwise raise check_violation: 'Set the next policy version on the Legal tab before switching analytics on.'
--    security invoker: the super token can update tenants already (tenants_super_all, schema-roles.sql:185).

-- 5. tenant_public(), with analytics_id, NULL unless the switch is on (Rule 3, wall 2).
--    drop + create (the return type changes), the same body as the 44th file plus:
--      case when public.tenant_feature_on(t.id, 'analytics') then t.analytics_id end as analytics_id
--    still security definer, search_path = '', no archived tenant; grants re-applied.
--    analytics_instructed_on and analytics_since are NOT in it: they are between the platform and the resort.

-- 6. (Only if Phase 0's S-A6 query finds every brand image on Storage, § 2.11.)
--    tenants_brand_images: logo_url, banner_url and the avatar narrowed to the brand-images public path.
```

**Edits to older files (guards, trap 20).**
- **`schema-voice.sql`:** both statements are guarded on
  `tenants.analytics_id` existing, so a re-run is a no-op once the 46th has
  run.
- **`schema-welcome-text.sql`:** step 2 is guarded the same way.
- **`schema-audit-log.sql`:** in `audit_row()`, the `tenants` `v_keep` list
  gains `'analytics_id'`, `'analytics_instructed_on'` and
  `'analytics_since'`.
- After these edits, the 43rd, 44th, 45th and 46th files are re-applied in
  that order.

**What does not change:**
- No definer function and no new table.
- No new policy. The `tenant_features` policies are unchanged: super users
  write, and each tenant reads its own.
- The audit trigger already covers `tenant_features` (FR-025: "turned
  analytics on" by whom and when) and `tenants`.
- CLAUDE.md rule 8's lists do not grow.

---

## 4. The modules and the contracts

### 4.1 Server side (no new route)

- **`@rag/pipeline` tenant:** `TenantContext` gains `analyticsId: string |
  null`, from `tenant_public()`.
- **The platform route:** the existing `PATCH /api/platform/tenants/[id]`
  (`withPlatformRoute()`) gains two fields in `lib/schemas.ts`.
  - `analyticsId`: a string matching the shape, or null, trimmed and
    upper-cased.
  - `analyticsInstructedOn`: an ISO date, or null, validated like
    `dpaSignedOn`.
  - `platform.ts`'s `TENANT_COLUMNS` and the patch mapper gain both.
  - Every refusal of § 3 is a 400 carrying the trigger's words.
- **The switch:** the existing feature route (`features-panel.tsx`'s
  `send()`) is unchanged. Switching on without an ID or a date is the
  trigger's 400, shown in the panel's existing refusal toast.
- **`lib/features.ts`:** a tenth entry, `{ key: 'analytics', label:
  'Analytics', group: 'Guest pages', defaultOn: false, about: 'Counts visits
  on the chat, booking page and Manage booking with Google Analytics, after
  each guest allows it.' }` (Vera § 8). The key is in both lists (§ 3
  step 1), and `featureFlags({}).analytics === false`.
- **The three pages:** after every `notFound()`, each passes this to its
  Client Component:
  `analytics={nav.flags.analytics && tenant.analyticsId ? { id, slug, page, policyVersion } : null}`
  - `page` is `'chat' | 'book' | 'manage'`.
  - The prop is a plain object, never the context.
- **The privacy page:** passes the same prop to `AnalyticsChoice`, and
  `analytics: true` into `tenantPrivacy()`.
- **No API route sends or receives an analytics event** (FR-003: none is
  measured). Nothing in `app/api/**` changes for this, except the platform
  PATCH's schema.

### 4.2 `apps/web/lib/analytics.ts` (pure, browser-safe, tested)

```ts
export const ANALYTICS_CHOICE_DAYS = 180;           // Lex Q3.3, FR-008
export const ANALYTICS_RETENTION_MONTHS = 2;        // Lex Q3.4, FR-024; the property setting, § 6.2
export const GA_COOKIE_SECONDS = ANALYTICS_CHOICE_DAYS * 86_400;
export const ANALYTICS_ID_SHAPE = /^G-[A-Z0-9]{6,12}$/;   // the SQL check's twin (S-A8); a test pins both strings equal
export type MeasuredPage = 'chat' | 'book' | 'manage';
export type StepEvent = 'chat_started' | 'quote_shown' | 'request_sent' | 'stay_found';
export const PAGE_TITLE: Record<MeasuredPage, string> = { chat: 'Chat', book: 'Booking page', manage: 'Manage booking' };
export interface StoredChoice { choice: 'allow' | 'decline'; at: string; version: string; via: 'bar' | 'privacy' }
export function choiceKey(slug: string): string;                                   // 'analytics:<slug>'
export function readChoice(raw: string | null, version: string, now: Date): StoredChoice | null;  // expired / other version / malformed → null
export function privacySignal(nav: { globalPrivacyControl?: boolean; doNotTrack?: string | null }): boolean;
export function decide(stored: StoredChoice | null, signal: boolean, writable: boolean): 'load' | 'ask' | 'none';
export function measuredLocation(href: string, page: MeasuredPage): string;          // S-13: origin + path, nothing else
export function measuredReferrer(referrer: string, origin: string, previousPage: MeasuredPage | null): string;  // external → its origin; else our origin
export function cookiePrefix(slug: string): string;                                 // 'ga_' + slug, [a-z0-9_] only
export function cookieDomains(hostname: string): string[];                          // the host, then its parent (S-A4)
```

- `decide()` returns `'none'` for any signal, unless the stored choice is
  `via === 'privacy' && choice === 'allow'` and valid.
- `decide()` returns `'none'` for unwritable storage.
- Otherwise, `decide()` returns `'load'` for a valid allow, `'none'` for a
  valid decline, and `'ask'` for no valid choice.
- The caller clears the cookies on every result but `'load'` (Rule 6).

### 4.3 `apps/web/components/analytics.tsx` (Client)

- **`<AnalyticsRoot analytics={…|null}>`** is a context provider placed by
  each Client Screen. With `null`, or with an ID that fails
  `ANALYTICS_ID_SHAPE`, it renders its children and nothing else, and
  `track()` is a no-op.
- **`useAnalytics()`** returns `{ track(step: StepEvent): void }`, which is
  all a screen sees.
- **`<ConsentBar />`** is Vera § 3.1's markup exactly, with the polite
  status `<p>` as a sibling outside the section.
  - S-1 renders it inside `.composer`, after `.jump-down` and before
    `VoiceStatus`.
  - S-6 and S-13 render it as `<div class="consent-slot">` between
    `{header}` and `<main className="book-main" tabIndex={-1}>`, only when
    shown.
  - After an answer, focus goes to the input on S-1, and to `<main>` on S-6
    and S-13. It moves only if focus was on a bar button (Uma § 5.3).
- **`loadAnalytics(id, page, slug)`** runs once per document per ID (S-A7).
  The module flag holds the ID it configured.
  - **A first call:**
    - it sets `window.dataLayer` and `window.gtag`;
    - then it runs `gtag('js', new Date())` and `gtag('config', id,
      {…Rule 2})`;
    - then it appends the async script.
  - **A later measured-page mount with the SAME ID** (a `<Link>` within the
    tenant):
    - it clears `ga-disable-<id>`;
    - it updates `page_location`, `page_referrer` and `page_title` with
      `gtag('set', …)`;
    - it sends `gtag('event', 'page_view')` once (FR-015).
  - **A mount with a DIFFERENT ID** loads and sends nothing. No cross-tenant
    `<Link>` exists today, so a fresh document is the only way to measure
    the second tenant, and that is the intended behaviour.
  - **Unmount** sets `ga-disable-<id>`.
- **`analyticsLoaded(): boolean`** is the flag StaffFrame reads (Rule 4).
- **`clearAnalyticsCookies(slug)`** expires every cookie whose name starts
  with `cookiePrefix(slug)`, on path `/`, for each of
  `cookieDomains(location.hostname)` and host-only.
- **`<AnalyticsChoice />`** is the privacy section's control: the five
  states and "just changed" (Uma F-2, Vera § 6.2), including the
  GPC/DNT state with "Allow analytics anyway" (FR-027). It writes `via:
  'privacy'`. Decline also clears the cookies.

### 4.4 The screens' lines

- **`chat-screen.tsx`:** after `if (!sawDone) throw …`, if
  `firstTurnOfConversation`, it calls `track('chat_started')`. A `useRef`
  records the conversation id it fired for.
- **`booking-page.tsx`:**
  - `track('quote_shown')` the first time `quote.quote` becomes non-null
    (an effect with a ref);
  - `track('request_sent')` after `setSent()`.
- **`manage-booking.tsx`:** `track('stay_found')` after
  `setStay(body.stay)`, once per load.
- **`public-footer.tsx`'s "Staff login" and `tenant-nav.tsx`'s staff link:**
  `<a>`, not `<Link>` (Rule 4).
- **`staff-frame.tsx`:** the reload guard, the first effect of the
  component (Rule 4, S-A2). It is one line plus its comment, saying why a
  staff document must never hold a third-party script.

### 4.5 The privacy text (`lib/legal.ts`)

- `TenantLegalFacts` gains `analytics?: boolean`.
- **When true,** Lex Q3.5's five placeholder texts go in, as FR-019 lists
  them:
  - they name Google, the processing outside the Philippines, 180 days,
    the 2-month retention, that aggregates are kept, the consent basis, and
    GPC/DNT;
  - they are built from the constants and `businessName`, never retyped;
  - they are a lawyer's to replace (R-60);
  - the five places:
    - "What is collected" replaces line 95's sentence;
    - "Why it is used" gains a paragraph;
    - "Who it is shared with" gains the Google line before "Nobody else";
    - "How long it is kept" gains the line;
    - a new section, "Your analytics choice", is added with `id:
      'analytics'`, after "How long it is kept".
- **When false,** line 95 stays word for word (AC-19). A test pins both
  states, and pins the analytics paragraphs (§ 2.7).
- **The control:** `LegalSection` gains an optional `id`, which `LegalBody`
  renders on the section's `h2`. The privacy page passes a `controls` map,
  `{ analytics: <AnalyticsChoice …/> }`, which `LegalBody` draws after that
  section's paragraphs. This is Uma's R-U7 (M-012 point 3): feasible, and
  the page stays a Server Component.
- **`platformPrivacy()` is unchanged.** "This landing page … uses no
  analytics" stays true (Q5).

### 4.6 The platform form

- **The Legal tab** gains "Written instruction to use analytics", a
  `DateField` (D-143). It is shown and saved like the DPA date (D-130), and
  explained in one line under the field.
- **The Features tab's Analytics row** (Vera § 8) gains one field under it:
  "Google Analytics measurement ID", a native text input with its own Save
  button. Save PATCHes the tenant; the switch beside it still saves at once
  (D-V2).
- **The switch is `disabled`** when either the instruction date or the ID
  is missing. The visible sentence (D-102: text, no `title`) is the server's
  words for whichever comes first in W-4's order:
  1. "Record the resort's written instruction on the Legal tab first."
  2. "Set the measurement ID first."
- **Activity rows:** `activityWords` gains:
  - "turned Analytics on/off" (the feature row);
  - "changed the Analytics measurement ID";
  - "set/cleared the analytics instruction date";
  - the `tenants` columns' labels in `activity-words.ts` (FR-025, AC-24).

### 4.7 The headers (`lib/csp.ts`, `apps/web/middleware.ts`)

```
base (every path):
  default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline';
  img-src 'self' data: blob: <SUPABASE_URL origin> [+ any brand host Phase 0 lists, § 2.11];
  connect-src 'self'; media-src 'self' blob:; frame-src 'self' blob: <SUPABASE_URL origin>;
  font-src 'self'; worker-src 'self'; manifest-src 'self'; object-src 'none';
  base-uri 'self'; form-action 'self'; frame-ancestors 'none'
measured paths (^/t/[^/]+(/book|/manage)?/?$) add:
  script-src https://www.googletagmanager.com
  connect-src https://*.google-analytics.com https://*.analytics.google.com https://*.googletagmanager.com
  img-src     https://*.google-analytics.com https://*.googletagmanager.com      [the hosts: Phase 0 row G]
development adds script-src 'unsafe-eval' (§ 2.10).
```

- **`frame-src 'self' blob: <Supabase origin>`** (S-A1) is for
  `proof-viewer.tsx:59`:
  - a PDF proof is an `<iframe>` of a `blob:` URL on S-13;
  - on the staff review drawer it is a 5-minute signed Supabase URL
    (`payment-review.ts:174`).
  - It is in the BASE policy because S-14 and S-15 are staff pages.
  - Phase 5 also confirms that Storage's own response allows being framed.
    If it does not, that is a finding for Sage, and the CSP is not
    loosened to hide it.
- **`'unsafe-inline'` in `script-src`:** Next's App Router writes inline RSC
  scripts, and without a nonce they need it. This CSP still walls off every
  foreign script host and every foreign connect destination. It does not
  stop an injected inline script (S-A5), which is why R-55 stays open for
  the nonce plan.
- **Recorded for the nonce plan, from S-A5:** with `'strict-dynamic'` and a
  nonce, keep `www.googletagmanager.com` OUT of `script-src`. An allowlisted
  GTM host lets any container ID load, a known bypass. Load gtag.js from the
  nonce'd loader instead.
- **`'unsafe-inline'` in `style-src`:** R-55's note was wrong on this
  point. An inline `style` ATTRIBUTE in server-rendered HTML (the tenant
  theme's custom properties, D-030) is blocked by a CSP without it **[to
  confirm in Phase 5's browser run]**.
- **The middleware matcher** excludes `_next/static`, `_next/image` and
  `favicon.ico`.
- **The table test:** `securityHeaders()` is pure and table-tested on:
  - the measured shapes: `/t/villa`, `/t/villa/`, `/t/villa/book`,
    `/t/villa/manage` and `/t/villa/manage/`;
  - unmeasured pages: `/t/villa/admin`, `/t/villa/admin/payments`,
    `/t/villa/privacy`, `/t/villa/book/x` and `/t/villa%2Fadmin` (S-A9,
    not measured);
  - outside a tenant: `/platform`, `/`, `/api/t/villa/chat` and
    `/t/villa/sw.js`.
  - It also pins that every one carries `frame-src` with `blob:` (S-A1).
- **First deploy (S-A9):** the enforced headers ship, PLUS the same CSP as
  `Content-Security-Policy-Report-Only` for the first deploy. There is no
  report endpoint, which would be a new open route to rate-limit.
  Violations are read from the browser console in the Phase 5 walk.
- **The service worker's own scope:** `worker-src 'self'` covers
  `/t/<slug>/sw.js`.

---

## 5. Phases

Each phase ends with its checks green, and is recorded in `status.md` and
`whats-done.md` (the house's way). The branch is `feat/analytics`, from a
clean `master`.

### Phase 0: Baseline, the vendor read, the brand hosts

- **Record the baselines:**
  - web tests and typecheck;
  - verify 243 and rooms 57;
  - the three chatbot baselines, diffed with `--strip-trailing-cr`.
- **What cannot run:** pipeline and bookings isolation cannot run
  (northwind and harbor are deleted), and that is recorded as such. The
  battery is not run (Rule 8: the chatbot is untouched).
- **The vendor read** (§ 2.1, rows A–K): Google's own pages, read in a
  browser at no cost. Each row is recorded as confirmed or wrong, with its
  URL, in `plan/analytics/phase0.md`.
  - Row H (history page views) and row D (the toggles) decide whether
    Rule 9's settings are a belt or the only brace. If H says
    `document.location` is read on a history change, that goes to Sage and
    Rhea before Phase 3, because S-6's `?ref=` `<Link>` is then a leak
    vector that only the property setting stops.
- **The brand hosts (S-A6):** a read-only SELECT of `logo_url`,
  `banner_url` and `assistant_avatar_url` hosts across every tenant. The
  result is recorded in the same file, and decides § 2.11's branch.
- **The dependency bump is NOT here** (the user at gate 5, 2026-10-28: "dependency upgrade as its own task"): it is idea `deps-upgrade` (§ 9). Phase 0 starts after it is done, so every phase tests on the bumped versions.
- **Check:**
  - every row has a source, and a wrong fact goes to its FR's owner, with
    the phases after it waiting;
  - `pnpm audit --prod` shows no critical, and every high left is named
    with a reason.

### Phase 1: SQL (`schema-analytics.sql` and the three guards)

- Apply it the record's way: Claude on `DATABASE_URL`, then 43 → 46 in
  order.
- verify gains 244–254:
  - **244:** with no row, `tenant_feature_on(villa,'analytics')` is false,
    and voice is still false with no row.
  - **245:** a bad ID shape is refused (23514), and a good one is stored
    upper-case.
  - **246:** switching on with no ID is refused in the trigger's words, and
    so is clearing the ID while on.
  - **247:** wall 2 alone: with the ID set and the switch off, an anon or
    chat `tenant_public('villa')` gives `analytics_id` null. The positive
    twin is the switch on, which gives the ID.
  - **248:** the FIRST switch-on bumps a numeric `policy_version` by one and
    stamps `analytics_since`. Off, then on again, leaves the version where
    it was (A-R5). A non-numeric version refuses the first switch-on.
  - **249:** a staff token, a chat token and the anon key each cannot write
    `tenant_features` or the analytics columns (Sage's wall row).
  - **250:** the audit rows: the feature row, the ID, the instruction date
    and the version each write one, with the actor (AC-24).
  - **251:** switching on with no instruction date is refused in words.
    With the date, and the ID, it succeeds (AC-30).
  - **252:** clearing the date while on is refused, and a date after today
    in the tenant's zone is refused (AC-31).
  - **253:** an ID another tenant holds is refused in words (AC-20).
  - **254** (only if § 2.11 narrowed the checks): a brand URL outside the
    bucket path is refused, and every live row still passes.
- The test tenant is restored by ids (trap 26): the version, the ID, the
  date, `analytics_since` and the row.
- **Check:** verify 254 (or 253), rooms 57.

### Phase 2: The pure module and the headers function

- **`lib/analytics.ts` and `lib/analytics.test.ts`:**
  - `readChoice`: 179 and 181 days, for an allow AND a decline (AC-26); the
    other version (AC-27); malformed JSON;
  - `decide`: every combination of the three inputs, including GPC with a
    `via: 'bar'` allow (no load) and with a `via: 'privacy'` allow (load);
  - `measuredLocation`: AC-12's URL gives exactly the path; AC-13's keeps
    two `utm_*` and drops `foo` and `#z`; a repeated `utm` key gives the
    first value;
  - `measuredReferrer`: AC-14's two cases, plus `''` and a malformed URL;
  - `cookiePrefix` on odd slugs, and `cookieDomains` on `localhost`, a
    two-label host and a three-label host;
  - `ANALYTICS_ID_SHAPE`: its `source` equals the SQL check's pattern, read
    from the 46th file.
- **`lib/csp.ts` and `lib/csp.test.ts`:** § 4.7's table, `frame-src` on
  every row, and production with no `unsafe-eval`.
- **`features.ts`** gains its tenth entry, and its test pins
  `featureFlags({}).analytics === false`.
- **`legal.ts`** gains the analytics text. Its test pins:
  - line 95 when off;
  - the five texts when on, with FR-019's facts (180, 2, Google, outside
    the Philippines, GPC);
  - the pin with § 2.7's message.
- **Check:** web tests and typecheck.

### Phase 3: The client module, the bar, the four steps, the privacy control, the staff guard

- Build § 4.3–4.5 and § 4.4's StaffFrame line.
- **Component tests on a fake `window`:**
  - wall 1 alone: the flag is off and an ID is passed, and nothing renders
    and no script is appended;
  - a malformed ID: nothing loads (S-A8);
  - `track()` with no gtag is a no-op;
  - a second mount with the same ID loads no second script;
  - two IDs in one window give ONE `config` call (S-A7);
  - unmount sets `ga-disable`;
  - every non-load decision calls the cookie clear (S-A4).
- **StaffFrame (S-A2):** with `analyticsLoaded()` true, it calls a stubbed
  `location.reload` once. With it false, the stub is never called.
- **The chat:** `chat_started` fires once per conversation. A fake stream
  with two turns, then New chat, gives 2.
- **The staff links are `<a>`.** A test greps every file under
  `apps/web/components` and `apps/web/app/t` for a `<Link` or
  `router.push` whose target contains `/admin` and that a guest page
  renders. The StaffFrame guard is the wall; the grep is the early warning.
- **Vera's CSS** goes into `screens.css` and `chat.css`: the 760 selector
  list, the `.book-main` rule and `.book-main:focus`. No literal, no dark
  rule.

### Phase 4: The platform form, and TenantContext

- Build § 4.1, § 4.6 and the activity words.
- `plan/tenant-management-phase4-walk.mjs` gains five checks:
  - the PATCH shapes (ID and date);
  - switching on without the date gives 400 in words, and so does switching
    on without the ID;
  - another tenant's ID gives 400 in words;
  - date, ID, on, off give four Activity rows (AC-24).
- It runs on a throwaway tenant, made and removed by id.

### Phase 5: The headers on every page

- Apply `middleware.ts`.
- **`plan/csp-walk.mjs`** (new) opens, in Chromium, each page the a11y
  walks already list (`plan/ui-refresh-a11y.mjs`'s states).
  - **S-A1:** it also opens:
    - S-13 with a PDF chosen as a proof, the preview drawn;
    - S-15's review drawer with a PDF proof, the signed frame drawn.
  - **S-A6:** a tenant with a logo and a banner (`public-brand-a11y.mjs`'s
    throwaway tenant), drawn under the CSP.
  - It collects every `securitypolicyviolation` event and every console CSP
    error, including the Report-Only header's. **Expect 0.**
- **It also reads each response's headers**, and expects:
  - Google's hosts on the three measured shapes only;
  - `frame-ancestors 'none'` and `frame-src` everywhere.
- The existing a11y walks stay at 0 violations.
- **Check:** the walk's count, recorded. R-55's style-attribute note is
  confirmed or corrected from the run, and so is whether Storage's response
  can be framed.

### Phase 6: The analytics walk (the network is the evidence)

`plan/analytics-walk.mjs` runs against `pnpm dev`, on villa (and alteza for
check 5), with the walk property's ID or throwaway IDs (q5).
- Google's collect endpoints are intercepted and aborted (§ 2.9).
- Each tenant's flag, ID, instruction date, `policy_version` and
  `analytics_since` are restored by id at the end.

Its checks, numbered by AC:

1. **AC-01, AC-05.** The switch is off. S-1, S-6 and S-13 make 0 requests
   to Google hosts, and no `ga_villa*` cookie is set.
2. **AC-06, AC-32.** The switch is on, in a fresh profile. Before an answer
   there are 0 Google requests and no cookie.
3. **AC-07.** Decline, then chat, quote, request and lookup: all succeed,
   with 0 Google requests.
4. **AC-08, AC-25.** With the bar unanswered, the chat, the form and the
   lookup are completed by keyboard alone. The two buttons' boxes are
   equal. The bar's text with "Villa Esperanza" is ≤ 130 characters and
   links to `/t/villa/privacy#analytics`.
5. **AC-09, AC-21.**
   - (a) Allow on villa; then alteza (switch on, its own ID) shows its own
     bar.
   - (b) Every intercepted hit from villa's pages carries villa's ID only,
     and alteza's carry alteza's only.
   - (c) Decline on villa's privacy page. The next villa load sends 0, and
     `context.cookies()` holds no `ga_villa*` cookie on any domain (S-A4).
6. **AC-10.** The D-129 box is unticked and required after Allow.
7. **AC-11, AC-15.** A chat with a name, a mobile number and an email; a
   request with a promo code and a note; a lookup by reference.
   - No intercepted payload contains those strings, a reference, a uuid or
     a peso amount.
   - Every key is in FR-014's list 1 or list 2.
   - A key in neither fails the check, and its name goes to Rhea.
8. **AC-12, AC-13, AC-14, S-A3.** The `dl` and `dr` of the hits, as
   specified, PLUS S-6 → its real `<Link>` to `/t/villa/manage?ref=<ref>`.
   No intercepted `dl` or `dr` contains the reference, `ref=` or a path
   other than the measured one.
9. **AC-16, AC-17, S-A9.**
   - One `page_view` per load, and exactly one on S-13 after S-6's
     `<Link>`.
   - `chat_started` is 1 on the first message, then 0.
   - A first message answered 429 (a fresh `X-Forwarded-For`, 31 turns:
     D-137) gives 0, then a success gives 1.
   - A 409 gives no `request_sent`; a lookup miss no `stay_found`, a hit 1.
10. **AC-18.** Google is blocked (the routes fail). The chat, quote, request
    and lookup give the same results as with the switch off, and no error is
    drawn.
11. **AC-03, § 2.3, S-A2.**
    - (a) After Allow, follow privacy (`<Link>`) → back → Staff login. There
      are 0 hits after leaving S-1, and the admin document has no
      `googletagmanager` script.
    - (b) From S-1 with analytics loaded, `router.push('/t/villa/admin')`
      through the page's own Next router (`window.next.router`, dev only):
      the page reloads, and the admin document has no `googletagmanager`
      script.
12. **AC-04.** `/t/no-such`, an archived tenant, and `/book` with
    `booking_page` off: each 404, with 0 Google requests.
13. **AC-29, S-A4.**
    - A context with `globalPrivacyControl`, and a second with DNT = 1:
      there is no bar and 0 requests.
    - Privacy says the signal turned analytics off. "Allow analytics
      anyway" loads on the next S-1.
    - With an Allow and a cookie set, turning GPC on gives the next load
      `'none'`, and no `ga_villa*` cookie is left.
14. **AC-26, AC-27, AC-28.**
    - An allow stored 181 days ago gives the bar and 0 requests; 179 days
      gives no bar and a load.
    - The `ga_villa*` cookie's expiry is ≤ 180 days from when it was set.
    - Bumping villa's version shows the bar, with 0 requests before an
      answer, and clears the cookie.
    - Villa's first switch-on changed its version (read before and after);
      off, then on again, did not.
15. **AC-19, AC-23.** Villa's privacy page names Google, says the data is
    processed outside the Philippines, states 180 days and 2 months, says
    aggregates are kept, and mentions GPC/DNT. Alteza's (switch off) keeps
    line 95 word for word.
16. **Vera § 9.7.**
    - `.consent-bar` height at 375×667 in a touch context, on S-1, with
      villa's and alteza's names, recorded (pass ≤ 120 px).
    - Horizontal scroll at 320 and at 200 % zoom.
    - Axe over the bar on S-1, S-6 and S-13 × light, dark and pinned light,
      and over the privacy control's states: 0 violations.

Then, beside the walk:
- verify 254, rooms 57, web tests and typecheck;
- the three baselines byte-identical;
- the `.next/static` grep (CLAUDE.md rule 2).

### Phase 7: The record

- **D-151** is amended from "proposed" to what was built.
- **Risks:**
  - R-55 is **amended, not closed** (S-A5, M-021 q4). It records:
    - what shipped;
    - the nonce step left;
    - the GTM-host note for that plan;
    - GA as an exfiltration channel on the three pages.
  - R-63 is amended with Phase 0's findings and S-A10's residual (gtag.js
    reads the DOM; contractual, not technical).
  - R-60 notes the analytics placeholders.
  - R-61 gains the § 6.2 checklist, one filled row per property (Rule 9).
- **CLAUDE.md:**
  - the header paragraph;
  - 46 SQL files, and verify 254;
  - the layout lines (`lib/analytics.ts`, `components/analytics.tsx`,
    `lib/csp.ts`, `middleware.ts`);
  - the features list (ten);
  - StaffFrame's guard as a convention: "a staff screen never shares a
    document with a third-party script".
- **`status.md` and `whats-done.md`.**
- **Owed after the record, by the user:**
  - creating the properties and the grants, following § 6.2;
  - Google's terms;
  - a lawyer's reading (Lex § 6, LQ-1–LQ-9).
- **No real guest is measured before these are done** (BR-7, Lex § 5).

---

## 6. What must not change

### 6.1 The product

- **The chatbot:** no prompt text, no tool text, and no `dates.ts` or
  `language.ts` line. The three baselines are byte-identical.
- **S-11 and the Pulse strip:** no figure added and no source changed
  (FR-023).
- **The D-129 booking consent box:** its words, place and requirement are
  unchanged (FR-009).
- **Unchanged words:** the voice notice and the chat's fine print keep
  their words, and so do `/`, `/privacy` and `/terms`.
- **The tenant privacy page with the switch off:** word for word.
- **S-13's `?ref=` behaviour:** unchanged (Rhea D-1).
- **Security:** no `service_role` in a request, no new definer function,
  and no new policy.
- **Every staff page and `/platform`:** no analytics code, no Google host
  in their CSP, and never a document that held gtag.js.
- **The proof viewer:** it draws a PDF exactly as before, under the CSP.

### 6.2 The GA property checklist (the user, by hand, per tenant, before its switch goes on)

For each tenant's property **[every setting name unverified, Phase 0]**:

- in the user's GA account (M-021 q1);
- the time zone is the tenant's (Asia/Manila for villa and alteza today);
- data retention 2 months;
- Google signals OFF;
- ads personalisation OFF;
- every data-sharing setting OFF;
- every enhanced-measurement toggle OFF: page changes on history events,
  scrolls, outbound clicks, site search, form interactions, video and file
  downloads;
- granular location and device data collection OFF;
- user-provided data collection OFF;
- Google's GA data processing terms accepted (Lex M-009 point 6);
- the owner is a **Viewer** on this property only. Nobody but the account
  holder has Editor or above (Rule 9);
- no other property or product linked.

**The record:** each property's row goes in R-61 with the date and who set
it (Rule 9). Then the super user records the instruction date and the
measurement ID on the platform form, and switches it on (W-4).

---

## 7. Questions, each with a recommendation

### Answered (M-021, M-023)

1. **Where the properties live:** one per tenant in the user's GA account,
   with owners Viewer on their own only (M-021). It is built as Rule 9.
2. **Lex's written-instruction rule:** Rhea adopted it as FR-028 (A-16),
   and it is built (§ 3 step 3, § 4.6).
3. **The [if FR] items** (180 days, the version re-ask, GPC/DNT): Rhea
   wrote them as FR-008, FR-026 and FR-027, and they are built (Rule 6).
4. **The CSP:** a host allowlist now, with the nonce open in R-55 (M-021).
   It is built as § 4.7.

### Still open, each with a default that stands if unanswered

5. **The walk's measurement ID.** **Recommend** a separate GA4 property
   named for the walk, in the user's account, never a tenant's. The walk
   aborts every hit anyway (§ 2.9). It is needed only if `gtag.js` refuses
   to load for a made-up ID, which Phase 0 finds out.
6. **Staff testing the public pages inflate the counts (Q7 = no).** Nothing
   is built. Staff can decline the bar like anyone. It is recorded as a
   known inflation in R-63.
7. **The 319 px breakpoint (Vera § 3.2).** **Keep it.** It is Uma's "below
   320 px, one per row" rule (UX § 8.7), and it costs one line.
8. **Q10, Q11** are Rhea's, with her defaults: `?ref=` stays (D-1), and no
   DPA precondition in v1 (A-R4). The plan builds nothing for either.

### Assumptions I made instead of asking (the user re-reads them here)

- **T-A1 · The tenant's zone:** "today in the tenant's zone" (FR-028) uses
  the bookings config's `timezone`, else `Asia/Manila`. A tenant without
  bookings has no zone of its own, and Asia/Manila is every tenant's today.
- **T-A2 · No exemption for tools:** the analytics gates have no
  `service_role` exemption, unlike the DPA gate (D-130). A walk sets the
  date and the ID first, then restores them by id. A gate that tools skip
  is a gate the walks do not test.
- **T-A3 · Text changes are bumped by hand:** a change to the analytics
  text is a Legal-tab bump, as today, guarded by the `legal.test.ts` pin
  rather than by SQL. The text lives in code, and SQL cannot see it change.
- **T-A4 · A concurrent duplicate ID:** two super users saving the same ID
  at the same instant get the unique index's generic 409, not the
  trigger's sentence. Accepted.
- **T-A5 · (superseded at gate 5: the bump is `deps-upgrade`, its own task) The dependency bump is Phase 0's:** Sage's audit finding (§ 9)
  is outside this feature, but Finn builds this plan next and the walks
  need the bumped versions, so it is done here once, not as a separate
  task.
- **T-A6 · The brand-image check:** if § 2.11 narrows it, it is written
  against the Storage path, not the project host. Staging and production
  have different hosts, and the CSP holds the host.

---

## 8. Round 2: what changed, and why

### 8.1 Every concern in `docs/security/analytics.md`

| Id | Sev. | Concern | Answer | Phase step | Check |
|---|---|---|---|---|---|
| S-A1 | MEDIUM | The base CSP has no `frame-src`, so the PDF proof iframe breaks on S-13 and on staff review | **Adopted.** `frame-src 'self' blob: <Supabase origin>` in the BASE policy (§ 4.7) | Phase 2 (`csp.ts`), Phase 5 (the walk opens both PDF proofs) | `csp.test.ts` pins `frame-src` on every row. `csp-walk.mjs` draws S-13's and S-15's PDF frames with 0 violations, and records whether Storage allows framing |
| S-A2 | MEDIUM | The wall between gtag.js and staff screens is two hand-edited links | **Adopted.** StaffFrame reloads a document that held analytics (Rule 4, § 4.4). The two `<a>` changes stay, and the link grep widens to every guest-rendered file | Phase 3 | The StaffFrame unit test (reload stubbed: once / never). Walk check 11a, and 11b (`router.push`) |
| S-A3 | MEDIUM | FR-011/013/014 rest partly on per-property settings outside the code and the walk; `?ref=` on S-6 → S-13 | **Adopted, in four parts.** (1) Viewer only, never Editor, as Rule 9. (2) Phase 0 row H. (3) The R-61 checklist per property, dated, before its switch (§ 6.2). (4) R-U5 was passed to Rhea and DECLINED (D-1, Q10), so the plan does not drop `?ref=`; the leak is closed by `page_location` and walk check 8 | Phase 0 (row H), Phase 6 (check 8), Phase 7 (R-61) | Phase 0's row H with its source. Walk check 8 follows S-6's real `?ref=` `<Link>`, and no `dl`/`dr` holds the reference. R-61 has a filled row per property |
| S-A4 | LOW | Decline does not reliably delete GA's cookies; expiry, version and GPC leave them | **Adopted.** `cookie_domain: 'none'`, `cookie_update: false`, and the clear on EVERY non-load decision, on the host and the parent (Rule 6, § 2.5, § 4.2) | Phase 2 (`cookieDomains`), Phase 3 (the clear on each decision) | The component test (every non-load decision clears). Walk checks 5c, 13 and 14 read `context.cookies()`: no `ga_villa*` cookie is left |
| S-A5 | LOW | `'unsafe-inline'` scripts, and GA as an exfiltration channel; R-55 must stay open | **Adopted.** R-55 is amended, not closed. The GTM-host note is recorded for the nonce plan (§ 4.7) | Phase 7 | R-55's text after Phase 7 names the nonce step, the GTM note and the channel |
| S-A6 | LOW | `img-src` versus brand image URLs on any https host | **Adopted.** A read-only query first. Then narrow the checks to the bucket path, or list a foreign host by name (§ 2.11, § 3 step 6) | Phase 0 (query), Phase 1 (verify 254 if narrowed), Phase 5 | The query's result in `phase0.md`. `csp-walk.mjs` draws the logo tenant with 0 violations |
| S-A7 | LOW | One document must never configure two tenants' IDs | **Adopted.** The loader is keyed on the ID; a different ID loads nothing (Rule 4, § 4.3) | Phase 3 | The component test: two IDs in one window give ONE `config` |
| S-A8 | INFO | Validate the ID on the client too | **Adopted.** `ANALYTICS_ID_SHAPE`, the URL built with `URLSearchParams` (Rule 1, § 4.2) | Phase 2, Phase 3 | The pin that the regex equals the SQL check. The malformed-ID component test |
| S-A9 | INFO | Implementation notes for § 4.7 | **Adopted, each:** response headers, not request headers (§ 2.10); edge runtime with no `env.ts` (§ 2.10); HSTS without `preload`, and camera, geolocation and payment denied (Rule 8); `%2F` and trailing slashes in the table (§ 4.7); Report-Only on the first deploy with no report route (§ 4.7); the S-6 → S-13 cleanup order (walk check 9) | Phases 2, 5, 6 | `csp.test.ts`'s rows. Walk check 9 has exactly one `page_view` on S-13 |
| S-A10 | INFO | "Nothing in reach of the module" is true of ours, not of gtag.js | **Adopted.** Stated in Rule 2, and recorded in R-63 at Phase 7. Lex reads it at gate 7 for the privacy text | Phase 7 | R-63's text |
| — | (outside) | `pnpm audit --prod`: next 15.5.25 critical GHSA-2464-fhr4-w9xw; highs in next, sharp and zod | **Adopted**, then moved by the user at gate 5 to its own task `deps-upgrade` (§ 9) | Phase 0 | `pnpm audit --prod` with no critical, and every remaining high named with a reason |
| — | (wall row) | verify 249 should try the anon key too | **Adopted** | Phase 1 | verify 249 |

**Nothing was declined.**

### 8.2 Rhea's amendments (`docs/requirements/analytics.md` § 12)

| A-n | FR | What the plan now does |
|---|---|---|
| A-3 | FR-002 | No change: three pages only was already the plan (Q5 = no) |
| A-4 | FR-007, AC-25 | The bar's placeholder words are Rhea's (≤ 130 characters). Walk check 4 counts them, and check 16 measures the height |
| A-5 | FR-008, AC-26 | Both choices last 180 days. `cookie_update: false` makes the cookie end 180 days after it was set. Decline, and every other non-load decision, clears the cookies. Walk check 14 |
| A-6 | FR-013, AC-14 | Our origin for internal referrers, as round 1 proposed. § 1.1 now says "yes" |
| A-7 | FR-014, AC-15 | Walk check 7 judges against list 1 and list 2. A field in neither fails, and goes to Rhea |
| A-8 | FR-019, AC-19, AC-23, AC-28 | **Changed:** the version is bumped on the FIRST switch-on (`analytics_since`), not on every flip (§ 2.7, verify 248). A text change is the Legal tab's bump, pinned by `legal.test.ts`. The privacy text carries FR-019's facts (§ 4.5) |
| A-9 | FR-020, AC-20 | **New:** an ID already set for another tenant is refused, by a unique index and a trigger in words (§ 3 step 2, verify 253) |
| A-10 | FR-021 | Each property's time zone is the tenant's, in the § 6.2 checklist |
| A-11 | FR-022, AC-21 | One property per tenant. Walk check 5b proves it from the request bodies |
| A-12 | FR-024, AC-23 | 2 months stated from the one constant, and aggregates said to be kept |
| A-13 | FR-025, AC-24 | The ID and the instruction date are logged too (the audit allowlist, the activity words, verify 250, Phase 4's walk) |
| A-14 | FR-026, AC-27 | Rule 6, and walk check 14 |
| A-15 | FR-027, AC-29 | Rule 6, `AnalyticsChoice`'s signal state, and walk check 13 with GPC and DNT |
| A-16 | FR-028, AC-30, AC-31 | **New:** `analytics_instructed_on`, its three refusals (§ 3 step 3), the Legal tab field and the disabled switch's sentence (§ 4.6), verify 251–252, and Phase 4's walk |
| A-17 | BR-7, BR-9, BR-10 | BR-7: Phase 7's "no real guest before". BR-9 and BR-10 bind the operator and the DPA, not code: nothing is built for them. BR-10's settings are § 6.2's checklist |
| A-21 | Q10 (R-U5 declined) | The plan's out-of-scope line now cites D-1. S-A3's part 4 is answered by `page_location` and walk check 8 |
| A-1, A-2, A-18, A-19, A-20, A-22 | records, roles, stories, ACs, edges, dependencies | Read. They are covered by the rows above. Edge case 18 is A-8's row |

### 8.3 Other changes

- Rule 9 is new, and the rule count is nine.
- § 7's answered questions are moved to their own list, and the
  assumptions T-A1–T-A6 are new.
- Verify grows to 254, from 250.

---

## 9. Outside the feature: the dependency bump, its own task (`deps-upgrade`)

Sage's `pnpm audit --prod` (2026-10-28) found:
- **next 15.5.25:** GHSA-2464-fhr4-w9xw, critical, fixed in 15.5.28. Also
  GHSA-p3m5-59mp-jv5r (high), and two moderates.
- **sharp 0.35.4:** GHSA-wq5f-xc86-pv6w, high. `app-icon.png` runs sharp
  on a tenant's logo.
- **zod 3.25.76:** GHSA-mrhx-c7xc-m3w5, high.
- **postcss and source-map-js:** build-time only.

Sage did not assess exploitability, and neither did I. The bump is cheap
and comes before any public URL. The user made it its own short-lane item at gate 5 (2026-10-28), done BEFORE this plan's Phase 0.
After the bump:
- the build and the tests re-run;
- `pnpm audit --prod` is re-run and its count recorded;
- a high that cannot be bumped is named in R-61 with its reason.
