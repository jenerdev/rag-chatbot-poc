# UI refresh plan: a modern, minimalist look and a calmer UX, one component at a time

> Today the app is styled by one hand-written stylesheet
> (`apps/web/app/globals.css`, 603 lines) whose first comment says "Plain and
> readable is the goal; this is not a design exercise." That was the right call
> for a proof of concept. The user now wants it to look and feel like a
> product: **more modern, more minimalist, better UX**, improved component by
> component. This plan does that in eleven phases, one surface each, starting
> with the foundation every later phase stands on.
>
> Written 2026-10-06, against `b8ec02d` on `master`. **Status: Phases 0–10 done
> (0–9 on 2026-10-06, every look included, no action items; 10 on
> 2026-10-08, with `pnpm eval` and the pipeline isolation suite owed to an
> invalidated OpenAI key).** Branch
> `feat/ui-refresh`. § 7 answered 2026-10-06: every recommendation taken,
> by the user's instruction; q6 (no reference given) is a quiet, neutral
> look: hairlines, few fills, generous space. D-101.

---

## What this plan covers

| | |
|---|---|
| **In scope** | Design tokens (space, type, radius, shadow, motion, derived colours) in `globals.css`; a hand-drawn inline-SVG icon set; every screen's look and layout, in the phase order below; the interaction details that make a screen feel finished (focus, empty states, loading, confirmation, error placement, phone width); an accessibility pass; the record (a decision, CLAUDE.md, flow.md, status, whats-done) |
| **Out of scope** | Any route, query, policy, permission, price or prompt change (Rule 3); a CSS framework, component library, icon font or animation library (Rule 1); a new theme key (Rule 2, § 7 q2); new features; the chatbot's words (the three baselines stay byte-identical) |

---

## 0. The five rules

### Rule 1 — Still hand-written: no CSS framework, no component library

No Tailwind, no shadcn/Radix/MUI, no icon font, no Framer Motion. D-001/D-002
keep libraries out of the pipeline; the same reasoning keeps the UI readable
alone: a reader opens `globals.css` and a component and sees everything. Icons
are inline SVG in ONE file, `components/icons.tsx`, drawn on a 20 px grid with
`stroke="currentColor"`, so they follow the theme. The stylesheet may split
into a few files under `app/styles/` (tokens, base, components, screens)
imported by `globals.css`, if § 7 q4 says so.

### Rule 2 — The tenant theme stays five keys, and every new colour derives from them

`lib/theme.ts`, the platform form and Postgres's `tenants_theme_shape` hold the
same five keys (three copies of one rule). A modern palette needs more shades
(hover, border, subtle surface, focus ring), and those are DERIVED in CSS:

```css
--accent-hover:  color-mix(in srgb, var(--accent) 85%, black);
--line:          color-mix(in srgb, var(--ink) 10%, var(--panel));
--surface-2:     color-mix(in srgb, var(--ink) 3%, var(--panel));
--ring:          color-mix(in srgb, var(--accent) 40%, transparent);
```

So a tenant's accent recolours every hover and focus ring, which today it does
not (`button.primary:hover` is hard-coded `#1d4ed8`, blue for every tenant).
Every hard-coded hex in the stylesheet (eleven `#fff`, the notice tints, the
warning oranges) becomes a token. `dangerouslySetInnerHTML` stays absent.

### Rule 3 — Visual only: the server is untouched

No phase changes a route, a query, a permission, `requireAdmin()`, a trigger or
prompt text. A hidden or disabled button is still a courtesy, never the guard
(trap 21). Markup may change (a `<div>` becomes a `<dialog>`, a list gets
`role`s), but every `fetch`, every request body and every piece of state stays
as it is. So after every phase:

- `pnpm typecheck` and `pnpm test` (the web tests: `nav-items`, `permissions`,
  `reply-text`, `tables`, `schemas`) pass;
- `prompt-snapshot` and the two tool baselines are byte-identical (they should
  be, as nothing upstream moved; it is the proof);
- the phase's walk passes (Rule 4).

`pnpm eval` is NOT owed per phase, because no prompt text moves. It is run once
at the end as the proof (Phase 10).

### Rule 4 — Every phase is proved on a screen, at two widths, before and after

