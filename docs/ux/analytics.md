# Analytics (GA4) on the public pages: UX architecture (gate 3)

- **Idea:** `analytics`, full lane. Gate 2 APPROVED by the user 2026-10-28: Q1 = **A, GA4**; Q2, Q4, Q5, Q7 take Rhea's defaults.
- **Task:** T-007, from the user.
- **Written by:** Uma, UX Architect, 2026-10-28.
- **Status of the feature:** **Planned.** Nothing here is built.
- **Spent:** nothing (Rule 7). No dev server, no browser, no OpenAI call. The screens were read in code, not looked at.
- **Read:**
  - `docs/product/analytics.md`, `docs/requirements/analytics.md` (FR-analytics-001…025, AC-01…24), `docs/legal/analytics.md` (Lex's advice, Q3 and Q9);
  - Rhea's inbox: M-007 (the user's answers) and M-008 (Lex's seven points, not yet written into the FRs);
  - `app/t/[tenant]/layout.tsx`, `page.tsx` (S-1), `book/page.tsx` (S-6), `manage/page.tsx` (S-13), `privacy/page.tsx`;
  - `components/chat-screen.tsx` (the composer and its fine print), `booking-page.tsx` (the D-129 consent box, the sticky summary), `manage-booking.tsx`, `public-footer.tsx`, `legal-page.tsx`, `lib/legal.ts` (line 95);
  - the styles' fixed and sticky elements (`screens.css`: `.book-summary`, `.manage-summary`, `.date-pop` fixed to the bottom below its breakpoint).

## 0. What this file decides, and what it does not

**It decides:** where and how a guest is asked about analytics, what each answer does on the screen, how the guest changes their mind, and every state of those two pieces of UI on the three measured pages and the tenant privacy page.

**It does not decide:** the GA4 configuration, the events' wiring, the CSP (Theo, with R-55); the final privacy words (Lex proposed, Rhea writes FR-019, a lawyer replaces, R-60); who reads the numbers and where (FR-021, Q2: in GA4's own tool, so **no new app screen**).

### Assumptions (stated, not asked: T-007 says ask nothing)

| # | Assumption | If wrong |
|---|---|---|
| U-A1 | Rhea adopts Lex's M-008 points 3 and 7 as FRs: both choices kept **180 days**, re-asked when the tenant's `policy_version` changes; **GPC / DNT = Decline**, no prompt, with an explicit allow on the privacy page. This file designs those states and marks them **[if FR]**. | Drop the rows marked [if FR]; nothing else moves. |
| U-A2 | One platform-held GA4 property (Lex's L-A3, Q2's default). FR-020's per-tenant setting therefore does not exist, and the platform form gains a switch only. | If a per-tenant measurement ID is chosen, § 6.2 gains one text field beside the switch, refused by shape with a sentence (AC-20). |
| U-A3 | Lex's new controller FR (point 6: switch on only on the tenant's recorded written instruction) may be written. § 6.2 shows how the switch reads if it is **[if FR]**. | The switch is a plain switch, like voice's. |
| U-A4 | The page chrome stays English, like every other guest-page string. The chat's Taglish is the model's, not the page's. | Words are Rhea's/Lex's to translate; layout is unchanged. |
| U-A5 | Public pages have no `<Toaster />` (only StaffFrame and the platform host one, D-102). This file does not add one. | See § 5.4. |

## 1. Sitemap: where this sits among S-1…S-18

