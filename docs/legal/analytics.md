# Analytics (GA4) on the public pages: legal ADVICE before the architecture

> **This is ADVICE, not the legal gate.** It answers Q3 and Q9 of
> `docs/requirements/analytics.md` § 11 (Rhea's M-004, task T-008) so that
> Theo's architecture and Uma's consent screen start from a position. Gate 7
> (legal) follows implementation and will be written then, against what was
> built. No gate is recorded by this file.
>
> **I am not a lawyer**, and nothing here is legal advice or a guarantee of
> compliance. It is a reviewer's reading, written so that a qualified
> Philippine privacy lawyer can confirm or correct it quickly. § 6 lists
> what they must look at.

- **Idea:** `analytics`, full lane. Gate 2 APPROVED by the user 2026-10-28: Q1 = **A, GA4**; Q2, Q4, Q5 and Q7 take Rhea's defaults (`office/pipeline.md`).
- **Written by:** Lex, Legal Reviewer, 2026-10-28.
- **Read:** `docs/requirements/analytics.md` (all); `docs/product/analytics.md` (K1–K8, A3, A4); `plan/legal.md`; D-129–D-131 (`decisions.md`); `risks.md` R-55, R-60; `apps/web/lib/legal.ts` (the tenant and platform privacy texts, line 95 above all).
- **Spent:** nothing (Rule 7). Context7 is not authorised in this session, so **no Google document was read.** Every statement about what GA4 does is marked **[unverified]** and is owed to Theo's read before gate 5 (A3). No statute or NPC issuance was read in this session either; § 2 says which statements about the law I rely on and how sure I am of each.

---

## 1. Jurisdiction and assumptions

**Jurisdiction:** the Philippines. The tenants are Philippine resorts and the platform is run from the Philippines (plan/legal.md). The Data Privacy Act of 2012 (RA 10173) applies; the house already treats each resort as **personal information controller** and the platform as its **processor** under a data processing agreement (D-129, D-130).

**Assumptions** (each one changes an answer if wrong):

| # | Assumption | If it is wrong |
|---|---|---|
| L-A1 | GA4 stores an identifier in a first-party cookie on the guest's device (`_ga` and similar) and sends it, the page address, the referrer, device and browser details and the request's IP address to Google **[unverified]** | If GA4 set nothing on the device and sent nothing linkable, § 3 Q3.1 would soften; it does not change the cross-border answer |
| L-A2 | Google processes GA data on servers outside the Philippines **[unverified: the locations]** | If it were all in the Philippines, Q3.2's transfer words fall away; the contract does not |
| L-A3 | ONE platform-held GA4 property, with the tenant slug as a dimension, is the likely build (plan.md:678's seam; Q2's default lets the operator read every tenant and owners their own). A property per tenant is the alternative (K6) | § 3 Q3.6 answers both |
| L-A4 | GA4 is configured with Google signals OFF, advertising features / ad personalisation OFF, and data sharing with Google for its own purposes OFF **[unverified: the setting names]** | The words in Q3.5 ("not to follow you across other websites") become untrue, and Google becomes a controller in its own right; my answer would change to PROFESSIONAL REVIEW REQUIRED before build |
| L-A5 | The FR-analytics-010–014 rules hold as built: no chat text, name, contact, reference, id, amount, promo code or stay detail ever reaches Google; S-13's path carries no query | If any reaches Google, this is a different review (and likely a breach of the tenant's own policy) |
| L-A6 | Guests include foreign visitors, possibly from the EU or the US | Whether a foreign law also applies is a lawyer's question (§ 6, LQ-7); I do not answer it |
| L-A7 | No tenant has yet asked for analytics in writing (`docs/product/analytics.md` § 3) | Q3.6's recommendation (a recorded instruction) is exactly for this |

## 2. The law I rely on, and how sure I am

I cite only what I am confident of from the text of RA 10173. None was re-read in this session; a lawyer should confirm each (LQ-1).