Before a phase's first edit, screenshot its screens at **375 px and 1280 px**
into `plan/ui-refresh/<phase>/before/`; after, into `after/` (and
`after-dark/` with `SCHEME=dark`). `plan/ui-refresh-shoot.mjs` takes all 74
(three tenants × 12 pages, the platform login, two widths) as a throwaway
owner; the folder is git-ignored (~23 MB a run). Then a keyboard
walk: every control reachable with Tab, a visible focus ring, Enter and Escape
doing what they say. A phase is done when the user has seen the pair and said
so, not when the CSS compiles (CLAUDE.md: verify the effect).

### Rule 5 — Accessible by default

WCAG AA contrast (4.5:1 text, 3:1 controls) for the default theme, and the
platform form warns when a tenant's chosen colours fail it (Phase 9). Tap
targets at least 40 px on a phone. `:focus-visible` rings everywhere, never
`outline: none` alone. Every motion respects `prefers-reduced-motion` (the
thinking dots already do). Colour never carries meaning alone: a status is a
word and a colour.

---

## 1. What is actually here

| Observation | Where | Consequence for the plan |
|---|---|---|
| One stylesheet, hand-written, 13 sections, almost no inline style (2 `style={{}}` in all components) | `globals.css` | The refresh is mostly CSS. Good: a phase is small and its diff is readable |
| Ten different font sizes (9–22 px, 22 uses of 13 px), 31 distinct paddings | `globals.css` | Phase 0 replaces them with a type scale of 5 steps and a 4 px spacing scale. That alone is most of "minimalist" |
| Every button is the same bordered box; primary is filled | `a.button, button` | Phase 0 adds three kinds: primary, secondary (quiet), ghost (no border), plus a danger kind. Fewer borders is the biggest visual change |
| The header holds up to **11 buttons** for an owner (Chat, Book, Dashboard, Knowledge base, Unanswered, Bookings, Rooms, Holidays, Slots, Promos, Members, Log out), wrapping on a phone | `tenant-nav.tsx`, `nav-items.ts` | The most visible UX problem. Phase 2 gives staff pages a sidebar (drawer on a phone); `navItems()` stays the ONE source of which links appear, so its tests still hold |
| `.card` sections stacked in one 820 px column on every staff screen | every `*-screen.tsx` | Staff screens get a wider content area (1100 px), a page title row with its primary action, and sections that read as groups, not boxes inside boxes |
| Hover/focus colours hard-coded blue | `button.primary:hover` | Fixed by Rule 2's derived tokens |
| The chat is a full-height column with bubbles, chips for suggestions, a composer | `chat-screen.tsx`, `.chat-layout` | Phase 3: the most-seen public surface; already structurally right, needs rhythm, not rebuilding |
| Pipe tables, room cards and the lightbox have careful phone layouts already | `reply-text.tsx`, `room-cards.tsx`, `lightbox.tsx` | Phase 4 restyles, and must not break the phone card layout (D-091) or `data-label` |
| The booking page uses a native `<select>` and `<input type="date">` | `booking-page.tsx:274, :286` | Keep native controls (they are the accessible, phone-correct ones); style them. A custom calendar is out of scope (§ 7 q5) |
| The dashboard's charts are hand-drawn SVG | `bar-chart.tsx` | Phase 6 restyles through tokens; still no chart library |
| No dark mode | — | § 7 q1: tenant themes set `bg`/`panel`/`ink`, so a dark mode would override a business's colours |
| Bookings is the largest screen (911 lines) | `bookings-screen.tsx` | It gets its own phase (7) and may be split into components, behaviour unchanged |

---

## 2. Traps

1. **`next build` while `next dev` runs breaks the dev server** (CLAUDE.md trap
   16). Screenshots need `pnpm dev`; typecheck instead of building while it runs.
2. **A tenant theme can make any new token unreadable.** A tenant with a dark
   `panel` and the derived `--line` mixing toward black gives invisible
   borders. Derive from `--ink` and `--panel` together (Rule 2's examples
   do), and walk **villa, harbor and northwind** each phase, since they carry
   different themes.
3. **The phone table layout is load-bearing.** `.reply-table` turns each row
   into a card under 560 px using `data-label`. A refactor of table CSS that
   drops one selector hides the price on a phone. Phase 4 screenshots a priced
   reply at 375 px, before and after.
