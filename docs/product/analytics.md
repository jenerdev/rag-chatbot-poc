# Analytics on the public pages: idea evaluation (gate 1)

- **Idea:** `analytics`, full lane, status Planned (`office/pipeline.md`).
- **From:** the user, `todo.md:9`, which says only "google analytics". It was chosen as the first full-lane idea (plan/ai-employees.md § 9 q12).
- **Evaluated by:** Ivy, Idea Strategist, 2026-10-28.
- **Inputs read:**
  - George's M-001 and T-001;
  - plan.md:678 and plan/steps.md:731 (the seam);
  - plan/dashboard.md (what is already measured);
  - risks.md R-50, R-55, R-60;
  - plan/legal.md § 0;
  - status.md ▶ Next up (deployed on Vercel since 2026-10-27);
  - George's `owed.md` § 2 and § 6.
- **Spent:** nothing (Rule 7). Context7 was not authorised in this session. Every statement below about what Google Analytics does is therefore marked **[unverified]**: it comes from general knowledge and must be checked against Google's documentation before the architecture gate.

**Labels used throughout:**
- **Fact:** read in this repository, with the place cited.
- **Assumption:** what I took to be true in order to evaluate. It is not confirmed.
- **Estimate:** a judgement with no measurement behind it.

---

## 1. Idea summary

Add web analytics to the three public, guest-facing pages of every tenant:
- S-1, the chat, at `/t/<slug>`;
- S-6, the booking page, at `/t/<slug>/book`;
- S-13, Manage booking, at `/t/<slug>/manage`.

Owners, and the platform, would then be able to see how many people visit, where those visitors come from, and how many of them go on to chat, ask for a quote and send a booking request.

The vendor the user named is Google Analytics. Today that means GA4 **[unverified]**. The seam the earlier plans left is "one script in the tenant layout, with the tenant slug as a dimension" (plan.md:678). That seam is shaped like a feature, not a rule. The way of measuring is open to the requirements gate (§ 5).

**Assumption A1:** "google analytics" in todo.md means *knowing who visits the public pages and what they do there*. It does not mean Google's product for its own sake. The user's line gives no reason, and I could find no other record of one.

## 2. Problem being solved

**What the product measures today (fact, plan/dashboard.md):**
- S-11's dashboard is built only from rows the app already stores, and it says "Nothing new is collected" (dashboard.md:12).
- It counts conversations per day, refusals and the refusal rate, open unanswered questions, stays by status and by source (web or staff), occupancy and promo uses.
- `/platform`'s Pulse strip shows the same kind of counts across tenants.

**What nobody can see today (fact, by the same source):**
- **Visits.** How many people open the chat, the booking page or Manage booking and leave without typing anything or sending a request. The dashboard counts only people who have already acted.
- **Where visitors come from.** Facebook, a Google search, a link the resort shared, or a QR code at the front desk. A resort owner who spends on promotion cannot tell which channel brings guests.
- **The funnel.** Of the people who visit, how many chat, open the booking page, see a price and then send a request. The denominator of every conversion rate is missing.
- **Devices and drop-off.** For example, whether phone visitors leave the booking page at the party inputs (D-147) more often than desktop visitors do.

So the problem is real (assumption A2, below, is the part that is not yet known). Since 2026-10-27 the app is on a public URL with real visitors (status.md:61), and the business question "is the chatbot and the booking page bringing guests in?" cannot be answered from inside the product. The dashboard answers "what happened after a guest acted". It cannot answer "how many could have acted and did not".

**Assumption A2:** the people who want this answer are the resort owners and the platform operator (the user). Guests are not among them. Nobody has yet said which of the two matters more, and the answer changes the design (§ 7, K6).

## 3. Target users

These are the people who read the numbers, not the people being measured.

| Who | What they would use it for | Basis |
|---|---|---|
| **The platform operator** (the user, as super user) | Whether the product is used at all, per tenant; the evidence to show a prospective resort | Assumption: the user wrote the line and runs the platform |
| **Tenant owners and admins** (villa, alteza today) | Which channel brings bookings; whether the booking page loses people; the busy hours | Assumption: no tenant has asked for this in the record |
| **Guests** | Nothing directly. They are the ones measured, so they carry the privacy cost | Fact: guests are the visitors on all three pages |

Staff pages (`/t/<slug>/admin/**`) and `/platform` are **out** of this idea. Measuring staff is a different question, with a different legal basis, and nobody has asked for it. The landing page `/`, `/privacy` and `/terms` are public too, but George's brief names only three pages. Whether to include these others is left as an open question for the requirements gate.

## 4. Value proposition

"See how many people your chatbot and booking page reach, where they came from, and how many become a booking request, without the measurement ever seeing a guest's question, name, phone, email or booking reference."