**No new screen, no new route, no new nav item** (`lib/nav-items.ts` unchanged; D-136's three guest links unchanged).

```
/t/<slug>                S-1  chat ............ + ConsentBar (above the composer)       measured
/t/<slug>/book           S-6  booking page .... + ConsentBar (under the brand band)     measured
/t/<slug>/manage         S-13 Manage booking .. + ConsentBar (under the brand band)     measured
/t/<slug>/privacy        (unnumbered) ......... + "Your analytics choice" section, #analytics   NOT measured
/t/<slug>/terms          unchanged                                                      not measured
/t/<slug>/admin/**       S-2…S-5, S-7…S-11, S-14…S-18: unchanged, never measured, never a bar
/t/<slug>/admin/dashboard S-11: unchanged (FR-023: no analytics figure drawn)
/platform → tenant form → Features tab ... + "Analytics" switch, group "Guest pages"
/platform → tenant form → Activity tab ... + rows "turned Analytics on/off" (FR-025)
/ , /privacy, /terms     unchanged (Q5 = no)
```

## 2. Screen and component inventory

| Item | Where | New / changed | Shown when |
|---|---|---|---|
| **ConsentBar** (one component, three callers) | S-1, S-6, S-13 | New | Switch ON **and** the page rendered (not a 404) **and** no valid stored choice for this tenant **and** storage writable **and** no GPC/DNT [if FR] |
| **AnalyticsChoice** (the control) | Tenant privacy page, its own section `id="analytics"` | New | Switch ON. Absent when OFF (nothing to choose) |
| Privacy text (Lex Q3.5) | Tenant privacy page | Changed per tenant | ON: Lex's paragraphs; OFF: line 95 word for word (AC-19) |
| Features tab row "Analytics" | Platform tenant form | New row | Always (super users) |
| Activity row | Platform Activity tab, S-18 | New sentence in `activityWords` | After a switch change |
| D-129 booking consent box | S-6 summary | **Unchanged** | As today (FR-009) |
| Voice notice, chat fine print | S-1 | **Unchanged** | As today (FR-019) |

## 3. User journeys

### J-1 · Guest, first visit, allows (W-1a)
| Step | Guest does | Guest sees | Measurement |
|---|---|---|---|
| 1 | Opens `/t/villa` | Welcome card, composer focused (autofocus kept), the ConsentBar above the field | Nothing loaded (FR-006) |
| 2 | Types, sends; or clicks a suggested question | The reply, as today. The bar stays where it was | Nothing (no retroactive `chat_started`) |
| 3 | Clicks **Allow** | The bar disappears; the field keeps or regains focus; "Analytics allowed." is announced | GA loads in the background; this load's page view is recorded (FR-015) |
| 4 | Follows "Book a stay" | S-6 with **no bar** (the choice is per tenant, kept) | Page view; `quote_shown`, `request_sent` on success |

### J-2 · Guest declines (W-1b, US-4)
Opens any measured page → **Don't allow** → the bar disappears, "Analytics not allowed. You can change this on the privacy page." is announced → every later villa page for 180 days [if FR] shows no bar and loads nothing. Chat, quote, request, lookup all work (AC-07).

### J-3 · Guest ignores the bar
Uses the page fully without answering (AC-08). Nothing is measured. On the next measured page load the bar is shown again in the same quiet place. Ignoring is never stored as a choice (FR-006), so there is **no close (×) button**: a × would be an ambiguous third answer.

### J-4 · Returning guest
Within 180 days [if FR], same tenant, same `policy_version`: no bar, the stored choice applies. After 180 days, or after the tenant's `policy_version` changes (the switch first going on bumps it, Lex Q3.5): the bar again, nothing loaded until answered.

### J-5 · Guest changes their mind (FR-008, US-4)
From the bar's link "How we use analytics", or from any footer's **Privacy** link → the privacy page, section "Your analytics choice" → reads the current choice → clicks the one button that reverses it → the status line updates at once. Effect from the next page load (FR-008).

### J-6 · Guest with GPC or DNT [if FR]
Opens any measured page → **no bar**, nothing loads. On the privacy page the control says why and offers "Allow analytics anyway".

### J-7 · Guest books (FR-009, AC-10)
Bar at the top of S-6; the D-129 box at the bottom of the summary, unticked, required, worded as today. The two never share a word ("Allow" vs the box's agreement), a place, or a control type (buttons vs a checkbox). Answering one changes nothing in the other.

### J-8 · Guest from a receipt link (K2, W-3)
Opens `/t/villa/manage?ref=VIL-ABC123` → the reference is pre-filled as today; the bar is shown under the brand band. Allowing records the path only (FR-011; Theo's). The bar's privacy link carries no query.

### J-9 · Super user switches it on / off (W-4, W-5, US-6)
`/platform` → tenant → **Features** → "Analytics" (group Guest pages) → switch → **Save** (the form's save bar, as for every feature) → a toast "Saved" (D-102, the platform has a Toaster) → the Activity tab shows the row. Next page load of S-1/S-6/S-13: the bar (everyone is re-asked, the version was bumped); the privacy page shows the analytics text and the control. Off: no bar, no control, line 95 back.

### J-10 · Owner wants the numbers (US-1, US-2)
Out of the app: GA4's own reports, access granted by the operator (Q2 default). S-11 is unchanged and shows nothing about analytics (FR-023).

## 4. User flows

### F-1 · The bar on a measured page load

```
page request
  └─ 404? (unknown slug, archived, feature/application off, no priced unit) ──► not-found page, NO bar, nothing loads (FR-004)
  └─ switch OFF ─────────────────────────────────────────────────────────────► page as today, NO bar (FR-005)
  └─ switch ON
       └─ GPC or DNT set, and no explicit allow stored [if FR] ────────────────► page, NO bar, nothing loads
       └─ storage not writable (private mode, blocked) ───────────────────────► page, NO bar, nothing loads (§ 8 of the FRs)
       └─ stored choice for THIS tenant, same policy_version, < 180 days
            ├─ Allow ───► page, NO bar, GA loads in background, page view
            └─ Decline ─► page, NO bar, nothing loads
       └─ otherwise (none / expired / other version) ──────────────────────────► page + ConsentBar, nothing loads
             ├─ "Allow"        → store {allow, time, version} → remove bar → focus (§ 5.3) → announce → GA loads → page view
             ├─ "Don't allow"  → store {decline, time, version} → remove bar → focus → announce
             └─ no answer      → page works in full; nothing stored; bar again next load
```

The page's own render never waits on any branch: the decision is made on the device after the page is drawn, and the bar appears in a reserved slot (§ 5.5), so nothing jumps.

### F-2 · The privacy-page control

```
privacy page (switch ON)
  └─ section "Your analytics choice" (#analytics)
       state ─┬─ no choice ............ "You have not chosen yet."          [Don't allow] [Allow]
              ├─ allowed (date) ....... "Allowed on this device since 28 Oct 2026."   [Stop analytics]
              ├─ declined (date) ...... "Not allowed on this device since 28 Oct 2026."  [Allow analytics]
              ├─ GPC/DNT [if FR] ...... "Your browser asks sites not to track you, so analytics is off." [Allow analytics anyway]
              └─ storage blocked ...... "This browser is not keeping choices for this site, so nothing is measured."  (no button)
  click → store → the status line rewrites itself (role="status") → "This applies from the next page you open."
```

## 5. Interaction specification

### 5.1 The ConsentBar: content

```
┌───────────────────────────────────────────────────────────────────────┐
│ Analytics                                                    (h2)     │
│ Villa Esperanza would like to use Google Analytics, which keeps a     │
│ cookie on this device, to count visits and where they come from.      │
│ It never receives what you type, your contact details or your         │
│ booking.  How we use analytics ↗(privacy#analytics)                   │
│                                        [ Don't allow ]  [ Allow ]     │
└───────────────────────────────────────────────────────────────────────┘
```

- **Words:** two sentences (FR-007), naming the recipient (Google Analytics), what is measured, the cookie (Lex Q3.1: informed), and what is never sent. The words are a **placeholder for Rhea / Lex**; the layout holds two sentences of this length. The business name is `businessName`, as everywhere.
- **Link:** "How we use analytics" → `/t/<slug>/privacy#analytics`, same tab. A normal link, not a button. It does not answer the bar.
- **Buttons:** "Don't allow" then "Allow". **Same element, same class (`.button`, neither `primary`), same size, same weight** (FR-007, AC-08). Decline first in reading order, so the equal pair is not read as "yes, or the small no". No × close.
- **Not the booking box's words:** never "I agree", "Accept terms", never a checkbox (FR-009).

### 5.2 The ConsentBar: semantics

- A `<section aria-labelledby="analytics-title">` with a visible `<h2 id="analytics-title">Analytics</h2>` (small, `.small`-sized heading styling is Vera's). A named region, so axe's region rule holds and a screen reader can jump to it.
- **Not a dialog.** No `role="dialog"`, no `aria-modal`, no focus trap, no backdrop, no `inert` on the page. Escape does nothing to it (Escape must never be a silent Decline; on S-1 Escape belongs to voice, D-134).
- **Focus is not moved to it on load.** S-1 keeps its autofocused field; S-6 and S-13 keep theirs. It is reachable by Tab in document order (S-6/S-13: right after the header; S-1: Shift+Tab from the field).
- One persistent visually-hidden `role="status"` (polite) per page, present from first render, carries the announcement after an answer (§ 3, J-1/J-2).

### 5.3 After an answer

| | S-1 | S-6 | S-13 |
|---|---|---|---|
| Bar | removed | removed | removed |
| Focus, if it was on a bar button | the chat field `#input` | the `<main>` (tabindex -1), so the next Tab is the first field | the `<main>`, same |
| Focus, if it was elsewhere | untouched | untouched | untouched |
| Announced | "Analytics allowed." / "Analytics not allowed. You can change this on the privacy page." |||
| Page state | untouched: the typed text, the quote, the form, the found stay stay as they were |||

### 5.4 Feedback (D-102)

- Answering the bar is an **action**, so D-102 would make its result a toast. Guest pages have no Toaster (U-A5), and the result is visible by itself (the bar goes) and announced (the status region). **Decision: no toast on guest pages.** A Toaster on the three guest pages for one message is more machinery than the result needs. Vera may overrule on visual grounds; it stays within D-102's spirit (the result is shown once, and not as a standing banner).
- The privacy control's state is a **standing fact**, so it is a line of text that rewrites itself (role="status"), not a toast.
- GA failing, slow or blocked: **nothing is shown, ever** (FR-018). No `.notice`, no console-visible error the guest sees, no spinner on any button.
- No **loading** state anywhere: the choice is local; GA loads after it in the background, and nothing waits on it.
- No **empty** state: no list is added.

### 5.5 Placement, and why

| Page | Place | Why |
|---|---|---|
| **S-1** | Inside the composer section, **above the form**, above `VoiceStatus` | The chat has no header and `<main>` scrolls: a bar at the top of the messages would scroll away, and one fixed over them would cover the reply. Above the field it is where the guest is looking and typing, in the page's flow, and it shortens the message area instead of covering it. The floating "New chat" button sits at the layout's top corner, so a bar at the top of the layout would collide with it. |
| **S-6** | In the flow, **between the brand band and `<main>`**, at the content width of `.book-main` | A bottom-fixed bar would sit on the phone's DateField popover (`.date-pop` is fixed to the bottom below its breakpoint) and on the request button. Under the band it is on the first screen at 375 and covers nothing. It is far from the D-129 box (the summary's foot), which keeps the two apart (FR-009). |
| **S-13** | Same as S-6 | One rule for the two pages with a brand band. |

**The rule for all three:** in the page's flow, never fixed, never over content, never blocking (FR-007). Its slot is reserved only when it will show; the decision is made before first paint of the bar's slot so the page below does not jump after the guest starts reading (Theo: decided from storage on the client before the bar's first render, rendered nothing on the server; a one-frame late insert above S-6's form is the accepted cost, and it lands above the fold, before any field could have been focused).

### 5.6 Navigation rules

- The bar adds **no** nav item. Its one link goes to the privacy page anchor.
- The privacy page's control is reached from: the bar's link, the Privacy link in every guest footer and in the chat's fine print (unchanged, D-129).
- Across the three pages of one tenant the answer is shared (one choice per tenant, FR-008); across tenants it is not (AC-09). The operator demoing villa then alteza sees alteza's bar: expected, not a bug.
- Staff pages, the platform, privacy, terms and every 404: **never** a bar (FR-003, FR-004).

## 6. Wireframes (low fidelity)

### 6.1 S-1, chat

**375 px**
```
┌─────────────────────────────┐
│  [ banner / accent cover ]  │
│        (mark)               │
│   Hi, I'm Mara              │  <main> scrolls
│   Villa's assistant         │
│   welcome line …            │
│   [suggested question  >]   │
│   [Book your stay] [Manage] │
│                             │
├─────────────────────────────┤  composer section
│ Analytics                   │
│ Villa would like to use     │
│ Google Analytics, which     │
│ keeps a cookie on this      │
│ device, to count visits and │
│ where they come from. It    │
│ never receives what you     │
│ type, your contact details  │
│ or your booking.            │
│ How we use analytics        │
│ [ Don't allow ][  Allow   ] │  two equal halves
├─────────────────────────────┤
│ [Ask a question…    ](🎤)(↑)│
│ Mara is an AI assistant …   │
│ Book · Manage · Privacy …   │
└─────────────────────────────┘
```
At 375 the bar is about 9 short lines; Vera should tighten type and spacing so it stays under roughly a third of the visible height with the keyboard open (UX risk R-U1). The buttons share one row, each half the width, each at least 44 px tall.

**1280 px**
```
                ┌──────────────────────────────────────────────┐
  messages      │ Analytics                                    │
  (centred      │ Villa would like to use Google Analytics, …  │
   column)      │ … your booking.  How we use analytics        │
                │                         [Don't allow][Allow] │
                ├──────────────────────────────────────────────┤
                │ [Ask a question…                    ](🎤)(↑) │
                │ notice · links              Enter to send …  │
                └──────────────────────────────────────────────┘
```
The bar is the composer's width (the same column as `.composer-inner`), text on the left, the buttons on the right on one row.

### 6.2 S-6 and S-13

**375 px**
```
┌─────────────────────────────┐
│ ▔▔ accent stripe ▔▔         │
│ (logo) Villa   Need help?…  │  BrandHeader + TenantNav
│ ┌─ brand band ────────────┐ │
│ │  Online booking         │ │
│ └─────────────────────────┘ │
│ ┌─ Analytics ─────────────┐ │  ConsentBar (card, in flow)
│ │ two sentences …         │ │
│ │ How we use analytics    │ │
│ │ [Don't allow][ Allow  ] │ │
│ └─────────────────────────┘ │
│ <main> the form as today    │
│ … summary … D-129 box □     │  unchanged, far below
│ footer                      │
└─────────────────────────────┘
```

**1280 px**
```
┌──────────────────────────────────────────────────────────────┐
│ header + brand band                                          │
├──────────────────────────────────────────────────────────────┤
│ ┌ Analytics ─────────────────────────────────────────────┐   │  .book-main width
│ │ two sentences …  How we use analytics  [Don't allow][Allow]│
│ └────────────────────────────────────────────────────────┘   │
│ ┌ form ─────────────────────────┐ ┌ summary (sticky) ─────┐  │
│ │                               │ │ … □ I agree (D-129)   │  │
└──────────────────────────────────────────────────────────────┘
```
The sticky `.book-summary` / `.manage-summary` keep their `top` offsets: the bar is in the flow above them, not over them.

### 6.3 Tenant privacy page, "Your analytics choice"

```
## What is collected            (Lex's analytics paragraph replaces line 95 when ON)
## Why it is used               (+ Lex's paragraph)
## Who it is shared with        (+ "Google, … outside the Philippines …")
## How long it is kept          (+ "[2 months] at Google …")
## Your analytics choice   ← id="analytics"   (new, only when ON)
   Lex's "Your choice" paragraph.
   ┌──────────────────────────────────────────────┐
   │ Not allowed on this device since 28 Oct 2026.│  role="status"
   │ [ Allow analytics ]                          │
   └──────────────────────────────────────────────┘
## Your rights …
```
- The section sits **after "How long it is kept" and before "Your rights"**, so the reader has the facts before the control.
- `LegalBody` draws paragraphs only today; the control is a Client Component placed in that section (the engineer's shape; flagged to Theo).
- The date is the tenant's date words (`D-142` style "28 Oct 2026"), on the device's clock: it is the guest's own record.
- A deep link `#analytics` scrolls the heading to the top, below nothing sticky (the public pages have no sticky header).

### 6.4 Platform tenant form, Features tab

```
Guest pages
  Online booking page          [on ]
  Manage booking               [on ]
  Voice                        [off]
  Analytics                    [off]   Counts visits on the chat, booking page and Manage booking
                                       with Google Analytics, after each guest allows it.
  [if FR] (switch disabled)    "Record the resort's written instruction on the Legal tab first."  ← visible text, not a title
```
Same native switch control as the other features; the explanation is visible text (D-102: a reason is a Tip or text, never only a `title`). Saved by the form's save bar; result a toast.

## 7. States, complete

| Surface | State | What shows |
|---|---|---|
| ConsentBar | Switch off / 404 / not a measured page | Nothing |
| | No choice, expired, or version changed | The bar |
| | Choice stored (either) | Nothing |
| | GPC/DNT [if FR] | Nothing |
| | Storage not writable | Nothing (asking would be pointless: nothing can be kept, nothing is measured) |
| | Just answered | Bar removed, status announced |
| | GA blocked / failed / slow | Nothing different from "allowed" (FR-018) |
| | Switch flipped while the page is open | Unchanged until reload (edge 10) |
| AnalyticsChoice | No choice / allowed / declined / GPC [if FR] / storage blocked | § 4 F-2 lines |
| | Just changed | Status line rewritten + "This applies from the next page you open." |
| | Switch off | The whole section absent |
| Privacy text | On / off | Lex Q3.5 / line 95 unchanged |
| Features row | Off (default, no row) / on / disabled [if FR] | § 6.4 |

## 8. Accessibility requirements

The a11y walks end at 0 violations; this feature keeps them there.

1. The bar is a labelled region with a visible `h2`; the heading order on each page stays valid (S-1's `h1` is the hidden business name; S-6/S-13 have their own `h1`).
2. Both buttons are native `<button type="button">`, visible text labels, ≥ 44 × 44 px, a visible focus ring from `tokens.css`, and the same contrast as every `.button` (both schemes, and a theme pinned light, D-101).
3. No `title` attributes (D-102). The link's purpose is in its text.
4. Not modal, no trap, no auto-focus on load, no timeout, no auto-dismiss.
5. The answer is announced through a persistent polite `role="status"`; focus is placed per § 5.3 so it is never lost to `<body>`.
6. The privacy control: the status line is `role="status"`; the button's label says what it will do ("Allow analytics", "Stop analytics"), never a toggle with an ambiguous pressed state.
7. Text reflows at 320 px and at 200 % zoom with no horizontal scroll; the two buttons wrap to two rows, each full width, below 320 px.
8. Respect `prefers-reduced-motion`: the bar appears and disappears with no animation under reduce (Vera may fade it otherwise).
9. **Walk additions** (for the engineer's walk and axe script, plan § 6.3): the bar shown on S-1, S-6, S-13 at 375 and 1280, light and dark; the five privacy-control states; keyboard-only completion of a chat, a quote and a lookup with the bar unanswered (AC-08).

## 9. Responsive behaviour

| | 375 | 1280 |
|---|---|---|
| S-1 bar | Full composer width; text stacked; buttons one row, 50 % each | Composer column width; text left, buttons right, one row |
| S-6 / S-13 bar | Full content width card under the band; buttons one row, 50 % each | `.book-main` width card; text and buttons on one row |
| Privacy control | Full width; button full width | Text column width; button natural width |
| Tap targets | ≥ 44 px tall; the bar has no field, so `--text-touch` (D-142's zoom rule) does not apply to it | — |

## 10. Requirements trace

| FR / AC | Where this file meets it |
|---|---|
| FR-004, AC-04 | § 4 F-1 first branch; § 5.6 |
| FR-005, AC-05 | F-1; J-9 |
| FR-006, AC-06 | F-1: nothing until Allow; J-1 step 2 |
| FR-007, AC-08 | § 5.1 equal buttons, two sentences, recipient named, privacy link; § 5.2 not modal; § 5.5 in flow |
| FR-008, AC-09 | J-4, J-5, § 6.3, § 5.6 per tenant |
| FR-009, AC-10 | J-7; § 5.1 last point; § 5.5 S-6 |
| FR-011, 013 | J-8; the bar's link carries no query |
| FR-018, AC-18 | § 5.4, § 7 |
| FR-019, AC-19 | § 6.3; voice notice unchanged |
| FR-023, AC-22 | § 1: S-11 unchanged; J-10 |
| FR-025, AC-24 | J-9, § 2 |
| Lex Q3.3, Q9 [if FR] | J-4, J-6, F-1, F-2 |

## 11. UX risks and recommendations

| # | Risk | Recommendation | Owner |
|---|---|---|---|
| R-U1 | On a 375 phone with the keyboard open, the bar above the chat field eats the conversation's height | Vera keeps it compact (small type, tight spacing); the words stay at two sentences. If it still exceeds a third of the visible height, shorten the words (Rhea/Lex), not hide the buttons | Vera, Rhea |
| R-U2 | The bar returns on every measured page until answered (three pages) | Accepted: ignoring cannot be stored (FR-006). The bar is quiet and in flow, never in the way | — |
| R-U3 | A guest confuses the bar with the booking agreement | Different words, place and control type (§ 5.1, § 5.5) | Vera |
| R-U4 | Undercount (declines, GPC, blockers, storage blocked) makes owners distrust GA beside S-11 | FR-023 already keeps them apart. A one-line caveat in whatever the operator sends owners | Rhea (if wanted) |
| R-U5 | `?ref=` stays in S-13's address bar after pre-fill, so it rides into the chat link's referrer and any copied URL | **Proposal needing approval (new behaviour):** after pre-filling, S-13 removes `?ref=` from the address bar (history replace). Sent to Rhea as a proposal; not a requirement until she writes it | Rhea |
| R-U6 | A consent given on S-1 before the first message misses `chat_started` for a guest who allows only after chatting | Accepted: no retroactive events (FR-006). Noted for Theo so the count's meaning is documented | Theo |
| R-U7 | The privacy control lives on a page whose renderer draws paragraphs only | A Client Component inside the section; the page stays unmeasured | Theo |
| R-U8 | Lex's 180 days, version re-ask, GPC and the controller FR are advice, not yet FRs | Designed as [if FR]; nothing else depends on them | Rhea |

## 12. What I refused, in one line each

- An in-app analytics screen on S-11 or elsewhere: FR-021 with Q2's default reads in GA4; no requirement holds one.
- Removing `?ref=` from S-13's address bar as a requirement: it is new behaviour, proposed to Rhea (R-U5).
- A toast host on guest pages: more than this needs (§ 5.4).