4. **The sticky header's height is in a `calc()`.** `.chat-layout` is
   `calc(100vh - 53px)`; change the header and the composer slides under the
   fold. Use `100dvh` and a token for the header height, set once.
5. **`<dialog>` and focus.** Moving confirmations to `<dialog>` means focus
   must return to the opener on close, and Escape must cancel, never confirm.
6. **Class names are the tests' contract too.** `reply-text.test.ts` asserts
   exact HTML, classes included (`reply-text`, `reply-table`, `amount`,
   `room-cards`, `room-card-count`, `data-label`). Restyle those classes; do
   not rename them, or the test change must be its own reviewed step.
7. **A redesign invites new behaviour.** "While I'm here, the button could
   also…" is a feature, and Rule 3 says no. Write it in § 8 (later) instead.

---

## 3. Phases

Every phase: before screenshots → edits → typecheck + test → after screenshots
→ keyboard walk → the user's look → status.md and whats-done.md.

### Phase 0 — Foundation: tokens, base elements, icons

The phase every other phase depends on. Nothing looks finished after it, but
everything looks *consistent*.

- **Tokens** on `:root`: spacing `--space-1…8` (4 px steps), type
  `--text-xs/sm/base/lg/xl` (12/13/15/18/24) with line heights, radii
  `--radius-sm/md/lg` (6/10/14) plus `--radius-full`, shadows `--shadow-1/2`
  (soft, low-opacity, used sparingly: popovers and dialogs only), motion
  `--ease`, `--dur-fast/slow`, and the derived colours of Rule 2. Status
  colours `--ok/--warn/--danger` each with a `-soft`.
- **Type**: the system stack, tightened: headings 600 weight, slightly negative
  letter-spacing at `xl`, body 15 px, muted text for secondary lines,
  `font-variant-numeric: tabular-nums` on every amount and date column.
- **Buttons**: `.primary` (filled accent), default (quiet: `--surface-2`
  fill, no border), `.ghost` (text only), `.danger`; sizes `sm` and default;
  a pressed state; a busy state (spinner icon + `aria-busy`).
- **Inputs**: one height (40 px), one radius, a 1 px border that becomes the
  accent and a `--ring` on focus; labels above, help text below in muted
  `sm`; an error state with the message under the field.
- **Cards**: `.card` loses its heavy border for a hairline (`--line`) on
  `--panel`, more inner padding, a section title style.
- **Notices**: a left accent bar and an icon instead of a full tinted box.
- **Badges**: `.badge` for statuses (pending, confirmed, cancelled, closed,
  retired), word + tint, used by Phases 7–9.
- **`components/icons.tsx`**: ~20 icons (menu, close, chevron, check, plus,
  trash, edit, calendar, user, users, home, chat, book, chart, file, alert,
  info, logout, search, image), hand-drawn, `aria-hidden` by default.
- Replace every hard-coded hex with a token. Remove the "not a design
  exercise" comment; add a decision (D-101) saying what replaced it.

**Done when:** every screen still works and reads the same, at 375 and 1280,
on all three tenants; no hex remains outside `:root`; a tenant's accent now
colours hover and focus.

### Phase 1 — Login, forgot password, reset password

`admin-login.tsx` (staff and platform share it), `reset-password.tsx`,
`/t/[tenant]/admin/reset`, `/platform/reset`.

- A centred, narrow (380 px) card on the page background, the tenant's logo
  and name above it, one clear title ("Sign in to Villa"), one sentence under
  it.
- Email and password with labels, `autocomplete="email"` /
  `"current-password"` (and `"new-password"` on reset), a show/hide password
  toggle (an icon button with `aria-pressed`).
- A full-width primary button that shows a spinner while busy and cannot be
  double-submitted (it already guards on `busy`; make it visible).
- Errors under the form in one line, with focus moved to them
  (`role="alert"`), the password cleared, the email kept.
- "Forgot password?" as a ghost link under the button; its mode keeps the
  same card, with a "Back to sign in" link, and its success state is a
  check icon and one sentence, not a notice box.
- Reset: two password fields with a live "passwords match" hint and the
  minimum length shown before submit, not after.

**Done when:** a staff login, a wrong password, a forgot-password request and a
reset all walk by keyboard alone, and the platform login looks the same with
its own title.

