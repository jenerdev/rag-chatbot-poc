# Analytics on the public pages: functional requirements (gate 2)

- **Idea:** `analytics`, full lane. Gate 1 was APPROVE with six constraints (`docs/product/analytics.md` § 8); those constraints are part of these requirements, cited as **C1–C6**.
- **Task:** T-003, from Ivy (M-003).
- **Written by:** Rhea, Product Requirements Analyst, 2026-10-28.
- **Gate 2:** **APPROVED** by the user 2026-10-28 (M-007: "A, default for the rest, approve").
- **Amended after gate 2:** 2026-10-28, from M-007, M-008, M-011, M-015, M-016 and M-022. **§ 12 lists every change** with its FR id and source message. No new gate was recorded: the user re-reads these amendments at gate 5. Amended text is marked **(amended, A-n)** in place; new requirements are **(new, A-n)**.
- **Status of the feature:** **Planned.** Nothing here is built. What IS built is `whats-done.md` (Rule 2).
- **Spent:** nothing (Rule 7). No vendor documentation was read (Context7 skipped by the user, M-022). Every GA4 fact below stays **[unverified]** until Theo's Phase 0 read (R-63); where a requirement names one, it says so, and a fact found wrong is a message to Rhea, never a relaxed FR.
- **Read:** `docs/product/analytics.md`; `apps/web/lib/features.ts` (D-127, D-134's `defaultOn: false`); `apps/web/lib/legal.ts` (the privacy texts); `apps/web/app/t/[tenant]/manage/page.tsx` (S-13's `?ref=`); `plan/legal.md` § 0; `risks.md` R-50, R-55, R-60; CLAUDE.md (D-098, D-127, D-131, D-134, D-137, D-138). After gate 2: `docs/legal/analytics.md` (Lex), `docs/ux/analytics.md` (Uma), `docs/design/analytics.md` § 5 (Vera), `plan/analytics.md` §§ 1, 7 (Theo); `decisions.md` D-130.

**Words used here:**
- **Measured page:** a page on which measurement may run (FR-analytics-002).
- **Measurement:** whatever records a visit or a step. The user chose **GA4** (Q1 = A); the FRs stay worded for "the recipient" so that they are testable without a vendor's vocabulary.
- **Recipient:** whoever receives the measured data: **Google**, through the tenant's own GA4 property (FR-analytics-020, 022).
- **Event:** one recorded fact: a page view or a named funnel step (§ 3.4).
- **Stored choice:** the guest's Allow or Decline kept on the device for one tenant, with its time and the tenant's policy version (FR-analytics-008, 026).

---

## 1. Product and feature overview

Today S-11 (the dashboard, D-098) counts only guests who already acted: chats, refusals, stays by source. Nobody can see **how many people opened** the chat (S-1), the booking page (S-6) or Manage booking (S-13), **where they came from**, or **how many went on** to chat, see a price and send a request.

This feature records visits and a short funnel on those three public pages, per tenant, switched on per tenant by a super user **on the tenant's recorded written instruction** (FR-analytics-028), with nothing a guest typed or owns ever recorded. **The means is Google Analytics 4** (Q1 = A, the user, M-007), **one GA4 property per tenant** (M-022). Owners read their own numbers in GA4's own reports (Q2, M-022). *(amended, A-2)*

**Out of scope:** every staff page (`/t/<slug>/admin/**`, S-2–S-5, S-7–S-11, S-14–S-18), `/platform` and its reset page, `/t/<slug>/admin/reset`, the service worker, manifest and icon routes, and re-counting anything Postgres already counts (C6). The landing page `/`, `/privacy`, `/terms`, `/t/<slug>/privacy` and `/t/<slug>/terms` are **out** (Q5 = default no, M-007). *(amended, A-3)*

## 2. User roles and permissions

*(amended, A-2)*

| Role | What this feature lets them do | What it never lets them do |
|---|---|---|
| **Guest** (anonymous visitor on S-1, S-6, S-13) | Allow or decline measurement (FR-analytics-006); change that choice later on the tenant's privacy page (FR-analytics-008); allow it explicitly despite a GPC/DNT signal (FR-analytics-027); use every page fully either way | Be identified: no name, contact, reference or chat text leaves for Google (FR-analytics-010–013) |
| **Super user** (`platform_admins`, D-076) | Record the tenant's written instruction (FR-analytics-028); set the tenant's GA4 measurement ID (FR-analytics-020); switch the feature on or off per tenant (FR-analytics-001) | Switch it on without a recorded instruction (FR-analytics-028); see a tenant's guest content through this feature |
| **Owner** of a tenant (D-075) | Read their own tenant's numbers in GA4's reports, as a Viewer on their own property (FR-analytics-021) | Read another tenant's numbers (FR-analytics-022); switch the feature or record the instruction |
| **Admin, Staff** | Nothing (Q2 default, M-007) | Same as owner |
| **Platform operator** (the GA account holder) | Read every tenant's property (US-3), **aggregate counts only** for the platform's own purposes (BR-9) | Use a tenant's event-level data for the platform's own purposes (BR-9) |

No new app permission is added: reading happens in GA4, not on a screen of this app (Q1 = A, not D). *(amended, A-2)*

## 3. Functional requirements

### 3.1 The switch and the scope

**FR-analytics-001 · A per-tenant switch, off by default.** Analytics is a feature in the D-127 registry, labelled "Analytics", in the "Guest pages" group, OFF for a tenant with no row (the voice shape, D-134). Only a super user changes it, on the platform form's Features tab, and only as FR-analytics-020 and FR-analytics-028 allow. (C2)

**FR-analytics-002 · Only three pages are measured.** With the switch on, measurement runs on S-1 `/t/<slug>`, S-6 `/t/<slug>/book` and S-13 `/t/<slug>/manage`, and on no other page or route. (C1; Q5 answered **no**: `/`, `/privacy`, `/terms`, `/t/<slug>/privacy` and `/t/<slug>/terms` are never measured.) *(amended, A-3)*

