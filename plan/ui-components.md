# UI components plan: toasts, load and empty states, search, tabs, tooltips

> The UI refresh (plan/ui-refresh.md, D-101) gave every staff screen ONE
> pattern: list → row actions → drawer form → confirm dialog
> (`components/dialogs.tsx`). This plan audits what that pattern still leaves
> to each screen to do on its own, and turns the repeated parts into a few
> small, hand-written components. It also picks up "toast notifications" from
> ui-refresh § 8 ("Later").
>
> Written 2026-10-07 on `feat/ui-refresh`, while ui-refresh Phase 10 is
> paused, uncommitted. **Status: Phases 0–1 done 2026-10-08 (ui-refresh
> Phase 10 committed at `09aed2f`); Phase 2 next.** § 5 answered
> 2026-10-07: every recommendation taken, by the user's instruction.
> Decision to record: D-102.

---

## What this plan covers

| | |
|---|---|
| **In scope** | A toast (snackbar) for action feedback; a load state (skeleton + error with Retry); an empty state with its action; client-side search and "show more" on the two lists that grow; tabs on the platform tenant form; a tooltip that shows on keyboard focus too; the record |
| **Out of scope** | Any route, query, policy, permission, price or prompt change (ui-refresh Rule 3, kept); a component library, CSS framework or icon package (ui-refresh Rule 1, kept); a custom date picker (ui-refresh § 7 q5, kept); server pagination (it is a route change); new features |

The ui-refresh rules all still apply: hand-written, five theme keys,
visual only, proved on a screen at 375 and 1280 px, accessible by default.

---

## 1. The audit: what is already there

| Component | Exists? | Where | Verdict |
|---|---|---|---|
| **Modal / Dialog** | Yes | `useConfirmDialog()` in `dialogs.tsx`, native `<dialog>` | Every destructive action already asks: delete document, remove member, retire/delete slot, retire/delete promo, remove holiday, reopen a closed date, remove a photo, retire a room, cancel/decline a booking, archive a tenant. No `window.confirm`/`prompt` left. **Nothing to do.** |
| **Drawer / Side panel** | Yes | `Drawer` in `dialogs.tsx` | Used by every add/edit form (documents, bookings, rooms, holidays, slots, promos). Rooms edit in place on purpose (ui-refresh Phase 9). **Nothing to do.** |
| **Alert / Banner** | Yes | `.notice ok/warn/error` (base.css:311) | Right for STANDING facts (overlapping promos, a closed date on the booking page, contrast warnings). Wrong for action feedback: see Toast. |
| **Tabs / segmented** | Partly | `.segmented` on dashboard, unanswered, bookings | Those are filters over one list, correctly `role="group"` + `aria-pressed`. No real tabs anywhere. |
| **Accordion** | Partly | native `<details>`: sources panel, retired slots, archived tenants | Fine as is. |
| **Loading / Skeleton** | Partly | `.quote-skeleton` on the booking page only; 13 staff lists show the text "Loading…" | See Load state. |
| **Empty state** | Partly | `.empty-list` (icon + title + line) on Unanswered only; 7 other lists are one muted line | See Empty state. |
| **Error state** | No | a failed list load REPLACES "Loading…" in the same small grey text, no Retry | See Load state. |
| **Snackbar / Toast** | No | — | See Toast. |
| **Search / Filter** | Partly | bookings: status + room; nothing on documents or unanswered | See Search. |
| **Pagination** | No | unanswered returns up to `UNANSWERED_LIMIT = 200` rows, all drawn | See Search ("show more", client-side). |
| **Tooltip** | Native only | `title=` on icon buttons and on bookings' slot chips | See Tooltip. |
| **Dropdown / Select** | Native | 10 `<select>`s, styled in Phase 0 | Native is the accessible, phone-correct control. **Nothing to do.** |
| **Popover** | No | — | No use of its own; the Popover API is used INSIDE the toast (trap 1). |
| **Date picker** | Native | `<input type="date">` | ui-refresh § 7 q5 answered "native, styled". **Nothing to do.** |

### The findings, by value

1. **Action feedback lands off-screen.** Eight screens keep the same
   `notice` state and markup (`accommodations`, `admin`, `bookings`,
   `holidays`, `members-panel`, `promos`, `slots`, `tenant-form`; 68
   `setNotice` calls). The notice is at the TOP of the page. Delete a promo
   at the bottom of a long list, or confirm the last request, and "Deleted
   …" appears where you are not looking. And because an open drawer makes
   the page inert, every drawer repeats the error a second time
   (`.drawer-notice`, five copies; `admin-screen.tsx:477` says why).
2. **A failed load looks like a slow load.** `setLoadMessage(await
   describeFailure(…))` in 11 screens writes the error where "Loading…" was,
   same grey `small` text, no colour, no `role="alert"`, no way to try again
   but reloading the page.