**Done 2026-10-06:** `plan/ui-refresh-phase1-walk.mjs`, 18/18 in a real
browser (no account made, no email sent: the reset request is answered
inside the browser). Deviations: the logo and name stay in the page header
above the card rather than inside it (the header already carries them);
the staff intro no longer names a `pnpm` command, since staff are not
developers and owners add members on the Members screen.

### Phase 2 — Navigation: the header, the staff sidebar, the phone drawer

`tenant-nav.tsx`, `brand-header.tsx`, every page that renders them.
`navItems()` is unchanged: it still decides WHICH links; this phase decides
HOW they look.

- **Public pages** (chat, book): a slim header, logo + business name on the
  left, at most "Book" (primary) and a quiet "Staff login" on the right. The
  banner image, when set, becomes a short band above, not a full-width block.
- **Staff pages**: a left **sidebar** (240 px) with icon + label per link,
  grouped: *Overview* (Dashboard), *Content* (Knowledge base, Unanswered),
  *Bookings* (Bookings, Rooms, Holidays, Slots, Promos), *Team* (Members). At
  the bottom: the signed-in email, the role as a badge, "View chat" and
  "Log out". The current page is a filled pill (`aria-current="page"`).
  Groups are a presentation of `navItems()`'s output, mapped by `page` in the
  component, so `nav-items.test.ts` keeps passing.
- **Phone (< 900 px)**: the sidebar becomes a drawer behind a menu button in
  a top bar; it traps focus while open, closes on Escape, on a link and on
  the backdrop.
- A staff page's own header row: the page title, a one-line description,
  and its primary action on the right ("Add a document", "New booking").
- Fix trap 4: the header height is one token, and the chat uses `100dvh`.

**Done when:** an owner on villa sees every page in the sidebar, a staff
member sees only theirs (the role cases still differ), and the phone drawer
walks by keyboard.

**Done 2026-10-06:** `components/staff-frame.tsx` (signed in: sidebar +
content; signed out: the old header and `<main>`, unchanged) replaces the
header on all nine staff screens; `groupNavItems()` sections `navItems()`'s
output, tested. `plan/ui-refresh-phase2-walk.mjs`, 20/20. Deviations: the
sidebar footer shows the role but not the email (the session route returns
no email, and Rule 3 keeps routes unchanged); each screen's primary action
stays where it is, in its card, until that screen's own phase; the content
column is 960 px, not 1100 (the forms read better narrower).

### Phase 3 — The chat screen

`chat-screen.tsx`, the composer, the empty state, suggestions, the thinking
dots.

- **Empty state**: the assistant's name as a large greeting, one muted line,
  and the suggested questions (D-089) as a 2-column grid of quiet cards with a
  chevron, not outlined pills.
- **Messages**: the user's bubble keeps the accent fill but with a larger
  radius and a tail-less, softer shape; the assistant's reply loses its box
  and sits on the page as text with a small avatar mark (the tenant logo or
  an initial), the way modern chat products read. Width capped at ~70 ch for
  reading.
- **Composer**: a single rounded field pinned to the bottom, auto-growing
  up to 6 lines, Enter to send and Shift+Enter for a newline (already so,
  `chat-screen.tsx:427`; kept), the send button an icon inside
  the field, disabled while empty or busy; "New chat" moves to the header as
  a ghost icon button with a tooltip label.
- **Streaming**: keep the thinking dots; scroll-to-bottom only when the user
  is already near the bottom, with a "↓ New messages" button otherwise.
- **Errors**: inline under the failed turn with a "Retry" button, not a
  notice at the top.

**Done when:** a greeting, a document answer, a refusal, a tool answer and a
streamed table all look right at both widths, and the composer never hides
under a phone keyboard.

**Done 2026-10-06:** `plan/ui-refresh-phase3-walk.mjs`, 18/18, the chat
route answered inside the browser with the server's own event format (one
real question with `--real`). What already existed and was kept: Enter /
Shift+Enter, the auto-grow, stick-to-bottom, Retry that drops the failed
question before resending. New: the field stays enabled while an answer
streams (only sending waits); the "New messages" button. Deviations: tool
answers and streamed tables are walked in Phase 4, whose subject they are;
"New chat" moved to the header in Phase 2 already; the phone keyboard is
covered by `100dvh` (Phase 2), not walked, since headless Chrome has no
on-screen keyboard.

### Phase 4 — What a reply contains: tables, room cards, lightbox, sources, tool evidence