- **Value to a tenant (estimate, no evidence):** moderate. It is useful for marketing decisions, but only for a tenant who will look at it. Today there are two tenants, and the record shows no tenant asking.
- **Value to the platform (estimate):** higher. Adoption numbers per tenant are what a platform needs before it grows, or before it sells.
- **Cost to build (estimate):** small, if it is done the way the seam describes:
  - one script, conditional per tenant, in `app/t/[tenant]/layout.tsx`, scoped to the three pages;
  - a switch in the D-127 feature registry;
  - a few named events at the funnel's steps.

  The cost the build does not show is in the constraints (§ 6): consent, the CSP, what must never be sent, and the legal texts.

## 5. Market and competitor considerations

These are the ways to get the same answer. They are listed so the requirements gate chooses on purpose, which is what plan.md:678 asked for.

| Option | What it is | For | Against |
|---|---|---|---|
| **Google Analytics 4** (the user's word) | A third-party script; data held by Google | Free at this scale **[unverified]**. Traffic sources and funnels are built in. Owners may already know it. The user asked for it by name | A third party receives visitor data, which may cross borders (RA 10173). Uses cookies **[unverified: `_ga`]**, so consent is likely needed (a question for Legal). Needs a CSP opening (R-55). Ad blockers hide part of the traffic (estimate: a noticeable share, unmeasured). The numbers live outside the product, so an owner needs a Google account and access |
| **Vercel Web Analytics** | The host's own page-view counter; the app is already on Vercel | Described by Vercel as cookieless **[unverified]**. No new vendor, because the host already sees every request | Probably a paid tier beyond small volumes **[unverified]**, which falls under Rule 7. Limited events and funnels. Per-tenant views need the slug in the path, which it already is |
| **Privacy-first hosted tools** (Plausible, Fathom, Umami Cloud) | Cookieless third-party counters | Small script, less consent burden **[unverified]** | Usually paid **[unverified]**. Still a third party |
| **First-party, in Postgres** | A `page_views`/`events` table filled by an open route, counted by `tenant_dashboard()` and drawn on S-11 | Fits the house: D-001 (hand-written), one database, RLS, the D-137 rate limit, retention (D-131). Owners see it on the dashboard they already use. No third party, no CSP opening | Real build cost: an open write route (spam and abuse, like `book/request`), a new table that needs policies, no referrer or campaign parsing for free, and the funnel UI has to be built. It is not "Google Analytics", which the user named |

**Differentiation:** analytics is not a selling point by itself. Every website builder has it. What would set this apart is that the funnel is *specific to the product*: visit → chat → answered or refused → quote → request → confirmed. The second half of that funnel is already in Postgres. A third-party tool sees only the first half unless the app sends it events.

## 6. Monetization opportunities

- **Direct revenue: none claimed.** No evidence in the record says anyone would pay for analytics. There is no pricing, no plan tiers and no tenant contract in the repository (fact: none found).
- **Indirect (assumption, unvalidated):** visit and conversion numbers per tenant are what the platform would show a prospective resort ("the chatbot answered N questions and brought M requests from K visits"). If the platform ever charges, analytics could be a feature of a higher tier, switched per tenant through D-127. That is a hypothesis, not a forecast.
- **Cost side:**
  - GA4's standard tier is believed free **[unverified]**.
  - Vercel's and the privacy-first tools may charge **[unverified]**.
  - The first-party option costs Postgres rows and build time only.

## 7. Risks and assumptions

### Risks (each one cited)

| # | Risk | Why it matters here | Who decides |
|---|---|---|---|
| K1 | **Guest content reaching a vendor.** Question text is user content (plan.md:678, plan/steps.md:731). Chat turns are POST bodies, so a page-view script does not see them by default. A custom event or an "enhanced measurement" feature could still carry them **[unverified: GA4's site-search capture reads query parameters]** | Visitors type names, phones and dates into the chat (R-50) | Requirements (a rule: never send), Security |
| K2 | **The booking reference in the URL.** S-13 accepts `?ref=` to pre-fill (CLAUDE.md layout, S-13). A page-view hit normally carries the full URL **[unverified]**, which would send a guest's reference to Google | A reference plus an email or phone is how a stay is found (D-104) | Requirements, Architecture (strip or redact query strings) |
| K3 | **Consent under RA 10173.** An analytics cookie or identifier on a guest's device is probably personal information, and the tenant is the controller (plan/legal.md). Consent may be required before the script loads | The legal texts are placeholders (R-60), and plan/legal.md § 0's three answers still wait on the user (owed.md § 2) | **Legal (Lex), before requirements are approved**, not at gate 7 |
| K4 | **No CSP today (R-55, open).** A third-party script is exactly what a CSP governs. Adding Google's hosts to a CSP that does not exist yet means either R-55 is done first, or both are designed together | A CSP that is too tight breaks the pages, and one that is too loose is no wall | Architecture, Security |
| K5 | **The privacy page and the chat notice would become untrue.** `lib/legal.ts` lists the recipients, and Google would be a new one. The voice feature says "Nothing is recorded or kept" (D-134). Analytics must not contradict page text | — | Legal, Requirements |
| K6 | **Whose property, whose data?** One platform property with the slug as a dimension (plan.md:678) means the platform holds every tenant's visitor data, and a tenant cannot see its own without access to the platform's account. A property per tenant (a measurement ID set by a super user) keeps each controller's data with that controller, but each one has to be set up | This is the processor and controller split in plan/legal.md | Requirements (Q1), Legal |
| K7 | **Numbers that disagree.** S-11 counts conversations from Postgres. GA would count sessions with ad blockers and consent refusals removed. Two different "chats this week" figures will confuse an owner | The dashboard's rule: "the screen never adds a figure" (D-098) | Requirements |
| K8 | **Performance on phones.** A third-party script on the chat and booking pages adds weight and a request **[unverified size]**. D-149 and D-150 just made pages faster at the user's request | — | Architecture |

### Assumptions to validate

| # | Assumption | How to validate | Who |
|---|---|---|---|
| A1 | The need is visibility of visits and the funnel, not Google specifically | Ask the user at gate 2 (q13, the user approves requirements): "Is Google required, or is the answer what matters?" | Rhea, through the user |
| A2 | Both the operator and the tenants are readers; the operator first | The same question at gate 2 | Rhea |
| A3 | GA4 is free at this volume, uses `_ga` cookies, does not store IP addresses, offers Consent Mode, and captures URLs with query strings | Context7 or Google's documentation, once `/mcp` is authorised; a read only | Theo (gate 5) |
| A4 | Analytics cookies need prior consent under RA 10173 and NPC guidance for these visitors | Lex's review; possibly a lawyer (R-60) | Lex |
| A5 | The two live tenants (villa, alteza) would look at the numbers | Ask the user, who knows them | Rhea, through the user |
| A6 | Vercel Web Analytics' pricing and cookie behaviour are as described in § 5 | Context7 or Vercel's documentation, a read only | Theo |

## 8. Recommended decision

**APPROVE**, with the scope and constraints below. They are part of the approval.

**What is approved** is the problem: per-tenant visibility of visits, traffic sources and the visit → chat → quote → request funnel on the three public pages. The requirements gate is where the means is chosen. The approval is limited by six constraints:

1. **Never sent to any vendor:** chat text, voice text, guest name, phone or email, a booking reference, or any query string on S-13. Staff and platform pages are never measured.
2. **Off by default per tenant.** It is a key in the D-127 registry, `apps/web/lib/features.ts` plus `tenant_features`, in the same way voice is off with no row (D-134).
3. **Legal before build.** Lex reviews consent, the recipient list and the cross-border transfer *during* requirements, and the privacy text in `lib/legal.ts` names the recipient before anything ships.
4. **R-55 is designed with it.** The CSP and this script are one architecture decision.
5. **The vendor is a requirements decision**, made by the user at gate 2 between GA4 (the user's word), a cookieless host counter, or first party in Postgres, using the table in § 5. GA4 is the default if the user does not choose otherwise.
6. **The dashboard stays the one number for what Postgres knows.** External analytics covers visits and sources only. It never re-counts chats or bookings for an owner's screen (K7).

## 9. Justification

- **Why not REJECT:** the problem is real and visible in the record. The product cannot count the visitors who leave without acting (dashboard.md:12 collects nothing new), and the app is now public (status.md:61). The user asked for it, and two earlier plans left a seam for it.
- **Why not REVISE:** the idea is thin ("google analytics" with no reason), but nothing in it is wrong enough to send back. Every gap is a question the requirements gate exists to ask, and the user approves that gate (q13), so the user is consulted anyway.
- **Why not RESEARCH:** the open facts are reads, not experiments:
  - Google's and Vercel's documentation (A3, A6);
  - a legal question Lex owns (A4).

  None of them decides *whether* to proceed. They decide *how*.
- **What the approval guards against:** the risks are concentrated and known: guest content and booking references leaking to a vendor (K1, K2), consent (K3) and the missing CSP (K4). The constraints in § 8 put each one in front of the gate that owns it, so the cheap build ("one script") does not ship ahead of the expensive rules.
- **Evidence for value:** none on revenue (§ 6), and the approval does not rest on revenue. It rests on a measurable gap in what the product can see.
