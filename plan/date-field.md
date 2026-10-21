# Date field plan: one date picker, drawn by us, on every date in the app

> The user wants the UI to look the same in every browser ("i dont want to
> use the native form input fields as much as possible to make the ui
> looks consistent accross the all browswers"). D-142 was step 1: the
> number spinner and the file button hidden, nothing replaced. This is
> step 2, the only step a guest would notice: the 8 `type="date"` fields
> and the 1 `type="time"` field, which Chrome draws with a calendar icon
> and a popup, Safari as a spinner, an iPhone as a wheel and Firefox with
> its own popup. Each becomes ONE component of ours, `DateField`
> (`TimeField` for the one time), with the native input kept underneath
> so the forms validate as they did.
>
> Written 2026-10-21, against `ddbafab` on `master`, on `feat/native-fields`
> after step 1. **Status: Phases 0–3 done the same day; Phase 4, the
> user's look at the staff screens and a phone, owed.**
>
> Read [§ 0](#0-the-five-rules) first.

---

## What this plan covers

| | |
|---|---|
| **In scope** | `apps/web/lib/date-field.ts` (pure, tested: the month grid, the keys, the words), `components/date-field.tsx` and `components/time-field.tsx`, their styles in `screens.css` on tokens, the 9 call sites, a browser walk, the record. |
| **Out of scope** | The 15 `<select>`s and the 11 checkboxes and radios (D-142 § 3: they stay native). A range picker (check-in and check-out in one calendar): the booking page asks for a check-in and a number of nights (D-073), and that is not changing here. Any date library (D-001, D-101). |

---

## 0. The five rules

### Rule 1 — The native input stays, invisible, and the form still validates it

Every `DateField` renders `<input type="date">` over its button at opacity 0,
`tabIndex=-1`, `aria-hidden`, carrying `value`, `min`, `max`, `required` and
`disabled`. A form without `noValidate` (holidays, promos, the staff booking
form, legal) therefore still refuses an empty or out-of-range date exactly
as before; nothing in a route or a screen's submit handler changes. What
changes is the bubble: the `invalid` event is cancelled and the same words
are drawn under the field (`.hint.field-error`, `role="alert"`), so the
message looks the same in every browser too. A `noValidate` form (the
booking page, Manage booking) never fires it and keeps its own hints.

### Rule 2 — One component, one lib, no library

`lib/date-field.ts` holds every piece of arithmetic and every sentence:
`monthWeeks()`, `moveDate()`, `dayState()`, `dayName()`, `openAt()`,
`fieldDateLabel()`, `clockLabel()`, `normalizeClock()`. It reuses
`calendar-range.ts` (Monday-first, UTC midnights) and `longDate()` from
`calendar-labels.ts`, so the picker and the staff calendar agree on what a
week is and how a date is read aloud. The component draws what the lib says
and nothing else. Vitest covers the lib; the walk covers the component.

### Rule 3 — Keyboard first, as the WAI-ARIA date picker dialog

Enter, Space or an arrow opens; the grid is `role="grid"` with one day in
the Tab order (roving `tabIndex`); arrows move a day or a week, Home/End the
week's ends, PageUp/PageDown a month (Shift: a year); Enter or Space
chooses; Escape closes and focus returns to the button; Tab out closes.
A day that cannot be chosen is `aria-disabled`, still focusable, and its
name says why ("before the earliest date, …", "closed (Christmas)"), so a
screen reader is told what a sighted person sees greyed. The focused day's
reason is also written once under the grid.

### Rule 4 — Dates are the tenant's, never the device's, wherever a tenant exists

`today` is a prop: the booking page passes `page.today`, the staff forms
`setup.today`, both the tenant's calendar date from the server (trap 9).
The device's date is the LAST resort of `openAt()`, used only to decide
which month to open on for a field with no tenant date and no bounds (a
promo's validity, the DPA date), and it is never written anywhere.

### Rule 5 — Tokens only, light and dark, phone first

Every colour and size in `.date-*` is a token (D-101). The trigger restates
the field rule from `base.css` for a button, so it sits level with the
inputs beside it. On a phone (≤ 560 px) the dialog is a sheet pinned to the
bottom of the viewport, not a popover that would run off the edge of a
narrow field. A closed date is hatched AND struck, never colour alone.

---

## 1. The nine fields

| Screen | Field | Who sees it | `min` / `max` / `today` | Closed dates |
|---|---|---|---|---|
| S-6 booking page | Check-in date | guests | today / the horizon / today | yes, from `page.calendar` |
| S-13 Manage booking | Date paid (the proof form) | guests | none | no |
| S-13 Manage booking | New check-in (reschedule) | guests | none (the server decides) | no |
| S-3 New booking | Check-in | staff | today / the horizon / today | no |
| S-7 Holidays | Date | staff | today / – / today | no |
| S-10 Promos | Valid from, Valid to | staff | – / –; `to` ≥ `from` | no |
| Platform legal | DPA signed on | super user | none | no |
| S-9 Slots | Starts at (`TimeField`) | staff | – | – |

---

## 2. Phases

| Phase | What | Done |
|---|---|---|
| 0 | The lib and its tests (16) | ✅ 2026-10-21 |
| 1 | `DateField`, `TimeField`, the styles | ✅ |
| 2 | The nine call sites; typecheck; web tests | ✅ 234/234 |
| 3 | `plan/date-field-walk.mjs`: the booking page in a browser, keyboard and pointer, shots at 1280 and 375, light and dark; axe on the open dialog when axe is unpacked | ✅ see status.md |
| 4 | The user's look: Holidays, Promos, Slots, the staff booking form, and the booking page on a phone | owed |

---

## 3. Traps met

- A `<label for>` on a button REPLACES the button's name with the label's
  text, so the chosen date would not be read. The value is given through
  `aria-describedby` to a visually hidden span with the long date.
- A `readOnly` input is exempt from constraint validation, so the hidden
  native input is a controlled input with a real `onChange`, not read-only.
- Cancelling the `invalid` event also stops the browser focusing the field,
  so the component focuses its own button.