`reply-text.tsx`, `room-cards.tsx`, `lightbox.tsx`, `sources-panel.tsx`, the
"Checked availability" block.

- **Tables**: no vertical rules, a hairline under the header, more row
  height, amounts right-aligned in tabular figures; keep the phone card
  layout exactly (trap 3).
- **Room cards**: photo on top with a rounded top edge, the room name as a
  title, the lines as a quiet label/value list, no tinted title bar.
- **Lightbox**: keep the mechanics; add a fade (reduced motion: none) and
  swipe on a phone only if it needs no library (§ 7 q5's rule).
- **Sources panel** (D-012, a feature): collapsed by default under the reply
  as "3 sources" with file icons; open, each chunk is a quiet card with the
  document title, the score as a small bar, and the text in a readable
  (not monospace) face.
- **Tool evidence** ("Checked availability", D-037): the same collapsible
  pattern as sources, so a reply has ONE footer style for "what this was
  built from".

**Done when:** `reply-text.test.ts` passes unchanged and a priced harbor reply
reads at 375 px with every price visible.

**Done 2026-10-06:** `plan/ui-refresh-phase4-walk.mjs`, 17/17, replies
answered inside the browser (photos as data: URIs). Deviations: the
availability evidence stays OPEN, not collapsed like the sources, because
CLAUDE.md rule 7 (D-037) says it is shown open; it shares the sources'
card style instead, which is what "one footer style" needed. The table
keeps its tinted header and row stripes, the user's choice in
plan/tables.md's Phase 4 walk; only the vertical rules went. No class name
changed, so `reply-text.test.ts` is untouched.

### Phase 5 — The customer booking page

`booking-page.tsx` (S-6), the receipt.

- A two-column layout on desktop: the form on the left, a sticky **summary**
  card on the right (room, dates, guests, the quote's lines and total, the
  promo); one column on a phone with the summary as a bar at the bottom that
  expands.
- The form in three visible groups (Your stay → Guests → Your details) with
  numbered headings, not a wizard: one page, no hidden steps.
- The quote's figures are the server's (customer-booking Rule 3): the summary
  shows `book/quote`'s answer, never a sum made in the browser; while it
  loads, a skeleton, not a stale number.
- Promo code as a collapsed "Have a code?" link that opens an inline field
  with an Apply button and a clear applied/refused state.
- Native date and select controls, styled (§ 1); a closed date's refusal
  (D-080) shown beside the date field in words.
- The receipt: a check icon, the reference (D-100) large and copyable, "What
  happens next" as three short steps.

**Done when:** a request with a promo, a refused closed date and a receipt
walk at both widths, and the figures equal the quote route's JSON.

**Done 2026-10-06:** `plan/ui-refresh-phase5-walk.mjs`, 14/14 against the
REAL quote route; the request was answered inside the browser with a
receipt built from the real quote's lines, so nothing was stored (0 rows
named "Walk Five" afterwards). Deviations: on a phone the summary follows
the three sections in the page instead of a bottom bar that expands, so
Send stays after the details and there is one Send button, not two; the
promo code needs no Apply button, since the quote already answers it as
it is typed; no tenant has a closed date in the walked window, so the
closed-date words were not walked (unchanged code, D-080's own walk).

### Phase 6 — The dashboard

`dashboard-screen.tsx`, `bar-chart.tsx` (S-11, D-098).

- A row of **stat tiles** (attention counts first: pending requests,
  unanswered questions) each with a label, a large figure and a link to the
  screen that resolves it.
- Today's arrivals as a compact list; charts in cards with a title and the
  period; the `7 | 30 | 90` switch as a segmented control.
- Charts: one accent colour and its soft tint, a hairline baseline, values on
  hover/focus with a text alternative (a visually hidden table).
- Money (owners/admins only) is still `null` from the function for staff; the
  screen leaves the tile out rather than showing a dash.
- Still no figure added in the browser (D-098).

**Done 2026-10-06:** `plan/ui-refresh-phase6-walk.mjs`, 13/13 as a harbor
owner, a harbor staff member and a northwind admin. The dataviz skill's
validator passed the default series colour on both surfaces; villa's teal
`#0f766e` fails its chroma floor ("reads gray"), a check for telling
categorical series apart, which a one-series chart does not need; its
contrast passes, and it is the tenant's colour, so it stays. A tenant with
no bookings now gets the Unanswered tile too (it was a link inside the
Chat card). The money tile is left out for staff as before: the function
withholds it.

### Phase 7 — The bookings screen

`bookings-screen.tsx` (S-3, the largest), split into `requests-section`,
`new-booking-form`, `bookings-list` components if § 7 q4 agrees, behaviour
unchanged.

- **Requests** first, as rows with the reference, dates, guest, source
  ("web" / "by staff") as a badge, and Confirm / Decline on the right.
  Decline and Confirm open a small `<dialog>` for the note (D-096), with the
  note field focused; Escape cancels (trap 5). A clash (D-099) is a warning
  badge on the row and a disabled Confirm with the reason as its tooltip and
  visible text.
- **New booking** in a side panel (drawer) opened from the page's primary
  action, not a permanent card.
- **The list**: a table with a sticky header, a status filter as tabs
  (Upcoming, Pending, Past, Cancelled), and the phone layout as cards.

**Done 2026-10-06:** `components/dialogs.tsx` (`useConfirmDialog`,
`Drawer`, both the native `<dialog>`), and `StaffFrame` takes the page's
`actions`. `plan/ui-refresh-phase7-walk.mjs`, 15/15; every write caught
in the browser (2 caught: one PATCH, one POST), so HAR-4YXGRU was still
pending and no "Walk Seven" row existed afterwards. Deviations: the list
stays the day-by-day availability view rather than a table with
Upcoming/Past tabs, because "Past" would need a read the screen does not
make (Rule 3); the status filter (All, Pending, Confirmed, Cancelled)
narrows what is drawn from the same rows. The screen was not split into
files: the dialog and the drawer, the reusable parts, were.

### Phase 8 — Knowledge base and unanswered questions

`admin-screen.tsx` (S-2), `unanswered-screen.tsx` (S-4).

- Documents as a list with title, chunk count and updated date; add/edit in a
  drawer with a large, comfortable editor (monospace kept only if § 7 says),
  the character count against `MAX_CONTENT_LENGTH` live.
- Deleting asks in a `<dialog>` that names the document.
- Unanswered: each question as a row with its date and a Resolve button; an
  empty state that reads as good news ("Nothing unanswered").

**Done 2026-10-06:** `plan/ui-refresh-phase8-walk.mjs`, 17/17; 4 writes
caught in the browser, so document 37 and harbor's open questions are
unchanged and no "Walk Eight" document exists. The editor is in the
reading face (monospace dropped; nothing in § 7 asked to keep it), and so
are the chunks. The document title is now a button, so the keyboard opens
its chunks. The last `style={{}}` that was a style (the over-limit count)
is a class; the two left are computed widths (the split bar, the chart's
readout position).

### Phase 9 — Rooms, holidays, slots, promos, members, the platform

The remaining staff screens share ONE pattern from Phases 7–8: list → row
actions → drawer form → confirm dialog. `accommodations-screen`,
`holidays-screen`, `slots-screen`, `promos-screen`, `members-screen` /
`members-panel`, `platform-screen`, `tenant-form`.

- Rooms: photo thumbnails in the list, the photo uploader as a drop zone
  (`resize-image.ts` unchanged).
- Holidays and closed dates: a month view is § 7 q5; otherwise a list
  grouped by month with `closed` as a badge.
- Slots: retired slots behind a "Show retired" toggle.
- Promos: the value shown in words ("10% off", "₱500 off") as a badge.
- Members: avatar initial, email, role as a select for owners.
- Platform: the tenant list as cards with the Pulse strip on top; the tenant
  form's theme preview shows the contrast check of Rule 5.

**Done 2026-10-06:** `plan/ui-refresh-phase9-walk.mjs`, 24/24 as a harbor
owner and a throwaway super user; every non-GET caught in the browser (one,
the dropped photo's POST), so Garden Room still has 2 photos. No
`window.confirm` or `window.prompt` is left in the app. `contrastProblems()`
in `lib/theme.ts` (tested) checks four pairs against 4.5:1. Deviations: the
room cards stay editable in place, not in a drawer (each holds details,
rates and photos); members' add form stays inline (one field); "You" is
marked only on the platform, which knows the viewer's id (the tenant
session route returns none, Rule 3). Found: inputs written with no `type`
were unstyled since Phase 0 (the selector listed types only); now
`input:not([type])` is in the list. The theme preview had inherited
`.tenant-root`'s full-screen height; it is contained now.

### Phase 10 — Polish, accessibility audit, the record

- An axe-style pass by hand (or the browser's Lighthouse) on every screen;
  fix what it finds.
- Reduced motion, 200% zoom, keyboard only, a screen reader on the chat and
  the booking page.
- `grep -ri "service_role\|SUPABASE_SECRET\|TENANT_SIGNING_JWK\|guest_phone"
  apps/web/.next/static/` on a fresh build (rule 2; nothing should have
  moved, and this proves it).
- `pnpm eval` once (Rule 3's end proof), the isolation suites, verify.
- D-101 in `decisions.md`; CLAUDE.md's "Frontend" convention updated (tokens,
  icons, the rules above); `flow.md` unaffected; status and whats-done.

**Done 2026-10-08:** axe (`plan/ui-refresh-a11y.mjs`), 160 page states, 0
violations after four runs; `plan/ui-refresh-phase10-walk.mjs`, 40/40 (200 %
zoom on 36 pages, reduced motion with its positive twin); the build and both
bundle greps clean; verify 117/118 (the known open item), bookings isolation
31/31 both ways, rooms 50/50, the three baselines identical. Owed: `pnpm
eval` and `@rag/pipeline isolation`, both stopped by an invalidated OpenAI
key (HTTP 401). Deviation: the fills under white text are their own tokens
(`--accent-fill`, `--danger-fill`), darkened in dark mode; D-101 amended.

---

## 4. Order and size

| Phase | Surface | Files (main) | Rough size |
|---|---|---|---|
| 0 | Foundation | `globals.css`, `icons.tsx` | M |
| 1 | Login / reset | `admin-login.tsx`, `reset-password.tsx` | S |
| 2 | Navigation | `tenant-nav.tsx`, `brand-header.tsx`, staff pages | M |
| 3 | Chat | `chat-screen.tsx` | M |
| 4 | Reply contents | `reply-text`, `room-cards`, `lightbox`, `sources-panel` | S–M |
| 5 | Booking page | `booking-page.tsx` | M |
| 6 | Dashboard | `dashboard-screen.tsx`, `bar-chart.tsx` | S–M |
| 7 | Bookings | `bookings-screen.tsx` | L |
| 8 | Knowledge base, unanswered | `admin-screen.tsx`, `unanswered-screen.tsx` | M |
| 9 | Remaining staff + platform | 7 components | L |
| 10 | Audit and record | — | S |

Phases 1–6 each depend only on Phase 0 and can be reordered; 7–9 reuse the
drawer and dialog built in 7, so they go in that order.

---

## 7. Questions for the user

1. **Dark mode?** Recommended: **follow the system only for tenants with no
   custom theme, and for staff pages and `/platform`**; a tenant that set its
   colours keeps them in both modes. The alternative (dark everywhere) would
   override a business's brand.
2. **A sixth theme key** (e.g. a font or a radius per tenant)? Recommended:
   **no**, it touches three copies of the theme rule and Postgres; everything
   in this plan derives from the five keys.
3. **Font**: the system stack (zero bytes, native on every device) or a
   self-hosted face such as Inter through `next/font/local` (one woff2 in the
   repo, no runtime fetch)? Recommended: **system stack**, tightened; revisit
   after Phase 3's screenshots.
4. **Split the stylesheet and the big screens into smaller files?**
   Recommended: **yes**, `app/styles/{tokens,base,components,screens}.css` and
   the bookings screen into three components, behaviour unchanged.
5. **Custom widgets** (a calendar date-range picker on the booking page, a
   month view for holidays)? Recommended: **not in this plan**; native
   controls styled well, and a separate plan if the screenshots say otherwise.
6. **Reference look**: is there a product whose feel you want (e.g. Linear,
   Notion, Airbnb's booking flow, Intercom's chat)? It decides how much
   colour, how round, how dense, before Phase 0's tokens are fixed.

---

## 8. Later (ideas that are features, not design)

Kept here so they do not creep into a phase (trap 7): a command palette for
staff, ~~toast notifications~~ (done: plan/ui-components.md Phase 1, D-102), keyboard shortcuts, saved filters on Bookings,
copy-to-clipboard on a reply.