3. **Empty lists say what to do but give no button.** "No promos. "Add a
   promo" makes one." points at a button elsewhere on the page. Unanswered
   already has the better pattern (`.empty-list`); seven lists do not.
4. **The two lists that grow have no search.** Unanswered draws up to 200
   questions; the knowledge base draws every document. Finding one means
   scrolling.
5. **The platform tenant form is one long page** (`tenant-form.tsx`, 455
   lines): details, theme, fallback words, suggested questions,
   applications, members, archive, stacked.
6. **Native `title` tooltips hide meaning from keyboard and touch users.**
   A bookings slot chip says only "taken"; *why* ("Overlaps a booking —
   maybe one from another day") is in `title`, which never shows on focus
   or on a phone.

---

## 2. Traps

1. **A toast behind a modal is invisible.** `showModal()` puts the dialog
   in the top layer and makes everything else inert, which is exactly why
   `.drawer-notice` exists. A toast region rendered in the page sits UNDER
   an open drawer. Put the region in the top layer too: a `popover="manual"`
   element shown with `showPopover()` (native, no library). A popover shown
   AFTER the dialog opens stacks above it. Walk it with a drawer open.
2. **A toast must not steal focus, and errors must not vanish.** Success:
   `role="status"`, auto-dismiss after ~5 s, paused on hover and focus.
   Error: `role="alert"`, stays until dismissed (WCAG 2.2.1: no timed
   reading of something you must act on). Reduced motion: no slide.
3. **A drawer's validation error belongs in the drawer.** The toast
   replaces the page notice, not `.drawer-notice`: an error about a field
   stays beside the form that has to change. Keep `.drawer-notice`; it just
   stops being a copy.
4. **Retry is the load function the screen already has.** No new fetch, no
   new route (Rule 3). If a screen's load is not a named function, name it;
   do not write a second one.
5. **Client-side search searches what was loaded.** Unanswered loads at
   most 200; the filter says "of 200 loaded" when the cap is hit, so nobody
   reads "no match" as "not there".
6. **Tabs must not lose a half-typed form.** The tenant form's details,
   theme, fallback and suggested questions are ONE form with ONE Save. Keep
   every panel MOUNTED (`hidden`, not unmounted), and keep that form's
   fields in one tab, or the Save posts fields from a panel the user cannot
   see.
7. **Class names are a test contract** (ui-refresh trap 6). `.notice`,
   `.empty-list`, `.segmented` keep their names; new classes are added.

---

## 3. Phases

Every phase: before screenshots → edits → `pnpm typecheck` + `pnpm test` →
after screenshots (light and dark) → keyboard walk → axe
(`plan/ui-refresh-a11y.mjs`) → the user's look → status.md and
whats-done.md. Each phase's walk catches every non-GET in the browser, as
ui-refresh's did, so no data moves.

### Phase 0 — Prerequisite and baseline

- Finish ui-refresh Phase 10 and commit it (status.md lists what is left).
- Screenshot the screens this plan touches into `plan/ui-components/0/before/`.

**Done 2026-10-08:** ui-refresh Phase 10 committed (`09aed2f`), the plan
committed (`33989bc`). 74 screenshots light and 74 dark, every page of the
three tenants plus the platform login, at 375 and 1280 px. Deviation: they
are in `plan/ui-refresh/components-0/before{,-dark}/`, under the folder
`plan/ui-refresh-shoot.mjs` already writes and git ignores, rather than a
new ignored folder; later phases use `components-<n>/after`.

### Phase 1 — Toast (findings 1, trap 1–3)

New `components/toast.tsx`, the same shape as `useConfirmDialog()` so a
screen changes few lines:

```ts
const { notify, toasts } = useToast();
notify({ message: 'Deleted "Summer".', kind: 'ok' });   // replaces setNotice(...)
// ...render {toasts} once, like {dialog}
```

- The region: a `popover="manual"` element, bottom-centre on a phone,
  bottom-right on a desktop, at most 3 stacked, newest last; a close
  button on each; tokens only (`--shadow-2`, `--radius-md`, status colours).
- Migrate the eight screens' `notice` state to `notify`. Keep `.notice` for
  standing banners (promos' overlap, the booking page, the theme contrast
  warning, the login form's error, which is already focused).
- `.drawer-notice` stays for errors while a drawer is open (trap 3); the
  toast does not repeat them.
- A pure helper (`toastTimeout(kind)`, the queue cap) is tested in
  `lib/toast.test.ts`.

**Done when:** on villa as an owner, deleting the last promo, confirming a
request at the bottom of Bookings, and saving inside an open drawer each
show feedback in the viewport; an error toast stays until closed; Tab
reaches its close button; axe is clean.

**Done 2026-10-08:** `plan/ui-components-phase1-walk.mjs`, 20/20 as a
harbor owner and a super user; every write caught in the browser, so both
of harbor's promos and HAR-4YXGRU (pending) were unchanged afterwards.
Deviations:
- ONE module-level queue and ONE `<Toaster />` per page, rendered by
  `StaffFrame` and the platform screen, instead of one region per screen.
  The platform shows the tenant form and its members panel together, and two
  regions would have stacked in the same corner. A toast also outlives the
  component that raised it, so the tenant form now says "Created." (before,
  it said nothing, because it was replaced).
- Walked on harbor, not villa: harbor has an unused promo to delete and a
  request to decide.
- Declined, not confirmed: harbor's one pending request clashes with a
  confirmed booking (D-099), so its Confirm is rightly disabled. Both go
  through the same `decide()`.

Found and fixed: deleting a document said nothing (the row just went); it
now says "Deleted … and its N chunks." The create-tenant error had no
`role="alert"`; it has now.

### Phase 2 — Load state: skeleton and error with Retry (finding 2, trap 4)

New `components/load-state.tsx`:

- `<ListSkeleton rows={n} />`: grey bars at the list's row height
  (the booking page's `.quote-skeleton` style, generalised), `aria-busy`
  on the list, one "Loading …" for screen readers.
- `<LoadError message onRetry />`: the `.notice error` look,
  `role="alert"`, a Retry button that calls the screen's existing load.
- Each screen's `loadMessage: string` becomes `{ state: 'loading' | 'error',
  message }`, so loading and failing can no longer look the same. 13 sites
  (§ 1 finding 2).

**Done when:** with the network throttled, every staff list shows a
skeleton; with the route answering 500 (caught in the browser), each shows
the error and Retry recovers it.

**Done 2026-10-08:** `components/load-state.tsx` (`LoadState`, `Load`,
`failed()`); 14 load states moved, on 11 screens plus the platform's tenant
detail and the knowledge base's chunk list. Bookings' and holidays' setup
loads, and the chunk load, were anonymous code inside an effect or a
toggle; they are named functions now (`loadSetup`, `loadChunks`), so Retry
runs exactly what failed (trap 4). The platform's detail load cancels on
a new selection, so its Retry bumps a counter the effect depends on.
`plan/ui-components-phase2-3-walk.mjs`: every list of harbor and the
platform, held (skeleton), failed (an alert in the server's words, with
Retry), retried (the list drawn), 30 checks.

### Phase 3 — Empty state with its action (finding 3)

New `<EmptyState icon title action?>{line}</EmptyState>` over the existing
`.empty-list` style (Unanswered's look, now shared). The action button
calls the SAME handler as the page's primary action (opens the drawer).
Sites: rooms, requests, holidays, slots, promos, platform tenants,
dashboard arrivals (no action), documents.

**Done when:** each empty list shows a title, one line and, where adding is
allowed for the role, a button that opens the right drawer; a staff role
with no write permission sees no button (`lib/permissions.ts`, the courtesy).

**Done 2026-10-08:** `EmptyState` in `components/load-state.tsx`, with a
`compact` variant for small panels. Seven sites, each with the page's OWN
add button (the same element as the header's), so a role that gets no
header button gets none here either: rooms, holidays, slots, promos,
documents, platform tenants; requests and the dashboard's arrivals have
none. The walk (the same script) answers each read with `[]`: 6 empty
states, each button opens its drawer (the platform's, its new-tenant
form), staff get no button on the knowledge base, a phone has nothing
wider than 375 px; 14 checks (44 in the script). Deviation: Unanswered keeps its own empty
state (a green check, good news), the pattern this one came from. Requests
is not walked: `[]` hides the whole section, and its empty state shows
only when every request has been decided.

### Phase 4 — Search and "show more" (finding 4, trap 5)

- **Unanswered:** a search field (`type="search"`, matches the question
  text, case- and accent-insensitive) above the list; 25 rows, then
  "Show 25 more"; the count reads "12 of 200 loaded" at the cap.
- **Knowledge base:** a search on title, shown only past 8 documents.
- A pure `matches(text, query)` in `lib/search.ts`, tested (Tagalog text
  too: villa's corpus).
- Empty search result uses Phase 3's `EmptyState` ("No match for …",
  Clear search).

**Done when:** on harbor, a word from one unanswered question narrows the
list to it, Escape in the field clears it, and the count is right.

**Done 2026-10-08:** `lib/search.ts` (`fold`, `matches`, `PAGE_SIZE`, 6
tests), `components/list-search.tsx`. Unanswered: the search, the count,
25 at a time; the cap reaches the screen as a prop from its server page
(`UNANSWERED_LIMIT`), as CLAUDE.md's conventions say a shared limit must.
The knowledge base: a search on titles past 8 documents (`SEARCH_FROM`).
`plan/ui-components-phase4-walk.mjs`, 14/14: on harbor's real 16 open
questions, "parking" left the 3 that have it; then 60 and 200 made-up
questions answered in the browser (25, 50, 60; "199 of 200 loaded
match"; "No question matches" and Clear search); 8 documents no search,
10 a search. Found and fixed: "Mark resolved" and "Reopen" said nothing
(the row just went) and put their errors in a banner at the top of the
card; both are toasts now, like every other row action (Phase 1).

### Phase 5 — Tabs on the platform tenant form (finding 5, trap 6)

New `components/tabs.tsx`: WAI-ARIA tabs (`tablist`/`tab`/`tabpanel`,
roving tabindex, ←/→/Home/End), panels kept mounted. The tenant form gets
**Profile** (details, theme, fallback, suggested questions: the one form
and its Save), **Applications**, **Members**, **Archive**. The selected tab
is kept in the URL hash so a reload stays on it.

**Done when:** a super user edits the theme, switches to Members and back,
and the typed colour is still there; Save still posts the same body (the
walk compares it with a pre-phase capture).

*Ask first (§ 5 q1): this is the one phase that changes a page's shape.*

**Done 2026-10-08:** `components/tabs.tsx` (the APG pattern: roving
tabindex, ←/→/Home/End with wrap-around, every panel mounted and labelled
by its tab). The tenant form's edit view is Profile (the one form, one
Save), Applications, Members, Archive, under the business name.
`plan/ui-components-phase5-walk.mjs`, 9/9: a colour typed in Profile was
still there after Members; the keyboard moved selection and focus; Tab
went from the tab into its panel; Save posted the same seven keys with
the typed colour (caught); a phone did not scroll sideways. Deviation: no
URL hash. A reload of `/platform` returns to the tenant list (the
selected tenant is not in the URL), so a remembered tab would restore
nothing.

### Phase 6 — Tooltip that shows on focus (finding 6)

New `<Tip label>` in `components/tooltip.tsx`: CSS-only show on `:hover`
and `:focus-visible`, `aria-describedby` to the tip text, never the only
carrier of meaning. Sites: the icon-only row buttons (edit, delete, move
photo), the bookings slot chips (which become focusable), the sources
panel's "found by" mark. On a phone, a chip's reason is ALSO written in the
day's row when the status is `taken` or `closed`.

**Done when:** Tab onto a taken chip shows its reason; a screen reader reads
it; axe is clean.

### Phase 7 — The record

D-102 in `decisions.md` (toasts for action feedback, banners for standing
facts; the top-layer reason); CLAUDE.md's Layout lists the four new
components; ui-refresh § 8 crosses off "toast notifications"; status and
whats-done.

---

## 4. Order and size

| Phase | What | Files (main) | Size |
|---|---|---|---|
| 0 | Prerequisite, baseline | — | S |
| 1 | Toast | `toast.tsx`, 8 screens, base.css | M |
| 2 | Load state | `load-state.tsx`, 11 screens | M |
| 3 | Empty state | `load-state.tsx` (same file), 8 screens | S |
| 4 | Search, show more | `unanswered-screen`, `admin-screen`, `lib/search.ts` | S |
| 5 | Tabs | `tabs.tsx`, `tenant-form`, `platform-screen` | M |
| 6 | Tooltip | `tooltip.tsx`, 6 screens | S |
| 7 | Record | docs | S |

Phases 1–3 are the most valuable and touch the same files: do them in
order. 4–6 are independent of each other.

---

## 5. Questions for the user

*Answered 2026-10-07: every recommendation taken. Tabs on the tenant form;
no tabs on Bookings; no room accordion yet; toasts bottom-right on a
desktop, bottom-centre on a phone.*

1. **Tabs on the tenant form (Phase 5)?** Recommended: **yes**; it is the
   only long, mixed page left. The alternative is to leave it stacked.
2. **Should the Bookings screen get tabs** (Requests · Availability)?
   Recommended: **no**: requests are the to-do and belong above the list,
   which the dashboard links to directly.
3. **Room cards as an accordion** (each room collapsed to a summary row)?
   Recommended: **no** for now; villa has one unit and harbor a handful.
   Revisit past ~6 rooms.
4. **Toast position**: bottom-right desktop / bottom-centre phone, as
   above? Recommended: **yes**; it stays clear of the sidebar and the
   chat's composer is not on staff screens.

## 6. Considered and not recommended

- **Confirm on "New chat"**: it would nag a visitor on a deliberate click;
  an Undo would be a feature.
- **Custom select or date picker**: native controls are the accessible,
  phone-correct ones (ui-refresh § 7 q5).
- **Server pagination**: a route change (Rule 3); 200 rows client-side is
  fine with search.
- **Splitting `bookings-screen.tsx`** (972 lines): a refactor, not a UX
  change; separate if wanted.