| What | Where | Confidence |
|---|---|---|
| Consent is a freely given, specific, informed indication of will, **evidenced by written, electronic or recorded means** | RA 10173 § 3(b) | High |
| Personal information is information from which an individual's identity is apparent or can reasonably and directly be ascertained, or which, put together with other information, would directly and certainly identify them | RA 10173 § 3(g) | High on the substance; whether a cookie id plus IP meets it is **not settled by the Act's words** (LQ-2) |
| Processing is lawful on one of several criteria, among them consent (§ 12(a)) and the legitimate interests of the controller or a third party, unless overridden by the data subject's rights (§ 12(f)) | RA 10173 § 12 | High |
| The controller remains **accountable** for personal information transferred to a third party for processing, **domestically or internationally**, and must use contractual or other reasonable means to give it a comparable level of protection | RA 10173 § 21 | High |
| The data subject's rights (to be informed, to object, access, correction, erasure or blocking, damages; portability) | RA 10173 §§ 16–18 | High |

What I **do not** rely on, because I could not verify it: any NPC circular or advisory specifically on cookies or web analytics; any NPC guidance on consent lifetimes; any Philippine rule on Global Privacy Control or Do Not Track. If such guidance exists, it overrides my reasoning below (LQ-3).

---

## 3. Q3 answered (M-004's six parts)

### Q3.1 · Does GA4 need prior consent for guests on S-1, S-6, S-13?

**Answer: yes. Treat it as needing prior, opt-in consent.** FR-analytics-006–008 stand for GA4 exactly as written.

- **Why it is personal information (a concern, not a settled point):** under L-A1, a cookie identifier that follows one browser from visit to visit, sent with an IP address to Google, plausibly lets a person "reasonably" be singled out when put together with other information. The Act does not name cookies. The cautious reading, which I take, is that it is personal information (LQ-2).
- **Why consent and not legitimate interests (§ 12(f)):** legitimate interests is arguable for counting visits, but here (a) the recipient is a third party outside the Philippines, (b) the guest gets nothing from it, (c) the house already rests the chat and booking on consent (`lib/legal.ts`, "The basis for this is your consent"), and (d) consent is cheap to build and a decline costs the guest nothing (FR-analytics-007). A lawyer may conclude legitimate interests suffices for a cookieless variant; that is not this build (LQ-4).
- **Consequence for the architecture:** "prior" means **the GA tag is not loaded and Google is not contacted at all** before Accept. If Theo finds that GA4's Consent Mode has a variant that sends "cookieless pings" to Google before consent (often called *advanced* mode **[unverified]**), that variant does **not** meet FR-analytics-006 and must not be used; only "load nothing until Accept" (*basic* **[unverified]**) does.
- **Evidence of consent (§ 3(b), "evidenced by … electronic or recorded means"):** the choice, the time and the tenant's policy version, stored on the device with the choice, plus the code path that loads nothing without it. I do **not** recommend a server-side consent log: it would need an identifier for an anonymous visitor, which is more data, not less. Whether the device record is enough evidence is LQ-5.

*The other three options*, for the record only (the user chose A): a truly cookieless means that stores nothing on the device and sends nothing linkable to a person (B, C) or keeps it in our own database with no identifier (D) would likely need **notice, not consent**; that depends on vendor facts nobody has verified and is now moot.

### Q3.2 · Is GA4 a cross-border transfer needing words or a contract?

**Answer: both.**

- **Treat it as a transfer outside the Philippines** (L-A2). The Act does not forbid it; § 21 keeps the **tenant** (the controller) accountable for it, through contractual or other reasonable means.
- **The contract:**
  1. **Google's data processing terms for Google Analytics** must be accepted in the GA account's admin settings **[unverified: Google offers such terms and where they are accepted]**. Theo verifies they exist and are accepted before the first event; the user, as account holder, accepts them.
  2. **The tenant–platform DPA (D-130) must cover analytics**: the purpose (counting visits and four funnel steps), Google as a sub-processor, and the transfer. A tenant whose DPA predates this must agree to the change (and today **no** tenant has a signed DPA on record, D-130's list; R-60). See Q3.6.
- **The words:** the tenant's privacy page names Google as a recipient and says the information is processed outside the Philippines (Q3.5's text). This also satisfies the right to be informed (§ 16).