**FR-analytics-003 · Staff and platform pages are never measured.** No measurement code is present, and no event is recorded, on any `/t/<slug>/admin/**` page, `/platform/**`, or any API route, whatever the switch says. (C1)

**FR-analytics-004 · A page that 404s is not measured.** An unknown slug, an archived tenant (D-077), S-6 or S-13 with its feature or application off (D-127), and S-6 with no priced unit record no event. A visitor must not be able to learn from the recipient's data which slugs exist.

**FR-analytics-005 · Off means nothing.** With the switch off, a measured page loads no measurement code, contacts no recipient, sets nothing on the device for measurement, and records no event. The change applies from the next page load after the super user saves.

### 3.2 Consent

Lex's advice (M-008, `docs/legal/analytics.md` Q3.1): GA4 needs **prior, opt-in consent**. FR-analytics-006–009 and 026–027 apply to every measured page of a tenant with the switch on.

**FR-analytics-006 · Nothing before a choice.** On a measured page of a tenant with the switch on, no measurement code loads, no recipient is contacted and nothing is stored on the device for measurement until the guest has allowed it. Declining, or ignoring the prompt, means no measurement for that guest. A mode that contacts the recipient before Allow (for example a "cookieless ping" variant of GA4's Consent Mode **[unverified]**) does not meet this FR.

**FR-analytics-007 · The prompt does not block the page, and is short.** *(amended, A-4)*
- The guest can chat, get a quote, send a booking request and look up a stay without answering the prompt.
- Allow and Decline are offered with equal prominence.
- The prompt names the recipient (Google Analytics), says what is measured, says that a cookie is kept on the device, says what is never sent, and links to the tenant's privacy page (`#analytics`).
- **Its sentences total at most 130 characters with a 15-character business name** (Vera, M-015: the bar stays under a third of a 375 px screen with the keyboard open). A longer business name lengthens it; that is accepted, and the type and buttons never shrink to compensate.
- **The placeholder words**, 129 characters with "Villa Esperanza" (counted by hand, spaces included), for Lex and later a lawyer to replace within the same budget (R-60):
  > "[Business name] would like to count visits with Google Analytics, which keeps a cookie here. It never sees your chats or booking."
- If Lex rules that the prompt itself must carry more facts, the bar may exceed the budget (Vera's R-V1, the accepted cost); the full facts are on the privacy page in any case (FR-analytics-019).

**FR-analytics-008 · The choice is remembered for 180 days and can be changed.** *(amended, A-5)*
- The choice is kept on that device for that tenant (a choice on villa is not a choice on alteza).
- **Allow and Decline are both kept for 180 days** from the moment they were made (Lex Q3.3). After 180 days there is no stored choice: the prompt shows again and nothing loads until the guest answers.
- The stored choice holds the tenant slug, the choice, its time and the tenant's policy version (FR-analytics-026), and nothing else about the guest.
- **No measurement identifier stored on the device outlives the choice:** its lifetime is at most 180 days (GA4's own cookie lifetime is configurable, default about two years **[unverified]**).
- The tenant's privacy page offers a control to change the choice. Changing to Decline removes the measurement identifiers the page can reach and stops measurement from the next page load.

**FR-analytics-009 · The booking consent box is separate.** The booking page's required consent (D-129) is unchanged and is not an analytics consent; accepting one never accepts the other.

**FR-analytics-026 · A new policy version asks again.** *(new, A-14)* A stored choice whose policy version is not the tenant's current one (`policy_version`, read as the page reads it today) counts as **no choice**: the prompt shows again, and nothing loads until the guest answers. The tenant's policy version is bumped when the switch first goes on (FR-analytics-019), so every guest is asked afresh then; a booking request after the bump asks for agreement to the new version too (D-129's existing behaviour, unchanged).

**FR-analytics-027 · Global Privacy Control and Do Not Track mean Decline.** *(new, A-15)*
- When the browser signals Global Privacy Control, or Do Not Track set to "1" (the exact browser properties **[unverified]**, Theo's), and the guest has no explicit Allow stored for this tenant: the prompt is **not shown**, nothing loads, and the guest counts as having declined.
- The tenant's privacy page says the browser's signal turned analytics off, and offers an explicit "Allow analytics anyway". An Allow made there is a stored choice like any other (180 days, FR-analytics-008; the version, FR-analytics-026), and measurement then runs despite the signal.
- The privacy page's analytics text says that these signals are treated as a refusal (FR-analytics-019).

### 3.3 What is never recorded or sent (C1)

**FR-analytics-010 · Never sent, anywhere, by any event.** No event and no property carries:
- chat text, a suggested question's text, voice audio or its transcript, or any reply;
- a guest's name, mobile number, email address, note, change-request reason;
- a booking reference, group id, stay id, conversation id, message id or user id;
- a promo code, a price, an amount or a payment detail;
- check-in dates, night counts, party counts or room names.

**FR-analytics-011 · S-13 sends no query string.** Every event recorded on S-13 records its path as `/t/<slug>/manage` exactly, whatever the URL carried (`?ref=` included, K2), and no fragment.

**FR-analytics-012 · Other pages keep only campaign parameters.** On S-1 and S-6 the recorded address is the path plus, at most, `utm_source`, `utm_medium`, `utm_campaign`, `utm_term`, `utm_content`; every other query parameter and every fragment is dropped before anything is recorded.

**FR-analytics-013 · The referrer is an origin, never a path.** *(amended, A-6)* Where a source is recorded:
- an **external** referrer is recorded as its origin only (`https://www.facebook.com`);
- an **internal** referrer (one of this app's own pages, including the previous measured page after an in-app navigation) is recorded as **this app's own origin** (no path, no query), or not at all. It is never recorded as a page name: the recipient would read "S-13" as a referral from a site of that name (Theo, M-016).
- A referrer that was `/t/<slug>/manage?ref=…` is never recorded with its path or its query. (K2: the guest moves from S-13 to the chat with the reference in the address bar.)

**FR-analytics-014 · Allowed properties are a closed list.** *(amended, A-7)* An event carries only:
1. **What the app sends** (closed by the app): the tenant slug, the measured page (S-1, S-6, S-13), the event name, the time, the campaign parameters of FR-analytics-012, and the referrer of FR-analytics-013.
2. **What the recipient adds by itself and no setting removes** (Theo, M-016; the list is **[unverified]** until Phase 0): its client and session identifiers (the cookie the guest allowed), session count and number, engagement time, screen resolution, browser language, user-agent client hints, its consent and version flags, and a coarse location it derives from the IP address. Where the property offers a setting that turns granular location or device data off, it is off.

A field outside both lists, found by Phase 0 or by QA, fails this FR; adding a property to either list is a change of requirements (a message to Rhea, § 4.3 of the organization). None of list 2 may carry anything FR-analytics-010 forbids.

### 3.4 Events

**FR-analytics-015 · Page view.** One page view per load of a measured page, after consent.

**FR-analytics-016 · Funnel steps.** Four named step events, each with no property beyond FR-analytics-014:

| Event | Fires when | Fires at most |
|---|---|---|
| `chat_started` | The first message of a conversation is sent (typed, a suggested question clicked, or a voice message sent), and the chat route answered (a reply or the refusal text; not a 429 or an error) | Once per conversation |
| `quote_shown` | S-6 shows a price returned by the quote | Once per page load |
| `request_sent` | S-6's request was accepted by the server (a success response; never a 409, 429, validation error or network failure) | Once per accepted request |
| `stay_found` | S-13's lookup found a stay (never a miss or a lock) | Once per page load |

Whether an answered/refused outcome is also a step is Q6 (**no**; S-11 already counts refusals from Postgres).

**FR-analytics-017 · A step is recorded only on success.** A failed, refused or rate-limited action records no step event (the table above). A retried action that then succeeds records one.

### 3.5 Behaviour around the measurement

**FR-analytics-018 · The pages do not depend on it.** Whether the measurement loads, fails, times out, or is blocked by the browser or an ad blocker, every measured page behaves identically: no error is shown, no action waits on it, and the chat, the quote, the request and the lookup succeed or fail exactly as with the switch off.

**FR-analytics-019 · The page text stays true (K5).** *(amended, A-8)* When, and only when, the switch is on for a tenant:
- that tenant's privacy page (`lib/legal.ts`) carries Lex's placeholder text (`docs/legal/analytics.md` Q3.5), until a lawyer replaces it (R-60). It: names **Google** as the recipient; says what is measured; says that a cookie is kept on the device for up to 180 days (FR-analytics-008); says the information is **processed outside the Philippines**, under data processing terms; states the retention of FR-analytics-024 as a number; says the basis is consent, refusable without loss; says GPC and DNT are treated as a refusal (FR-analytics-027); and holds the "Your analytics choice" control (FR-analytics-008, 027) at `#analytics`;
- the sentence "Nothing is collected to follow you across other websites. Guests are given no cookies." is replaced by Lex's "What is collected" paragraph, and is unchanged word for word for a tenant with the switch off;
- each number in the text (180 days, the retention months) comes from the one value the behaviour uses, never typed twice;
- the voice notice (D-134, "Nothing is recorded or kept") stays true: no voice event exists.

**The tenant's policy version is bumped** when the switch first goes on for that tenant, and whenever this analytics text changes (Lex Q3.5; FR-analytics-026 is the effect).

The platform's own landing page text "This landing page sets no cookie and uses no analytics" stays true (Q5 = no).

### 3.6 Settings and reading the numbers

**FR-analytics-020 · The tenant's GA4 measurement ID.** *(amended, A-9)* Each tenant has **its own GA4 property** (M-022) and therefore its own measurement ID. Only a super user sets it, on the platform form beside the switch. The switch cannot be on without a value of valid shape, and the platform form says why. **An ID already set for another tenant is refused**, with a sentence saying so (one property per tenant, FR-analytics-022). The exact shape is the recipient's **[unverified]**, Theo's to write.

**FR-analytics-021 · An owner can read their tenant's numbers.** *(amended, A-10)* At least: page views per measured page, visits by source (referrer origin and campaign), and the four steps of FR-analytics-016, each for the last 7, 30 and 90 days, in the tenant's day. **Where:** GA4's standard reports, on the tenant's own property, as a Viewer granted by the operator (Q2, M-022). The property's time zone is the tenant's (the operator's set-up step, `plan/analytics.md` § 6.2). The 90-day view comes from aggregate reports, which the 2-month retention does not limit **[unverified]**; if Phase 0 finds it does, the view shortens or Lex is asked again, never the retention lengthened silently (FR-analytics-024).

**FR-analytics-022 · One tenant never reads another's.** *(amended, A-11)* No owner, admin or staff of tenant A can see any figure of tenant B by any path this feature offers. Since a GA4 property has no row-level access **[unverified]**, this holds by **one property per tenant**: no two tenants' events go to the same property, and an owner is given Viewer on their own tenant's property only. The platform operator may read every tenant's property, under BR-9.

**FR-analytics-023 · The dashboard keeps its own numbers (C6, K7).** No figure S-11 or the Pulse strip already shows (chats, refusals, stays, requests, promo uses) is replaced by, or drawn beside, an analytics count of the same thing. With Q1 = A no analytics figure appears on S-11 in v1.

**FR-analytics-024 · Retention is the shortest the recipient offers, and stated.** *(amended, A-12; Lex's wording)* Event-level analytics data is kept for the shortest period the recipient offers (GA4: about 2 months **[unverified]**), stated on the privacy page as a number; aggregate counts with no identifier may be kept. The privacy page states both. (The earlier bound, "no longer than the tenant's chat retention", is withdrawn: a property holds one setting, which cannot follow each tenant's D-131 period, and 2 months is shorter than any period a tenant has today except 30 days.)

**FR-analytics-025 · Switching is logged.** *(amended, A-13)* Turning the feature on or off, changing FR-analytics-020's measurement ID, and setting or clearing FR-analytics-028's instruction date each appear in the platform's Activity tab (D-138) with who and when.

**FR-analytics-028 · Switched on only on the tenant's written instruction.** *(new, A-16)*
- The platform form's Legal tab holds a **date of the tenant's written instruction to use analytics**, set by a super user, shown and set like the DPA date (D-130).
- The switch cannot be turned on while that date is empty; the Features row says why in visible text ("Record the resort's written instruction on the Legal tab first."), and the server refuses the same with a sentence, whatever the screen shows.
- Clearing the date while the switch is on is refused with a sentence; the super user turns the switch off first. *(Assumption A-R2.)*
- The date is a calendar date not after today in the tenant's time zone. *(Assumption A-R3.)*
- A signed DPA is **not** required by the product to switch analytics on in v1 (no tenant has one, D-130); that the DPA must cover analytics is BR-10, a contract matter. *(Assumption A-R4, Q11.)*

## 4. User stories

- **US-1 (owner):** As a resort owner, I want to see how many people opened the chat and the booking page last month and where they came from, so that I know which promotion brings guests. (FR-analytics-015, 012, 013, 021)
- **US-2 (owner):** As a resort owner, I want to see how many visitors saw a price and how many sent a request, so that I know whether the booking page loses people. (FR-analytics-016, 021)
- **US-3 (platform operator):** As the operator, I want **aggregate** visits per tenant, so that I can show a prospective resort what the product reaches. (FR-analytics-021, 022; BR-9) *(amended, A-18)*
- **US-4 (guest):** As a guest, I want to say no to being measured and still book, so that my privacy is my choice. (FR-analytics-006–008, 027)
- **US-5 (guest):** As a guest who opened my booking from a link, I want my booking reference never to leave the resort's site. (FR-analytics-010, 011, 013)
- **US-6 (super user):** As a super user, I want to switch analytics on for one tenant only, and only when that tenant asked in writing, so that a tenant that has not agreed to it is not measured. (FR-analytics-001, 005, 020, 028) *(amended, A-18)*

## 5. Business rules

- **BR-1:** Off unless a super user turns it on, per tenant, on that tenant's recorded written instruction (C2, FR-analytics-028).
- **BR-2:** No guest content and no identifier of a guest, a stay or a conversation is ever recorded (C1, CLAUDE.md rule 7 in spirit: nothing a visitor may not see, and here nothing a vendor may not see).
- **BR-3:** No consent means no measurement, and the product still works in full. A browser privacy signal is a refusal unless the guest explicitly allows on the privacy page.
- **BR-4:** Postgres stays the one source of every count it holds (C6, D-098).
- **BR-5:** A tenant's numbers belong to that tenant and the platform (the two-walls principle, CLAUDE.md rule 6, applied to this data): one property per tenant.
- **BR-6:** The privacy page is true for each tenant's actual setting at every moment (K5, R-60).
- **BR-7:** *(amended, A-17)* Lex answered Q3 and Q9 as advice (M-008). The build may proceed on that advice; **no real guest is measured** until a lawyer has confirmed `docs/legal/analytics.md` § 6 and replaced the placeholder words (the R-60 bar), and Google's data processing terms for Google Analytics are accepted in the GA account **[unverified: where]** (the user, as account holder).
- **BR-8:** The measurement and the security headers of R-55 are decided together (C4); this file sets no header. (The user chose the host-allowlist CSP now, M-022; Theo's.)
- **BR-9:** *(new, A-17)* The platform operator uses a tenant's analytics for its own purposes **as aggregate counts only**; event-level exploration of a tenant's data is for that tenant's purposes only (Lex Q3.6). Not testable in the product; it binds the operator and goes into the DPA.
- **BR-10:** *(new, A-17)* The tenant–platform DPA (D-130) covers analytics: the purpose, Google as sub-processor, the transfer outside the Philippines, and BR-9. Each GA4 property keeps Google signals, advertising features and data sharing with Google for its own purposes **off** **[unverified: the setting names]**; if any is on, Lex's advice no longer holds (L-A4).

## 6. User workflows

**W-1 · A guest's first visit.** Guest opens `/t/villa` → the chat is usable at once; the consent prompt is shown → (a) Allow: measurement loads; a page view is recorded; the guest's first answered message records `chat_started` → (b) Decline or no answer: nothing is recorded, now or on later pages of villa, until the guest changes the choice on villa's privacy page; a Decline is remembered 180 days, an ignored prompt is not a choice and shows again. *(amended, A-5)*

**W-1c · A guest whose browser sends GPC or DNT.** *(new, A-15)* Opens `/t/villa` → no prompt, nothing loads → on villa's privacy page, "Your analytics choice" says the browser's signal turned analytics off → (optional) "Allow analytics anyway" → from the next villa page load, measurement runs.

**W-2 · From chat to request.** Allowed guest on S-1 follows "Book a stay" → S-6 page view (internal referrer = this app's origin) → a quote appears: `quote_shown` → sends the request: on success `request_sent`; on a 409 ("taken on …") nothing; on a retry that succeeds `request_sent` once. *(amended, A-6)*

**W-3 · Manage from a receipt link.** Guest opens `/t/villa/manage?ref=ABC123` → page view recorded with path `/t/villa/manage` only → lookup finds the stay: `stay_found` → guest follows "Need help? Ask …" to the chat → S-1 page view with referrer = this app's origin, or none; no path, no query. *(amended, A-6)*

**W-4 · A super user switches it on.** `/platform` → tenant → Legal → records the date of the tenant's written instruction → Profile/Features: sets the tenant's GA4 measurement ID → Analytics on → saved → the tenant's policy version is bumped → the next page load of S-1/S-6/S-13 for that tenant shows the consent prompt, also to guests who had a stored choice; the privacy page shows the analytics text; the Activity tab shows each change. *(amended, A-16, A-8)*

**W-5 · Switch off.** Super user turns it off → next page load: no prompt, no code, no events; the privacy page's original sentence returns.

**W-6 · The 180 days run out.** *(new, A-5)* A guest allowed on villa 181 days ago opens `/t/villa` → no stored choice → the prompt shows, nothing loads until they answer.

## 7. Acceptance criteria

Each is checkable by the QA Engineer from the browser's network log, its storage, the recipient's received events (or the request bodies to it), the page text, the platform form and the platform's Activity tab. Amended rows are marked; AC-25–AC-32 are new (A-19).

| AC | For | Given / When / Then |
|---|---|---|
| AC-01 | 001 | A tenant with no `analytics` row: the platform form shows Analytics OFF; S-1, S-6, S-13 make no request to any recipient and store nothing for measurement. |
| AC-02 | 001 | A staff owner (not a super user) cannot change the switch: the platform is not theirs, and no tenant screen offers it. |
| AC-03 | 002, 003 | *(amended)* Switch on, consent given: every `/t/<slug>/admin/**` page, `/platform`, `/`, `/privacy`, `/terms`, `/t/<slug>/privacy` and `/t/<slug>/terms` make no request to the recipient and contain no measurement code. |
| AC-04 | 004 | Switch on: `/t/no-such-slug`, an archived tenant's `/t/<slug>`, and `/t/<slug>/book` with `booking_page` off each 404 and record no event. |
| AC-05 | 005 | Switch turned off: after one reload, no request to the recipient, nothing new stored for measurement. |
| AC-06 | 006 | Switch on, a fresh browser profile: before the guest answers the prompt, the network log shows no request to the recipient and storage holds no measurement identifier. |
| AC-07 | 006, 007 | Decline: send a chat message, get a quote, send a request, look up a stay: all succeed; no request to the recipient at any point. |
| AC-08 | 007 | With the prompt unanswered, the chat field, the booking form and the lookup form can be used by keyboard alone without dismissing the prompt; Allow and Decline are the same size and weight. |
| AC-09 | 008 | *(amended)* Allow on villa, then open alteza (switch on): alteza shows its own prompt. Change to Decline on villa's privacy page: the next villa page load sends nothing, and the measurement cookies the page can reach are gone from storage. |
| AC-10 | 009 | Allow analytics: the booking consent box on S-6 is still unticked and still required. Tick the booking box with analytics declined: no request to the recipient. |
| AC-11 | 010 | With a chat containing a name, a mobile number and an email, a booking with a promo code and a note, and a lookup by reference: every event received contains none of those strings, no reference, no id and no amount (search the recipient's raw events for each). |
| AC-12 | 011 | Open `/t/villa/manage?ref=ABC123&utm_source=x#y`: the recorded page is exactly `/t/villa/manage`. |
| AC-13 | 012 | Open `/t/villa?utm_source=fb&utm_campaign=june&foo=bar#z`: the record carries `utm_source=fb`, `utm_campaign=june`, and not `foo`, `bar` or `z`. |
| AC-14 | 013 | *(amended)* From `/t/villa/manage?ref=ABC123` follow the chat link: the chat's page view carries this app's origin as referrer, or none; never a path, `ref`, `ABC123` or a page name such as "S-13". From an external `https://example.com/page?x=1`, the referrer is `https://example.com`. |
| AC-15 | 014 | *(amended)* Every field on every request to the recipient is in FR-analytics-014's list 1 or list 2; any other field fails, and is reported to Rhea with its name. |
| AC-16 | 015 | One load of each measured page records exactly one page view. |
| AC-17 | 016, 017 | Send a first message → one `chat_started`; a second message → none. A first message answered 429 → none, then a successful retry → one. A request answered 409 → no `request_sent`; a successful request → one. A lookup miss → no `stay_found`; a hit → one. |
| AC-18 | 018 | With the recipient blocked (an ad blocker, or the host unreachable): no visible error, and the chat, quote, request and lookup give the same results as with the switch off. |
| AC-19 | 019 | Switch on for villa, off for alteza: villa's privacy page names Google, says the data is processed outside the Philippines, states 180 days and the retention, mentions GPC/DNT, and drops "Guests are given no cookies"; alteza's keeps that sentence word for word. |
| AC-20 | 020 | *(amended)* Switching on with the measurement ID empty or malformed is refused with a sentence saying why. Setting villa's ID to the one alteza already has is refused with a sentence. |
| AC-21 | 021, 022 | *(amended)* Villa's and alteza's switches on: events from villa's pages reach villa's measurement ID only, alteza's alteza's only (the request bodies). In GA4, villa's owner, as Viewer on villa's property, sees page views, sources and the four steps for 7/30/90 days, and has no access to alteza's property. |
| AC-22 | 023 | S-11's chats, refusals and stays are unchanged in value and source with the switch on; no analytics figure is drawn on S-11. |
| AC-23 | 024 | *(amended)* The privacy page states the event-level retention as a number equal to the property's setting (the shortest offered), and says aggregate counts may be kept. |
| AC-24 | 025 | *(amended)* Recording the instruction date, setting the measurement ID, turning the switch on, then off, gives four rows on the platform's Activity tab, each with the super user and the time. |
| AC-25 | 007 | The prompt's sentences, rendered with "Villa Esperanza", are ≤ 130 characters, name Google Analytics, mention the cookie and what is never sent, and link to `/t/villa/privacy#analytics`. |
| AC-26 | 008 | Set the stored choice's time to 181 days ago (Allow, then Decline in a second run): the next load shows the prompt and makes no request to the recipient before an answer. At 179 days: no prompt, the choice applies. The measurement cookie's expiry, read from storage, is at most 180 days after it was set. |
| AC-27 | 026 | With an Allow stored, bump villa's policy version: the next villa load shows the prompt and makes no request to the recipient before an answer. |
| AC-28 | 019, 026 | Turning the switch on for the first time changes the tenant's policy version (read before and after). |
| AC-29 | 027 | A browser with GPC on (and a second run with DNT = 1), no stored choice: no prompt, no request to the recipient, all four actions succeed; the privacy page says the signal turned analytics off. Click "Allow analytics anyway": the next load measures. |
| AC-30 | 028 | A tenant with no instruction date: the Features row's switch is refused with the visible sentence, and a direct request to turn it on is refused by the server with a sentence. Record the date: switching on succeeds. |
| AC-31 | 028 | With the switch on, clearing the instruction date is refused with a sentence; a date after today in the tenant's zone is refused. |
| AC-32 | 006 | No request to the recipient before Allow in any of: a fresh profile, after Decline, with GPC, with the switch off (the network log). |

## 8. Validation and error handling

- **The switch:** only the D-127 keys are accepted (the existing SQL check); the new key is added to both lists. Turning it on is refused without a valid measurement ID (FR-analytics-020) and without an instruction date (FR-analytics-028), each with its own sentence, from the server whatever the screen shows.
- **The measurement ID:** validated by shape before save; refused with a sentence; refused if another tenant has it (FR-analytics-020).
- **The instruction date:** a date, not after today in the tenant's zone; clearing it while the switch is on is refused (FR-analytics-028).
- **Recipient down, slow or blocked:** silent; no retry that delays the page; no error to the guest (FR-analytics-018).
- **Consent storage unavailable** (private mode, storage refused): treated as no choice; nothing is measured; the prompt may reappear on each load.
- **A stored choice that cannot be read** (malformed, another tenant's, an old version, past 180 days): treated as no choice (FR-analytics-008, 026).
- **An event that would carry a disallowed property** must not be sent at all, rather than sent with the property removed silently; QA checks FR-analytics-014 against what was received.

## 9. Edge cases

1. **The receipt link** S-6 → `S-13?ref=…` (K2): FR-analytics-011, 013.
2. **A guest pastes their reference or phone into the chat** (R-50): no chat text is ever sent (FR-analytics-010), so nothing to strip.
3. **A suggested question clicked** (D-089): counts as the first message for `chat_started`; its text is not sent.
4. **Voice** (D-134): a voice message counts for `chat_started` like a typed one; no audio, transcript or "read aloud" event.
5. **Small talk answered in code** (D-049, a greeting): counts as an answered first message (the route answered).
6. **Rate limited** (D-137, 429): no step event.
7. **Staff testing the public pages** while signed in inflate the counts: not excluded (Q7 = no, M-007); staff may decline like anyone. A known inflation (R-63).
8. **A guest with two tabs** sending the same request twice: one success, one 409 → one `request_sent`.
9. **A tenant whose bookings application is off:** only S-1 is measured; S-6 and S-13 404 (FR-analytics-004).
10. **The switch flipped while a guest has the page open:** the open page keeps its state until reload (FR-analytics-005: from the next page load).
11. **A tenant archived** with the switch on: all its pages 404, nothing recorded.
12. **A browser with Do Not Track / Global Privacy Control set:** FR-analytics-027 (Q9 answered). *(amended, A-20)*
13. **Bots and crawlers:** counted or not as GA4 does by itself; no requirement to filter in v1.
14. **Two tenants share one browser** (the operator demos both): consents are separate (FR-analytics-008).
15. **The policy version changes while a guest has the page open** *(new, A-20)*: the open page keeps its state; the next load asks again (FR-analytics-026).
16. **GPC on and an explicit Allow stored** *(new, A-20)*: the explicit Allow wins until it expires or the version changes; then FR-analytics-027 applies again (no prompt).
17. **The guest clears site data** *(new, A-20)*: no stored choice; the prompt shows again (or, with GPC/DNT, nothing loads).
18. **The switch is turned off and on again** *(new, A-20)*: the version is bumped only when the switch FIRST goes on and when the analytics text changes (FR-analytics-019); a later re-enable does not bump it by itself. *(Assumption A-R5.)*
19. **`?ref=` stays in S-13's address bar after pre-fill** *(new, A-21)*: unchanged in this feature (Uma's R-U5 declined, § 12). The analytics leak is closed by FR-analytics-011 and 013.

## 10. Dependencies

*(amended, A-22)*

| On | Why | Status |
|---|---|---|
| D-127 feature registry and `tenant_features` | FR-analytics-001, 005 | Built |
| D-134's `defaultOn: false` shape | Off with no row | Built |
| D-130's DPA date on the Legal tab | The shape FR-analytics-028 copies | Built |
| `lib/legal.ts` and plan/legal.md § 0 | FR-analytics-019; the texts are placeholders (R-60), § 0 waits on the user | Placeholder |
| **Lex's advice** (`docs/legal/analytics.md`) | FR-006–008, 019, 024, 026–028, BR-7, BR-9, BR-10 | **Answered as advice** (M-008); gate 7 later; a lawyer before real guests (§ 6) |
| **R-55 security headers** | C4, BR-8: host-allowlist CSP now (M-022) | Planned (Theo) |
| Theo's Phase 0 vendor read (R-63) | Every **[unverified]** GA4 fact: FR-006's ping mode, 008's cookie lifetime, 013's referrer field, 014's list 2, 020's ID shape, 021's 90-day reports, 022's access model, 024's 2 months, 027's browser properties | Owed; Context7 skipped (M-022) |
| The GA account set-up (the user, by hand) | A property per tenant, its time zone, retention at the shortest, Google signals / ads / data sharing off, owners as Viewers, Google's data processing terms accepted (BR-7, BR-10) | Owed (`plan/analytics.md` § 6.2) |
| The tenant–platform DPA (a lawyer) | BR-10 | Owed; no tenant has a signed DPA (R-60) |
| D-098 dashboard, D-131 retention, D-138 audit log | FR-analytics-023, 024, 025 | Built |
| D-129 booking consent and `policy_version` | FR-analytics-009, 026 | Built |
| D-137 rate limit | FR-analytics-017's 429 case | Built |

## 11. Open questions and unresolved decisions

**The user's answers (recorded 2026-10-28):** *(A-1)*

| Q | Answer | Source |
|---|---|---|
| **Q1 · The means** | **A, GA4.** | M-007 |
| **Q2 · Who reads, and where** | **Default:** owners of their own tenant and the operator; admins and staff not. Refined by M-022: **one GA4 property per tenant**, owners Viewers on their own property; the operator holds them all. | M-007, M-022 |
| **Q4 · Will villa and alteza look at it** | **Default:** build for owners and the operator both (FR-analytics-021); if the owners do not look, the operator's aggregate view (US-3) carries v1. Nothing in the FRs changes either way. | M-007 |
| **Q5 · The other public pages** | **Default: no.** `/`, `/privacy`, `/terms`, the tenant privacy and terms pages are never measured. | M-007 |
| **Q7 · Exclude signed-in staff** | **Default: no** in v1, a known inflation. | M-007 |
| *Theo's q1 (where the properties live)* | One property per tenant, owners Viewers on their own. | M-022 |
| *Theo's q2 (the written-instruction rule)* | "Only if you adopt it": **adopted** as FR-analytics-028 (§ 12, A-16). | M-022 |
| *Theo's q4 (the CSP)* | Host allowlist now. Architecture, not a requirement (BR-8). | M-022 |
| *Context7* | Skipped; GA4 facts stay **[unverified]**. | M-022 |

**Answered by the team:**
- **Q3 (Lex):** answered as advice, M-008 / `docs/legal/analytics.md` § 3; folded in (§ 12).
- **Q6 (mine):** no; S-11 counts refusals from Postgres (C6).
- **Q8 (Theo):** answered, M-016 / `plan/analytics.md` § 1; FR-006, 011, 012 met as written; 013, 014, 022, 024 amended (§ 12).
- **Q9 (Lex):** GPC and DNT are a Decline; FR-analytics-027.

**Assumptions I made instead of asking** (the user re-reads them at gate 5):
- **A-R1:** M-007's "change nothing else" covered that message alone; the later requests (M-008, M-011, M-015, M-016, M-022) are folded in as the organization's § 4.5 and § 4.6 route them, each listed in § 12.
- **A-R2:** clearing the instruction date while the switch is on is refused, rather than turning the switch off by itself (FR-analytics-028).
- **A-R3:** the instruction date cannot be after today in the tenant's zone.
- **A-R4:** a signed DPA is not a product precondition for analytics in v1 (Q11).
- **A-R5:** the policy version is bumped on the FIRST switch-on and on a text change, not on every re-enable (edge case 18).
- **A-R6:** the bar's placeholder words (FR-analytics-007) are mine within Vera's budget; Lex and a lawyer may replace them within it.

**Still open (for gate 5, each with a default that stands if unanswered):**
- **Q10 · Remove `?ref=` from S-13's address bar after pre-fill** (Uma's R-U5)? Declined for this feature (§ 12, A-21); the default is that it stays. If wanted, it is a separate idea for George.
- **Q11 · Must a signed DPA come before analytics can be switched on**, as it does for bookings (D-130)? Default: no in v1 (A-R4); BR-7 already keeps real guests out until a lawyer has confirmed.
- **The lawyer's questions** LQ-1–LQ-9 (`docs/legal/analytics.md` § 6): before any real guest is measured (BR-7).

**Conflicts found:** the tenant privacy page's "Guests are given no cookies" (`lib/legal.ts:95`) becomes untrue with the switch on; FR-analytics-019 resolves it per tenant, with Lex's words. FR-analytics-024's first wording conflicted with a single property's single retention setting; withdrawn (A-12).

## 12. Amendments after gate 2

The user approved gate 2 on 2026-10-28 (M-007). Everything below changed afterwards. **No new gate was recorded**; the user re-reads this list at gate 5.

### Adopted

| # | FR / section | Change | From |
|---|---|---|---|
| A-1 | § 11 | The user's answers recorded: Q1 = A (GA4); Q2, Q4, Q5, Q7 defaults; one property per tenant; the written-instruction rule left to me; CSP host allowlist; Context7 skipped | M-007, M-022 |
| A-2 | § 1, § 2 | GA4 named as the means; owners read in GA4 as Viewers on their own property; admins and staff nothing; the operator's row added; no new app permission | M-007 (Q1, Q2), M-022 |
| A-3 | FR-002, § 1 | Q5 = no: `/`, `/privacy`, `/terms` and the tenant privacy and terms pages are never measured | M-007 |
| A-4 | FR-007 | The bar's sentences total ≤ 130 characters with a 15-character business name; placeholder words written (129 characters) | M-015 (Vera), M-011 (Uma: the words are mine and Lex's) |
| A-5 | FR-008, W-1, W-6 | Allow AND Decline kept 180 days; the stored choice holds slug, choice, time, policy version; the measurement cookie lives ≤ 180 days; Decline removes reachable measurement identifiers | M-008 point 3 (Lex), M-016 point 5 (Theo), M-011 point 1 (Uma's [if FR] states) |
| A-6 | FR-013, W-2, W-3 | An internal referrer is this app's own origin, or none; never a page name | M-016 point 1 (Theo) |
| A-7 | FR-014 | Two lists: what the app sends (closed by the app), and GA4's own technical fields that no setting removes, named and allowed **[unverified]**; granular location/device settings off | M-016 point 2 (Theo) |
| A-8 | FR-019, W-4 | Lex's Q3.5 text as the placeholder: Google named, processing outside the Philippines, 180 days, retention, consent basis, GPC/DNT, the `#analytics` control; numbers from one value; `policy_version` bumped when the switch first goes on and when the text changes | M-008 points 2 and 5 (Lex) |
| A-9 | FR-020 | The setting is the tenant's own GA4 measurement ID; one property per tenant; an ID already used by another tenant is refused | M-016 point 3 (Theo), M-022 |
| A-10 | FR-021 | Owners read in GA4's standard reports on their own property; the property's time zone is the tenant's; the 90-day view from aggregates, never by lengthening retention | M-007 (Q2), M-022, M-016 (Theo § 1.1) |
| A-11 | FR-022 | Holds by one property per tenant; an owner is a Viewer on their own only | M-016 point 3 (Theo), M-022 |
| A-12 | FR-024 | Lex's wording: event-level data kept for the shortest period the recipient offers (about 2 months **[unverified]**), stated as a number; aggregates may be kept. The chat-period bound withdrawn | M-008 point 4 (Lex), M-016 point 4 (Theo) |
| A-13 | FR-025 | The measurement ID and the instruction date are logged too | follows A-9, A-16 |
| A-14 | **FR-026 (new)** | A stored choice from another policy version is no choice: asked again, nothing loads | M-008 point 3 (Lex), M-016 point 5 (Theo) |
| A-15 | **FR-027 (new)**, W-1c | GPC, or DNT = "1": no prompt, nothing loads, counts as Decline; an explicit "Allow analytics anyway" on the privacy page overrides | M-008 point 7 (Lex, Q9), M-016 point 5 (Theo) |
| A-16 | **FR-028 (new)**, W-4 | The switch goes on only with the tenant's written-instruction date recorded on the Legal tab (the D-130 shape); clearing it while on is refused | M-008 point 6 (Lex), M-016 point 5 (Theo), M-022 ("only if you adopt it": adopted) |
| A-17 | BR-1, BR-3, BR-5, BR-7, BR-8; **BR-9, BR-10 (new)** | BR-7: build on Lex's advice, no real guest until a lawyer confirms and Google's terms are accepted. BR-9: the operator uses aggregate counts only. BR-10: the DPA covers analytics; Google's own-purpose settings off | M-008 points 2 and 6 (Lex), M-022 |
| A-18 | US-3, US-4, US-6 | US-3 limited to aggregates; US-4 cites FR-027; US-6 needs the written instruction | M-008 point 6 (Lex) |
| A-19 | § 7 | AC-03, 09, 14, 15, 19, 20, 21, 22, 23, 24 amended; AC-25–AC-32 new | follows A-3–A-16 |
| A-20 | § 9 | Edge case 12 resolved by FR-027; edge cases 15–19 new | follows A-14–A-16, A-21 |
| A-21 | § 9 edge 19, § 11 Q10 | Uma's R-U5 recorded as declined (below) | M-011 point 2 (Uma) |
| A-22 | § 8, § 10 | Validation for the ID's uniqueness and the instruction date; dependencies: Lex answered, Phase 0's list of unverified facts, the GA account set-up, the DPA | follows the above |

**Why each of Lex's and Theo's requests was adopted, in one line each:**
- **180 days for both choices** (A-5): a consent without an end is weak evidence of a current choice, and a Decline kept as long as an Allow stops the prompt nagging the guest who said no.
- **The policy-version re-ask** (A-14): the privacy text changes when the switch goes on, so a choice made under the old text was not informed about the new one.
- **GPC and DNT as Decline** (A-15): the guest has already objected; honouring it only reduces what is collected, and the explicit allow keeps the choice theirs.
- **The retention bound** (A-12): one property holds one setting, so the per-tenant bound could not be met; the shortest setting is the proportionate one for 7/30/90-day counts.
- **The written-instruction rule** (A-16): the tenant is the controller only if the tenant decides the purpose; a super user switching it on alone would make that untrue. It costs one date and one condition, the DPA date's shape.
- **Theo's FR-013 wording** (A-6): a page name would be read as a referral from a site of that name; the origin meets the FR's intent with no path or query.
- **Theo's FR-014 list** (A-7): no setting removes GA4's own fields, so they are named and allowed explicitly instead of failing the FR silently. Anything outside the list still fails.
- **One property per tenant for FR-022** (A-9, A-11): GA4 has no row-level access **[unverified]**, so a shared property would show every tenant to every owner; the user confirmed it (M-022).
- **Vera's bar words under about 130 characters** (A-4): the bar stays under a third of a 375 px screen with the keyboard open; the full facts are one link away on the privacy page.

### Declined

| # | Request | Why declined | From |
|---|---|---|---|
| D-1 | **Remove `?ref=` from S-13's address bar after pre-fill** (history replace, R-U5) | It changes S-13 for every tenant, with analytics off too: new behaviour outside this idea's scope (organization § 4.6). The analytics leak it guards is already closed by FR-analytics-011 (no query on S-13's events) and FR-analytics-013 (no path or query in a referrer). A reload after the replace would lose the pre-fill. It stays open as Q10, a separate idea for George if wanted. | M-011 point 2 (Uma) |

Nothing else was declined. Uma's [if FR] states (M-011 point 1) now each have an FR: 180 days (FR-008), the version re-ask (FR-026), GPC/DNT (FR-027) and the disabled switch (FR-028).
