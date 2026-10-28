# Analytics (GA4) on the public pages: visual design (gate 4)

- **Idea:** `analytics`. Gate 3 DONE (Uma, `docs/ux/analytics.md`). Task T-009, Uma's M-010.
- **Written by:** Vera, Visual Designer, 2026-10-28.
- **Status of the feature:** **Planned.** Nothing here is built.
- **Spent:** nothing (Rule 7). No dev server, no OpenAI call. The browser tools were not granted in this session, so **nothing was rendered**: every height below is arithmetic from the tokens, marked *est.*, and the engineer's walk measures it (§ 9).
- **Read:** `docs/ux/analytics.md`; `app/styles/tokens.css`, `base.css` (buttons, `.card`, `.notice`, `.visually-hidden`, `main`), `chat.css` (`.composer*`, `.voice-status`), `screens.css` (`.book-main`, `.book-summary`, `.legal-*`, `.feature-row`, `button.switch`); `components/chat-screen.tsx` (the composer), `booking-page.tsx`, `manage-booking.tsx`, `legal-page.tsx`, `features-panel.tsx`, `icons.tsx`.
- **Mockup:** `docs/design/analytics/mock.html`, a static page that loads the app's four stylesheets and adds only the `.consent-*` rules of § 3. Open it as a file (`?page=chat|book`, `?words=long|short`). It is a picture of the spec, not app code.

## 0. What this file decides

The look of the three new pieces Uma specified: the **ConsentBar** (S-1, S-6, S-13), the **AnalyticsChoice** control (tenant privacy page, `#analytics`), and the **Analytics** row on the platform's Features tab. Every value is a token of `tokens.css` or an existing rule; **no new token, no new colour, no new icon**.

### Assumptions (stated, not asked)