### Q3.3 · How long may a guest's choice be kept on the device?

**Answer: 180 days, then ask again; and ask again at once when the tenant's policy version changes.**

- I know of no Philippine rule that sets this number (§ 2). 180 days is my recommendation: long enough not to nag a returning guest, short enough that a consent given once is not treated as permanent.
- **Accept and Decline are both kept 180 days.** A decline must be remembered as long as an accept, or the prompt nags the guest who said no (FR-analytics-007's equal prominence, in time).
- **Store with the choice:** the tenant slug (FR-analytics-008: per tenant), the time, and `policy_version` from `tenant_public()`. A version that no longer matches = no choice = the prompt again, with nothing loaded meanwhile.
- **GA's own cookie must not outlive the consent:** set GA's cookie lifetime to **no more than 180 days** **[unverified: GA4's default is about two years and is configurable]**. On a change to Decline, the app deletes GA's cookies it can reach and loads nothing from the next page load (FR-analytics-008).
- Storing the choice itself needs no consent: it is the record of the consent, and it carries nothing about the guest but the choice (reasoning, LQ-5).

### Q3.4 · The retention bound for events

**Answer: GA4's shortest event-data retention setting, about 2 months [unverified: GA4 offers 2 or 14 months on the standard tier], stated on the privacy page. Rhea's coupling to the chat period does not work as written; change FR-analytics-024.**

- **Why not "≤ the tenant's chat retention" (Rhea's proposal):** with one platform property (L-A3) there is ONE retention setting for every tenant, and a tenant's chat period may be as low as 30 days (D-131). The bound cannot follow each tenant's number. And 14 months would exceed villa's default 365 days.
- **Why 2 months:** the purpose is counts over 7, 30 and 90 days (FR-analytics-021). Event-level data that can be linked to a device is needed only long enough to make those counts; keeping it longer is not proportionate to that purpose.
- **What the 2 months governs** **[unverified]:** GA4's retention setting is said to apply to event-level and user-level data (used in explorations), while the standard aggregate reports are kept. Aggregate counts that identify nobody are not personal information, so keeping them is not a retention concern. **Theo must check that FR-analytics-021's 90-day view still works from aggregate reports with a 2-month setting**; if it does not, the answer is to shorten the view or ask me again, not to lengthen retention silently.
- **Proposed FR-analytics-024 wording (Rhea's to decide):** "Event-level analytics data is kept for the shortest period the recipient offers (stated on the privacy page as a number); aggregate counts with no identifier may be kept. The privacy page states both."

### Q3.5 · The words replacing "Guests are given no cookies" (`lib/legal.ts:95`)

**For a tenant with the switch OFF:** line 95 stays word for word (AC-19).

**For a tenant with the switch ON**, my proposed placeholder text, for the engineer to put in `lib/legal.ts` and for a lawyer to replace (R-60). Bracketed numbers are the values decided in Q3.3 and Q3.4; they are constants, never typed twice. It is shown whatever the visiting guest chose, because the page describes the tenant's practice.

- **"What is collected"**, replacing line 95:
  > "If you allow it, this website uses Google Analytics to count visits to the chat, the booking page and Manage booking, to see which website or campaign brought visitors here, and to count how many started a chat, saw a price, sent a booking request or found a booking. Google Analytics then keeps an identifier in a cookie on your device for up to [180] days. It is never sent what you type or say, your name, phone number or email address, your booking reference, or any price. It is not used to follow you across other websites or to show you advertising. If you do not allow it, nothing is collected for analytics and no analytics cookie is set."
- **"Why it is used"**, a new paragraph:
  > "To count how many people use this website and how they found it, so that [business name] can improve it. The basis for this is your consent, which you can refuse or withdraw without losing anything on this website."
- **"Who it is shared with"**, a new line before "Nobody else":
  > "Google, which provides Google Analytics, if you allow analytics. Google processes this information outside the Philippines, under data processing terms."
- **"How long it is kept"**, a new line:
  > "Analytics information that can be linked to your device: [2 months] at Google, then deleted. Totals made from it (such as the number of visits in a month) identify nobody and may be kept."
- **"Your choice"**, a new section with the control FR-analytics-008 requires:
  > "You can allow or refuse analytics, and change your choice at any time here. Your choice is remembered on this device for [180] days, for [business name] only. If your browser sends a Global Privacy Control or Do Not Track signal, it is treated as a refusal unless you allow analytics here."

The chat's welcome notice and the voice notice ("Nothing is recorded or kept", D-134) stay true and unchanged: no voice event exists (FR-analytics-019).

**Bump the tenant's `policy_version` when the switch first goes on** (or when this text changes). A new booking request then asks for agreement to the new version (D-129), and every stored analytics choice is re-asked (Q3.3).

The **"Who is responsible"** paragraph ("processes the information only on [business]'s instructions") stays true **only** under Q3.6's conditions.

### Q3.6 · Who is the controller of analytics data under one platform account?

**Answer: the tenant should be the controller and the platform its processor, as for everything else (D-129). That holds only if the platform uses the data solely for the tenant. As soon as the platform uses a tenant's analytics for its own purposes, the platform is a controller for that use, and that is a lawyer's question (LQ-6).**

- **Who decides the purpose decides the role.** With one platform-held property, the platform holds every tenant's events. Holding them does not make the platform a controller; deciding why they are processed does.
- **US-3 is the risk:** "the operator wants visits per tenant, to show a prospective resort what the product reaches." That is the platform's purpose, not the tenant's. If it uses **aggregate counts only** (visits, steps; nothing per device), those are probably not personal information and the concern is small. If the operator uses event-level data (explorations, per-device paths) for its own ends, the platform is acting as a controller, and today's privacy page ("only on [business]'s instructions") would be untrue for analytics.
- **Recommendations:**
  1. **The super user switches analytics on only on the tenant's written instruction**, recorded the way the DPA date is (D-130: a date on the Legal tab). Today FR-analytics-001 lets a super user switch it on alone, so this is a requirements change and Rhea decides (§ 5).
  2. **The DPA covers it** (Q3.2): the purpose, Google as sub-processor, the transfer, and whether the platform may use **aggregate** counts for its own purposes.
  3. **The operator's own use is limited to aggregate counts**, written into the DPA. Event-level exploration of a tenant's data is for that tenant's purposes only.
  4. **Google stays a processor**: L-A4's settings OFF. If any of them is turned on, Google uses the data for its own purposes as well **[unverified]**, and this answer no longer holds.
- **A property per tenant** (the alternative, K6), held in the tenant's own Google account: the tenant is clearly the controller, Google its processor under terms the tenant accepts, and the platform only installs the tag. It is legally the cleaner shape and the operator loses US-3's view. That trade-off is the user's, through Rhea and Theo. Either is defensible with the recommendations above.

## 4. Q9 answered: GPC and DNT

**Answer: honour both as a Decline. This is a recommendation, not a requirement I can verify.**

- I know of no Philippine law or NPC issuance that requires either signal to be honoured (§ 2; LQ-3). Some other jurisdictions do give GPC legal effect for some purposes **[unverified; not applicable here as far as I know]**.
- **Why honour them anyway:** a guest who set GPC or DNT has said in advance that they object. Measuring them after an "Accept" that they clicked anyway is defensible, but showing them the prompt at all contradicts a signal they already sent. It is one line of code, it can only reduce what is collected, and the purpose (counts) survives a small undercount.
- **Proposed behaviour (Rhea's to write as an FR):**
  - with `navigator.globalPrivacyControl === true` or a DNT signal of `"1"` **[unverified: the exact browser properties, Theo]**, the prompt is **not shown**, nothing loads, and the guest counts as declined;
  - the control on the privacy page still lets that guest **explicitly** allow analytics, because a deliberate act on that page is clearer than a browser default; that explicit choice is then kept like any other (Q3.3);
  - the privacy page says so (Q3.5's "Your choice").

---

## 5. What changes, and for whom

| # | Concern | Impact | Remediation | Owner |
|---|---|---|---|---|
| 1 | Prior consent for GA4 (Q3.1) | Without it, measuring guests likely has no lawful basis I would rely on | FR-006–008 stand. Load nothing before Accept; no "cookieless pings" mode | Theo (design), Uma (screen) |
| 2 | Cross-border transfer (Q3.2) | Tenant accountable for Google's handling abroad (§ 21) | Accept Google's GA data processing terms; name Google and the transfer on the privacy page; DPA covers it | Theo verifies; user accepts; lawyer drafts the DPA |
| 3 | Consent lifetime (Q3.3) | A forever-consent is weak evidence of a current choice | 180 days for both choices; re-ask on a policy version change; GA cookie ≤ 180 days | Rhea (FR-008), Theo |
| 4 | Retention (Q3.4) | FR-024 cannot be met per tenant with one property; 14 months would exceed villa's chat period | 2 months (shortest), stated; aggregates kept; check the 90-day view | Rhea (FR-024), Theo |
| 5 | Privacy text (Q3.5) | The page would be untrue (R-60, K5) | § 3 Q3.5's words, per tenant; bump `policy_version` | Rhea (FR-019), engineer later; a lawyer replaces |
| 6 | Controller (Q3.6) | A super user can switch on a tenant's measurement with no instruction; US-3 may make the platform a controller | Tenant's recorded instruction before the switch; DPA covers it; operator uses aggregates only; Google's sharing settings off | Rhea (an FR), Theo (property shape), user |
| 7 | GPC / DNT (Q9) | None required; a trust and minimisation gain | Treat as Decline; explicit opt-in on the privacy page | Rhea (an FR), Theo |

**Advisory position (not a gate verdict):** proceed to architecture on these answers. Requirements need small revisions (items 3, 4, 6, 7: Rhea's). Before any **real guest** is measured, a lawyer should confirm § 6 (the same bar as R-60: placeholders block real guests, not the build).

## 6. Where a lawyer must look

- **LQ-1:** Confirm the readings of RA 10173 §§ 3(b), 3(g), 12, 16–18 and 21 in § 2, and whether the IRR or any NPC circular adds anything for this case.
- **LQ-2:** Is a GA cookie identifier sent with an IP address to Google "personal information" under § 3(g) for an anonymous resort visitor?
- **LQ-3:** Has the NPC issued guidance on cookies, web analytics, consent lifetimes, or browser privacy signals (GPC, DNT)? I found none and did not search.
- **LQ-4:** Is consent the right basis for GA4 analytics, or does legitimate interests (§ 12(f)) suffice? (The product is built for consent either way; this decides only the page's words.)
- **LQ-5:** Is a choice stored on the guest's own device, with time and policy version, sufficient evidence of consent under § 3(b)'s "written, electronic or recorded means"?
- **LQ-6:** Under one platform-held GA4 property, with the operator reading aggregate counts per tenant for its own sales purposes (US-3), is the platform still only a processor? What must the tenant–platform DPA say?
- **LQ-7:** Do foreign laws (for example the EU's GDPR or US state laws) reach a Philippine resort's site because some guests are foreign? I give no view.
- **LQ-8:** Google's own terms for Google Analytics may require the site to disclose its use and obtain consent where law requires **[unverified]**. Read them with Google's data processing terms when the account is set up.
- **LQ-9:** Does adding analytics affect any tenant's registration or privacy impact assessment duties with the NPC? I do not know the thresholds well enough to say.

## 7. What I refused, in one line each

- A citation of an NPC circular I could not read: none is given.
- A statement that GA4 "complies" with RA 10173: no configuration guarantees it.
- Editing `lib/legal.ts`: Q3.5's words go to the engineer through Rhea's FR-019, as the reason for that task.