| # | Assumption | If wrong |
|---|---|---|
| V-A1 | The words are Uma's placeholder until Rhea/Lex write them. The layout is sized for **≤ 130 characters** of sentence at 375 (§ 5); the placeholder is 205. | Longer words make the bar taller than a third of the screen with the keyboard open (R-U1). The fix is shorter words, never smaller type or hidden buttons. |
| V-A2 | The house touch height (`button` at 40 px under `pointer: coarse`, base.css) is the bar's button height, not Uma's 44 px. | See § 7, deviation D-V1. |
| V-A3 | The Features tab saves a switch **at once** (`features-panel.tsx`: `onSwitch` → the form's `send()`), not through a save bar as J-9 says. The design follows the code. | None: the toast "Saved" is unchanged either way. |
| V-A4 | Rows marked **[if FR]** (180 days, GPC/DNT, the controller instruction) depend on Rhea adopting Lex's M-008. Designed; drop them if not adopted. | Nothing else moves. |

## 1. Design decisions (and the one place I overrule)

1. **Quiet, equal, in flow.** The bar is a plain panel card (the `.card` family: `--panel`, `1px --line`, `--radius-lg`), no shadow (tokens.css: shadows are for things that float; this does not float), no accent fill, no icon. It must not look like the booking page's call to action, nor like a warning (`.notice.warn` is the legal draft banner).
2. **Both buttons are the default `button`** (quiet, hairline, `--panel`, `--ink` text). Not `.primary`, not `.ghost`, not `.sm`. Same width (a two-column grid of `1fr 1fr`), same height, same weight 500. "Don't allow" first. A filled "Allow" would be the nudge FR-007 forbids; a ghost "Don't allow" would be the "small no".
3. **The heading runs in.** The `h2` "Analytics" is visible, in `--ink` weight 600, at the text's own size, *inline* before the sentences. It saves a whole line at 375 (R-U1) and keeps axe's region and heading rules.
4. **No toast on guest pages** (Uma § 5.4): **agreed, not overruled.** The bar vanishing is the visible result; the polite status region is the spoken one. A Toaster would add a floating layer on S-6 where `.date-pop` already owns the phone's bottom edge.
5. **No animation.** The bar appears and goes in one frame. Nothing to switch off under `prefers-reduced-motion`, and no fade means no moment where it is half-visible and half-clickable.
6. **No icon anywhere.** `icons.tsx` is unchanged. An info glyph would add weight to a block whose problem is size.

## 2. Tokens used (nothing new)

| Role | Token | Light (default) | Dark (system) | Pinned light (tenant theme sets a surface) |
|---|---|---|---|---|
| Bar surface | `--panel` | #ffffff | #18181b | the tenant's panel |
| Bar border | `--line` (ink 10 % into panel) | derived | derived | derived from the tenant's ink/panel |
| Heading text | `--ink` | #18181b | #ececef | tenant ink |
| Sentence text | `--muted` (ink 78 %) | ≥ 4.9:1 on panel (tokens.css's measured note) | derived | derived (measured 4.9:1 on alteza) |
| Link | `--accent-text`, underlined, `text-underline-offset: 2px` | accent 85 % into ink | idem | idem |
| Button face / text / border | `--panel` / `--ink` / `--line-strong`, hover `--surface-2`, active `--surface-3` | base.css `button` | idem | idem |
| Focus ring | `:focus-visible` 2 px `--accent`, offset 2 px | base.css | idem | idem |
| Privacy control box | `--surface-2`, `1px --line`, `--radius-md` | derived | derived | derived |
| Type | `--text-sm` 13 px ≥ 561 px; `--text-xs` 12 px ≤ 560 px; line-height 1.5 (the composer foot's) | | | |
| Space | `--space-1/2/3/4/5/6` | | | |
| Radius | `--radius-lg` (bar), `--radius-md` (buttons, control box) | | | |

No fill under white text exists in this feature, so `--accent-fill` / `--danger-fill` are not used. No opacity anywhere: the one dim state (a disabled platform switch [if FR]) is the existing `button:disabled` rule, unchanged.

## 3. ConsentBar: the component

### 3.1 Markup (the engineer's shape; class names are the contract)

```
<section class="consent-bar" aria-labelledby="analytics-title">
  <div class="consent-text">
    <h2 id="analytics-title">Analytics</h2>
    <p>{two sentences} <a href="/t/<slug>/privacy#analytics">How we use analytics</a></p>
  </div>
  <div class="consent-actions">
    <button type="button">Don't allow</button>
    <button type="button">Allow</button>
  </div>
</section>
<p class="visually-hidden" role="status" aria-live="polite">{announcement}</p>   ← outside the bar, present from first render
```

The status `<p>` sits **outside** the section: the section is removed on an answer, and a live region removed with its content announces nothing.

### 3.2 Rules (all values tokens; the mockup carries them verbatim)

```css
.consent-bar {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  grid-template-areas: "text actions";
  column-gap: var(--space-5);
  row-gap: var(--space-2);
  align-items: center;
  padding: var(--space-3) var(--space-4);
  border: 1px solid var(--line);
  border-radius: var(--radius-lg);
  background: var(--panel);
  font-size: var(--text-sm);
  line-height: 1.5;
}
.consent-text { grid-area: text; margin: 0; color: var(--muted); text-wrap: pretty; }
.consent-bar h2 { display: inline; margin: 0 var(--space-1) 0 0; font-size: inherit; font-weight: 600; letter-spacing: 0; color: var(--ink); }
.consent-text p { display: inline; margin: 0; }
.consent-text a { white-space: nowrap; text-underline-offset: 2px; }
.consent-actions { grid-area: actions; display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-2); }

/* S-1: the composer's column, above the field. */
.composer .consent-bar { max-width: 760px; margin: 0 auto var(--space-2); }
/* S-6 / S-13: a slot between the band and <main>, at .book-main's width. */
.consent-slot { margin: 0 auto; padding: var(--space-6) var(--space-5) 0; }

@media (max-width: 560px) {
  .consent-bar { grid-template-columns: minmax(0, 1fr); grid-template-areas: "text" "actions"; padding: var(--space-2) var(--space-3); font-size: var(--text-xs); }
  .consent-actions button { width: 100%; }
  .consent-slot { padding: var(--space-4) var(--space-4) 0; }
}
@media (max-width: 319px) { .consent-actions { grid-template-columns: 1fr; } }
```

- **Widths are not new literals.** `760px` is the composer's own (`.composer-inner`, `.voice-status`, `.composer-foot`): the engineer should add `.composer .consent-bar` to one of those selector lists rather than retype it. `.consent-slot` joins **the `.book-main` rule** (`.book-main, .consent-slot { max-width: 1040px; }`), so the bar's edges are the form's edges.
- **The 560 / 319 breakpoints** are the house's phone breakpoint and Uma's "below 320 px" rule (§ 8.7 of the UX). 319 is a new breakpoint number; if Theo prefers, drop it: at 320 two equal buttons of 12 px text still fit (*est.* 2 × 140 px).
- **Equal buttons:** the grid's `1fr 1fr` makes them the same width at every size, including 1280 where they sit right of the text (each as wide as the wider label, "Don't allow").
- **Hover/active/focus:** base.css's, untouched: hover `--surface-2`, active `--surface-3`, `:focus-visible` 2 px `--accent` ring. Both buttons identical in every state.

### 3.3 States

| State | Look |
|---|---|
| Shown | § 4 and § 5 |
| Hover on a button | `--surface-2` (base.css), both alike |
| Focus (keyboard) | 2 px `--accent` outline, 2 px offset |
| Pressed | `--surface-3` |
| Busy | **none.** The choice is local; no `aria-busy`, no spinner (UX § 5.4) |
| Answered | the section is removed in the same frame; the status line speaks; no toast; no placeholder space left behind |
| Not shown (switch off, 404, chosen, GPC [if FR], storage blocked) | nothing rendered, no reserved space |

## 4. High-fidelity screens

Annotated at the tokens; *est.* heights computed at 12 px ≈ 55 characters per 325 px line (system-ui), 13 px ≈ 80 per line at 1280.

### 4.1 S-1 chat, 375 (light; dark and pinned-light swap the tokens of § 2 only)

```
│ … messages scroll above (main) …                       │
├──────── .composer  padding 8 12 (12+safe-area) ────────┤
│ ╭─ .consent-bar  --panel · 1px --line · --radius-lg ─╮ │  padding 8 / 12
│ │ **Analytics** Villa Esperanza would like to count   │ │  12px/18px, --muted
│ │ visits with Google Analytics, which keeps a cookie │ │  heading run-in, --ink 600
│ │ here. It never gets what you type or your booking. │ │
│ │ How we use analytics                                │ │  --accent-text, underlined
│ │ ┌──────────────────────┐ ┌──────────────────────┐   │ │  row-gap 8
│ │ │     Don't allow      │ │        Allow         │   │ │  40 px (coarse), 1fr 1fr, gap 8
│ │ └──────────────────────┘ └──────────────────────┘   │ │
│ ╰─────────────────────────────────────────────────────╯ │  margin-bottom 8
│ (voice status, when any)                               │
│ ╭ Ask a question…                          (mic) (↑) ╮ │  .composer-inner, unchanged
│ Mara is an AI assistant. Chats are saved …            │  .composer-foot, unchanged
│ Book a stay · Manage booking · Privacy · Terms   Read │
```

*est.* height: 8 + 4 × 18 + 8 + 40 + 8 + 2 = **138 px** with ~150 characters of sentence; **120 px** at ≤ 130 characters (3 lines); **156 px** with Uma's 205-character placeholder (5 lines). See § 5.

Order: the bar sits **above `VoiceStatus`** (UX § 5.5), so voice's live line stays touching the field it describes. The floating `.jump-down` ("New messages", `top: -40px` of the composer) now floats above the bar instead of the field: correct, it belongs to the messages' edge.

### 4.2 S-1 chat, 1280

```
              ╭─ .consent-bar, 760 wide, centred on the composer column ──────────────────╮
              │ **Analytics** Villa Esperanza would like to use Google      ┌───────────┐┌───────────┐ │
              │ Analytics, which keeps a cookie on this device, to count    │Don't allow││   Allow   │ │
              │ visits … or your booking. How we use analytics              └───────────┘└───────────┘ │
              ╰────────────────────────────────────────────────────────────────────────────╯
              ╭ Ask a question…                                              (mic) (↑) ╮
                notice · links                                       Enter to send …
```

13 px/19.5 px text left (`1fr`), the two 36 px buttons right (`auto`, vertically centred), gap 20. *est.* 3–4 lines, **≈ 80–104 px**.

### 4.3 S-6 booking page (S-13 identical), 375

```
▔▔▔ accent stripe ▔▔▔
(logo) Villa Esperanza            Need help? Ask Mara
╭─ brand band (unchanged) ─────────────────────────╮
│  Online booking                                  │
╰──────────────────────────────────────────────────╯
   ↕ 16 (.consent-slot padding-top)
╭─ .consent-bar (same as 4.1) ─────────────────────╮   16 px gutters, the form's edges
│ **Analytics** …  How we use analytics            │
│ [   Don't allow   ] [      Allow      ]          │
╰──────────────────────────────────────────────────╯
   ↕ 16 (main's own padding-top at ≤ 560)
Request a booking                                     h1, unchanged
Choose a date and see the price …
① ② ③ ④  stepper …
```

### 4.4 S-6 / S-13, 1280

```
╭─ header + brand band (unchanged) ──────────────────────────────────────────────────────────╮
   ↕ 24
   ╭─ .consent-bar, 1040 wide (.book-main's) ─────────────────────────────────────────────╮
   │ **Analytics** two sentences on one or two lines … How we use analytics  [Don't allow][Allow] │
   ╰──────────────────────────────────────────────────────────────────────────────────────╯
   ↕ 24 (main's padding-top)
   Request a booking
   ┌ steps ─────────────────────────────┐  ┌ .book-summary (sticky, top unchanged) ┐
   │                                    │  │ … □ I agree (D-129), unchanged        │
```

The sticky summary's `top` is unchanged: the bar is in the flow above `<main>` and scrolls away with the band. The D-129 checkbox stays in the summary's foot: a different place, control (checkbox vs two buttons) and colour (a native checkbox in `--accent` vs two neutral buttons) from the bar (R-U3).

### 4.5 Dark mode and a pinned-light tenant

Nothing in this feature is coloured by hand, so both follow the page: on a dark system page the bar is `#18181b` panel on `#0e0e10` bg with `#ececef` heading; on a tenant that pinned light (`data-scheme="light"`, e.g. villa's cream) the bar takes the tenant's `--panel`, `--line` and `--muted`, which tokens.css derives on `.tenant-root` and `[data-scheme]`. The bar has **no** dark-mode rule of its own, and must not get one.

## 5. R-U1: the bar with the keyboard open at 375

- **Budget:** a 375 × 667 phone (the smallest common one) with the keyboard and its suggestion strip open leaves *est.* 350–360 px of visual viewport; a third is **≈ 120 px**.
- **What the design spends to get there:** 12 px type (the composer foot's size), the run-in heading (−1 line), 8 px vertical padding, 8 px gaps, the house touch height (40 px, not 44: § 7), no icon, no close button. That is the floor; the buttons are never hidden or shrunk below it.
- **What the words must do:** fit **3 lines** at 375, i.e. **≤ 130 characters of sentence** with a business name of ~15 characters (heading and link extra). Uma's placeholder is 205 characters → 5 lines → *est.* 156 px, **over budget**. An example inside budget, for Rhea and Lex to replace, not to adopt as is (128 characters with "Villa Esperanza"):
  > Villa Esperanza would like to count visits with Google Analytics, which keeps a cookie here. It never gets your messages or booking.
- **If the words cannot shrink** (Lex needs the four facts), the bar is ≈ 156 px. That is the accepted cost, recorded as R-V1, not solved by collapsing the bar while the field is focused: a collapsed bar with live buttons would let a guest answer without the information (FR-007), and it is new behaviour I may not add.
- A long business name adds a line (≈ 18 px). The walk should use alteza's and villa's real names.

## 6. AnalyticsChoice (tenant privacy page, `#analytics`)

### 6.1 Place and shape

Inside `.legal-doc` (max 760, paragraphs max 68ch), a normal `h2` "Your analytics choice" (the page's existing `.legal-doc h2`: `--text-lg`, margin 24 / 8) with `id="analytics"`, Lex's paragraph as a normal `.legal-doc p`, then the control:

```css
.analytics-choice { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2) var(--space-4); max-width: 68ch; margin: 0 0 var(--space-3); padding: var(--space-3) var(--space-4); border: 1px solid var(--line); border-radius: var(--radius-md); background: var(--surface-2); }
.analytics-choice-status { flex: 1 1 240px; margin: 0; }
.analytics-choice-status .small { display: block; color: var(--muted); }
.analytics-choice-actions { display: flex; gap: var(--space-2); }
@media (max-width: 560px) { .analytics-choice-actions { flex: 1 1 100%; } .analytics-choice-actions button { flex: 1; } }
#analytics { scroll-margin-top: var(--space-6); }
```

`--surface-2` marks it as the one interactive thing in a page of prose, without colour. Buttons: the default `button`, same as the bar. Never `.primary`, never `.danger` ("Stop analytics" is not destructive).

### 6.2 The five states (+ just changed)

| State | Status line (`role="status"`, `--ink`, `--text-base`) | Buttons |
|---|---|---|
| No choice | You have not chosen yet. | `[Don't allow] [Allow]`, equal, as the bar |
| Allowed | Allowed on this device since 28 Oct 2026. | `[Stop analytics]` |
| Declined | Not allowed on this device since 28 Oct 2026. | `[Allow analytics]` |
| GPC / DNT [if FR] | Your browser asks sites not to track you, so analytics is off. | `[Allow analytics anyway]` |
| Storage blocked | This browser is not keeping choices for this site, so nothing is measured. | none (the actions div is not rendered, so the box is the line alone) |
| Just changed | the new state's line, then a second line `.small` `--muted`: "This applies from the next page you open." | the new state's button; **focus stays on the button's position**: the new button takes focus (same place, so it is not lost to `<body>`) |
| Switch off | the whole section, heading included, absent | |

375: the line full width, the button(s) full width under it (two equal halves for No choice). 1280: line left, button(s) right at natural width.

```
## Your analytics choice
Lex's paragraph …
╭─ --surface-2 · 1px --line · --radius-md ───────────────────────────────╮
│ Not allowed on this device since 28 Oct 2026.        [ Allow analytics ] │
│ This applies from the next page you open.  (after a change only)        │
╰─────────────────────────────────────────────────────────────────────────╯
## Your rights …
```

## 7. Deviations from the UX, with reasons

| # | UX said | Design does | Why |
|---|---|---|---|
| D-V1 | Buttons ≥ 44 × 44 px (§ 8.2) | 36 px with a mouse, **40 px on touch**, full half-width (≥ 140 px) on a phone | The house's touch height for every button (base.css `pointer: coarse`); 44 would make these the only 44 px buttons in the app and cost 4 px of R-U1's budget. 40 × 140 is well over WCAG 2.2 AA's 24 px target. Uma may send it back. |
| D-V2 | The platform switch saves through the form's save bar (J-9) | Saves at once, as every Features switch does today | The code (`features-panel.tsx`). Same toast. |
| D-V3 | The bar's `h2` on its own line (§ 6.1 wireframes) | Run-in heading, inline before the text | R-U1: one line saved at 375. Still a visible `h2` and the region's name. |

Nothing else in the UX is changed. § 5.4's no-toast decision stands.

## 8. The Features row (platform tenant form)

The existing `.feature-row` in `features-panel.tsx`, group "Guest pages", after Voice. No new style:

```
Analytics                                                   ( ○‒‒ ) Off
Counts visits on the chat, booking page and Manage booking
with Google Analytics, after each guest allows it.          ← .small.muted, feat-about-analytics
```

- Default **Off** (like voice: no row = off, Theo's to wire).
- **[if FR]** the controller instruction is missing: the switch is `disabled` (base.css's existing disabled look) and the about line gains a second sentence in the same `.small.muted` span, exactly as the `idle` bookings sentence does today: "Record the resort's written instruction on the Legal tab first." Visible text, no `title` (D-102).
- The Activity row (FR-025) is a sentence in `activityWords`: no visual work.

## 9. Hand-off to the Full-Stack Engineer

1. **CSS:** § 3.2 and § 6.1 go in `screens.css` (public pages section) — `chat.css` for the `.composer .consent-bar` line. No literal: reuse the composer's 760 selector list and the `.book-main` rule. No dark rule.
2. **Placement:** S-1 inside `<section class="composer">`, before `VoiceStatus` and after the `.jump-down` button. S-6 / S-13: a `<div class="consent-slot">` between the header (`{header}`) and `<main className="book-main">`, rendered only when the bar shows (no empty slot: its padding would push the page).
3. **Focus after an answer (UX § 5.3):** S-6/S-13 focus `<main>` with `tabIndex={-1}`; add `.book-main:focus { outline: none; }` (the pattern of `.book-step h2:focus`) or the whole form gets a 2 px ring after a keyboard answer.
4. **Status region:** one `.visually-hidden` `role="status"` per page, OUTSIDE the bar (§ 3.1).
5. **Icons:** none. `icons.tsx` unchanged.
6. **Assets:** none. No image, no logo of Google.
7. **Walk and axe additions** (plan § 6.3, UX § 8.9): measure, at 375 × 667 with a touch context, `.consent-bar` height on S-1 with the real words and villa's and alteza's names — **pass ≤ 120 px, record the number either way**; the two buttons' boxes equal (width and height); no horizontal scroll at 320 and at 200 % zoom; axe over the bar on S-1/S-6/S-13 × light/dark/pinned-light (alteza pins light) and the privacy control's states; the existing `plan/ui-refresh-a11y.mjs` stays at 0.
8. **Screenshots:** none exist (no browser this session). The mockup renders the spec; the walk's shots replace it.

## 10. Risks

| # | Risk | Owner |
|---|---|---|
| R-V1 | With words over ~130 characters, the bar is ~156 px at 375 with the keyboard open, over a third (R-U1) | Rhea / Lex (the words); accepted if Lex needs them |
| R-V2 | Heights here are estimates; nothing was rendered | The engineer's walk (§ 9.7) |
| R-V3 | D-V1 (40 not 44) | Uma, if she disagrees |

## 11. Refused

- A filled or accent "Allow": it is the nudge FR-007 forbids.
- A close (×), an icon, a shadow, a fade: each adds weight or a third answer.
- A new colour or token: none was needed.
- Collapsing the bar while the chat field has focus: new behaviour, and it would hide the information next to live buttons.
