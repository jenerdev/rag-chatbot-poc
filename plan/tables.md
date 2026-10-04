# Tables plan: rooms, room details, rates and prices as a table in the reply

> Today every list the chatbot gives is lines: "Garden Room (up to 2 guests):
> ₱3,500.00", one room per line, "Open: … / Taken: …" per date, and the
> code-written room list of D-087 as `- Room (up to N guests)`. The user wants
> a **table** whenever the reply presents a room list, room details, a price
> list or rates. This plan makes that happen in three places, in this order:
> the browser learns to draw ONE block syntax (a pipe table) as a real
> `<table>`, the replies written in code use it, and then the model is told
> to use it too, measured by the battery.
>
> Written 2026-10-04, against `89dfd49` on `master`. **Status: in progress,
> Phase 0 started 2026-10-04** on `feat/tables`. § 7's four questions were
> answered 2026-10-04: every recommendation taken, by the user's instruction
> (a rate card with no date joins Phase 2, amending D-081).
>
> Read [§ 0](#0-the-four-rules) first. Rule 1 is the one that keeps CLAUDE.md's
> "no markdown rendering" true in the way that matters.

---

## What this plan covers

| | |
|---|---|
| **In scope** | A pipe-table parser in `apps/web/lib/tables.ts` (pure, no dependency, tested) and a `ReplyText` component that renders a reply as text with each table block as `<table>`; CSS for the table inside a bubble, phone width included; the code-written room list (D-087) as a table; the model's room, availability and price answers as tables (harbor's and villa's tool instruction lines, `ROOM_LIST_LINES`, `WHOLE_PROPERTY_ROOM_LINES`, `extraGuestLines()`); table verdicts in the battery; the record (a decision, CLAUDE.md, flow.md, status, whats-done) |
| **Out of scope** | Any other markdown (bold, links, headings, lists): the parser knows ONE block shape and nothing else (Rule 1); a markdown library (D-001); `dangerouslySetInnerHTML` anywhere; a change to `buildPrompt()`'s base text (northwind's snapshot stays byte-identical, Rule 3); a change to a tool's DEFINITION (the two baselines stay byte-identical); a rate card with no date (§ 7 q1 decides whether it joins); the "Checked availability" evidence panel as a table (§ 7 q3) |

---

## 1. What the request assumes, and what is actually here

| The request says | What the code has | Consequence |
|---|---|---|
| "Present the room list as a table" | Three places write a room list: the model from a tool result (`rt-list`, `rt-guests`: "list each open room on its own line"), the model from the documents (`ROOM_LIST_LINES`, D-084), and code (`roomListReply()`, D-087, when the model ignores the line) | All three must agree on ONE syntax, or the screen draws some lists and not others. The syntax is a GitHub pipe table (§ 4). Code writes it exactly; the model is given an example of it (D-017: say what TO write) |
| "Room details" | `units.description` is staff free text and stays out of every prompt (bookings Rule 4); the details the model has are the documents' | A details column holds what the documents say, in the model's words, as today's lines do. Nothing new reaches the prompt |
| "Price list, rates" | A price exists only for a DATE (`unit_quote()`, D-082/D-083). With no date, D-081 answers one fixed sentence by the user's choice. The booking page reads `unit_rates` on the chat token (`bookingPage()`) | WITH a date, the tool rows become a table (one row per room or slot, with the price and its rate kind). WITHOUT a date, D-081's sentence stands unless § 7 q1 says a rate card joins; that card would be written in code from `bookingPage()`, the D-085 pattern |
| "A table in the chat" | `chat-screen.tsx` rule 2: "No markdown rendering in the MVP. Newlines are handled by CSS". `.bubble` is `white-space: pre-wrap`; a reply is one React text child, so it is escaped for free | The reply becomes a list of segments: text, table, text. A table is React elements (`<table>`, `<tr>`, `<td>` with text children), so the escaping is still free. No HTML is ever produced from a string (Rule 1) |
| Streaming | A tool answer with chunks STREAMS token by token; one with no chunks, an undated price or a room-list turn is HELD and arrives whole (answer.ts, D-035/D-081/D-087) | The renderer re-parses the whole text on every delta. A table whose separator line has not arrived yet is text; once it has, it is a table whose last row fills in as the tokens come (§ 2.2) |
| Saved history | A reply is saved as text and re-sent to the model as history (`MAX_HISTORY`) | A pipe table is readable text in the database, in the JSON (non-stream) reply and in the model's history. Nothing is stored twice |

---

## 0. The four rules

### Rule 1 — One block syntax, parsed into elements, never into HTML

The browser recognises exactly one shape: two or more consecutive lines that
start and end with `|`, whose SECOND line is a separator (`|---|---|`, each
cell `-` only, `:` allowed at the ends). That block becomes `<table>`; every
other line is text, as today. The parser is ~50 lines of our own in
`apps/web/lib/tables.ts`, with no dependency and no I/O (the chunker rule,
CLAUDE.md rule 5), and its output is React elements with text children.
`dangerouslySetInnerHTML` is still absent from the app, and "no markdown
rendering" in CLAUDE.md is narrowed to "one block syntax, tables, parsed by
hand", not dropped. A `|` inside ordinary prose does nothing, because a block
needs the separator line.

### Rule 2 — Every table a person sees is the same one the data holds

A table never adds, sums or reorders a figure. The code-written tables come
from the database rows (`TenantTools.rooms`, `bookingPage()`); the model's
come from the tool result, under the same lines that already say "quote only
from the tool, never add up a total" (R-23, R-37). The battery's price checks
compare each cell with the TOOL's row, as they compare a sentence today.

### Rule 3 — No tool definition and no base prompt changes

The table instructions live in the places that already hold per-tenant
prompt text: the tool INSTRUCTION lines in `tools.ts` and the per-turn lines
in `dates.ts`. They are prompt text (CLAUDE.md rule 1), so the battery is
re-run. The tool DEFINITIONS (`plan/baseline/villa-tools-post-villa-prices.txt`,
`harbor-tools-tables-phase0.txt`, harbor's since Phase 0 found its new Day Tour slot in the text) and northwind's prompt
(`northwind-prompt-pre-bookings.txt`) stay byte-identical: northwind has no
tools, so a table rule placed in `buildPrompt()` itself would reach it, and
trap 10 says a tools sentence can cost a documents answer.

### Rule 4 — A table is scoped to the answers that are lists

The instruction says WHEN to write a table (open rooms on a date, the room
list, a priced day, the extra-guest terms) and shows one. It does not say
"use tables". A single room's status ("Is the Sea View Suite free?",
`rt-taken`) and a single slot's price (`price-villa`) stay a sentence: a
one-row table reads worse than "Yes, open, ₱20,000.00 (weekend rate)".

---

## 2. Traps

### 2.1 The model writes an almost-table

gpt-4o-mini follows "write this, for example …" better than a rule (D-017),
but a table is a syntax, not a sentence: it will sometimes drop the
separator line, add a row with one cell fewer, or put a `|` in a price. The
parser is **strict about the separator and tolerant about the rest**: a
short row is padded, a long one is cut to the header's width, cell text is
trimmed. A block without a separator is text, so the worst case is today's
reply, never a broken screen. The battery counts how often the table is
well-formed (`tableOk`), so the instruction is tuned against a number, not
an impression.

### 2.2 A table arrives one token at a time

With chunks retrieved, the reply streams. For a moment the screen holds
`| Room | Guests |` with no separator: text, in pre-wrap, which is what it
would show today. When `|---|---|` lands the block becomes a table and the
rows below grow cell by cell. That is acceptable and simple; the alternative,
holding every tool turn, delays every availability answer by the whole
generation. `useLayoutEffect`'s scroll-to-bottom already fires per delta, so
a table growing is no different from text growing. The parser must be cheap:
it runs on the full text on every delta (a reply is under 2,000 characters).

### 2.3 A tables sentence in the wrong place costs a documents answer

Trap 10 happened once already: "start with a sentence that names the date"
for EVERY answer refused a Wi-Fi question 2 of 3. So the table instruction
goes only in the lines that are already scoped to rooms, availability and
prices, and the full battery runs, never `--only`. When `original`, `lang`
or `book` moves, the new line is the first suspect.

### 2.4 Tagalog and Taglish headers

The reply language is decided in code (D-043) and the model follows it for
prose. A table's header is text too: `Kwarto | Bisita | Presyo`. The
code-written tables carry all three languages, as `roomListReply()` does
today. The battery's `lang-*` cases do not reach a table (they ask the
deposit, the extension, the cook), so `rt-tagalog` and `price-villa-tl`
are the ones to read.

### 2.5 The phone

A four-column table with a price and a details column does not fit 360px.
The bubble is `max-width: 90%` and `overflow-wrap: anywhere`; a table needs
its own wrapper with `overflow-x: auto`, and `white-space: normal` inside
cells (the bubble's `pre-wrap` would otherwise keep every cell on one line).

### 2.6 "No matching chunks" turns still render

The sources panel and the refusal path are untouched. A refusal is the
tenant's friendly sentence (D-047) and never contains `|---|`, so it is
text. `refusalFilter` scans for the NO_ANSWER marker in streamed text; a
table cannot contain it.

---

## 3. The renderer

`apps/web/lib/tables.ts`, pure and browser-safe (like `money.ts`):

```ts
export type Segment =
  | { kind: 'text'; text: string }
  | { kind: 'table'; header: string[]; rows: string[][] };

/** Split a reply into text and table blocks. Never throws; unknown input is text. */
export function parseSegments(reply: string): Segment[];
```

- A line is a **row candidate** when, trimmed, it starts and ends with `|`.
- A **block** is 2+ consecutive candidates whose second line is a
  separator: every cell matches `/^:?-+:?$/`.
- Cells: split on `|`, drop the empty first and last, trim. A `\|` escape is
  not supported (nothing we write needs one, and the model is not told of
  it). Rows are padded or cut to the header's width.
- Everything else, including a lone candidate line and a block with no
  separator, is text, joined back with its newlines exactly as it was.

`apps/web/components/reply-text.tsx`: `<ReplyText text={…} />` maps segments
to `<span className="reply-text">` (pre-wrap, as the bubble is today) and
`<div className="reply-table"><table>…</table></div>`. Every cell is a text
child. The chat screen's answer bubble renders `<ReplyText>` instead of
`{turn.text}`; the user bubble does not change (a visitor's `|` is their
own text).

CSS, in `globals.css` beside `.bubble`: `.reply-table { overflow-x: auto;
margin: 8px 0 }`, `th`/`td` with `padding: 4px 10px`, a `var(--line)` rule
under the header, `white-space: normal`, a right-aligned class for a cell
whose text starts with a currency sign (prices line up).

Tests (`apps/web/lib/tables.test.ts`): a plain reply is one text segment; a
table alone; text, table, text; a block without a separator is text; a
short and a long row; a trailing partial row (streaming); `|` in prose;
Tagalog headers; an empty string.

---

## 4. The text shape

What the code writes and what the model is shown, so the screen draws them
the same. One blank line before and after a table.

**Rooms, no date (D-087's `roomListReply()`, and `ROOM_LIST_LINES` for the model):**

```
Here are our rooms:

| Room | Guests | Details |
|---|---|---|
| Garden Room | up to 2 | (what the documents say) |
| Family Room | up to 6 | … |

Tell me your dates and I can check which rooms are free and their rates.
```

The code-written version has no Details column (it has no documents).

**Open rooms on a date (harbor, `rt-list`, `rt-guests`):**

```
On 18 October 2026 these rooms are open:

| Room | Guests | Price |
|---|---|---|
| Garden Room | up to 2 | ₱3,500.00 (weekend rate) |
| Loft | up to 3 | ₱4,800.00 (weekend rate) |

Taken: Sea View Suite.
```

With `guests`, a fourth column, `Total`, carries the tool's `total` and the
sentence under the table names the extra-guest charge, as the line does
today ("+ ₱250.00 for 1 extra guest").

**A day's slots at villa (priced, `tool-*`, `price-villa-guests`):**

```
Yes, the Overnight slot is open on 8 October 2026.

| Slot | Status | Price |
|---|---|---|
| Overnight | open | ₱16,000.00 (weekday rate) |
| Day Tour | taken | |
| 22-Hour Whole Day | taken | |
```

The first sentence stays: `namesDate()` and the "Open:/Taken:" habit the
battery measured came from it. A multi-date range is one table per date,
each under its date sentence.

**The extra-guest terms (D-085, `extraGuestLines()`):** `| Room | Rate covers | Extra guest | Up to |`.

**A rate card with no date (only if § 7 q1 says yes):** `| Room | Slot | Weekday | Weekend | Holiday |`, from `bookingPage()`, followed by D-081's sentence shortened to "Tell me a date for the exact rate."

---

## 5. Phases

Each phase ends with its checks run and both record files updated
(CLAUDE.md "Keeping the record"). On a branch, `feat/tables`.

### Phase 0 — Baseline

- Full battery, three tenants; expect 59/61 and the known two. Save the
  output.
- `prompt-snapshot` for northwind diffed against its baseline; villa's and
  harbor's tool definitions against theirs. Three clean diffs.
- `pnpm test`, `pnpm typecheck`, verify 110.
- Six probe questions, saved verbatim in whats-done, so the after can be
  compared line for line: "What rooms do you have?" (harbor, villa), "What
  rooms are open on <date>?" (harbor), "What's open on <date>?" (villa),
  "Room rates please" (villa), "Magkano ang extra guest?" (harbor).

### Phase 1 — The renderer, no prompt change

- `lib/tables.ts` + tests; `components/reply-text.tsx`; CSS; the chat
  screen renders replies through it.
- `chat-screen.tsx`'s rule 2 comment rewritten to Rule 1 of this plan.
- Done when: the tests pass; typecheck is clean; `grep -rn dangerouslySetInnerHTML apps/web` prints nothing; a
  reply with no table renders exactly as before (the six probes, unchanged
  text); a table pasted as a DOCUMENT into northwind and asked for word for
  word renders as a table (the one way to see one before Phase 2).

### Phase 2 — The code-written tables

- `roomListReply()` writes § 4's table in all three languages; its tests.
- If § 7 q1 is yes: `rateCardReply()` in `tools.ts` from `bookingPage()`,
  used by `explainPrice()` in place of `PRICE_NEEDS_DATE` when the tenant
  has rates; D-081 amended; tests.
- Done when: the D-087 probe ("What rooms are available?" at harbor, which
  the model answers "Which date?" 4 of 4) shows the table; tests pass;
  battery unchanged (no battery turn fires D-087, as D-087 records).

### Phase 3 — The model's tables

- `tools.ts`: harbor's "list each open room on its own line … for example"
  and villa's "write two lines: Open: … Taken: …" become § 4's tables, each
  with its example; `PRICE_LINES`' "Open: Overnight ₱16,000.00; Day Tour
  ₱9,500.00" example becomes the Price column.
- `dates.ts`: `ROOM_LIST_LINES` and `WHOLE_PROPERTY_ROOM_LINES` say "as a
  table with the columns Room, Guests, Details, for example …";
  `extraGuestLines()` presents its terms as the table and asks for it back.
- The battery: a `tableOk(reply)` helper (the same parser's rule, written
  independently in the .mjs so a parser bug cannot bless itself); judged on
  `rt-list`, `rt-guests` and `price-villa-guests` (the list answers);
  printed, not judged, on every other `rt-*`, `tool-*` and `price-*` case.
  `rt-taken` and `price-villa` must stay a sentence (Rule 4), checked by
  `!tableOk`.
- Done when: the full battery is at its baseline count with the three
  table verdicts green, three runs in a row (trap 24: a flip is repeated
  before it is believed); the three baseline diffs are still clean;
  `[retrieve]` and `[query]` for any case that moved are read before any
  rewording; the six probes show tables in English and Taglish.

### Phase 4 — The browser walk

- villa, harbor, alteza as a visitor, desktop and 360px: the room list, a
  dated room list, a dated day at villa, a 5-guest question, the
  extra-guest terms, a Tagalog room list. Each table scrolls sideways on
  the phone and never overflows the bubble. A refusal and a greeting are
  untouched.
- The streaming moment of § 2.2 watched once on a chunked tool turn.

### Phase 5 — The record

- D-091 in `decisions.md`: one block syntax, parsed by hand into elements,
  the measured numbers from Phase 3.
- CLAUDE.md: the Frontend convention ("adding markdown rendering is what
  would take it away") amended to say tables are the one exception and
  why it is safe; the Layout block gains `lib/tables.ts` and
  `reply-text.tsx`; the battery sentence in rule 1 names `tableOk`.
- `flow.md` § 3: the reply's last step, "drawn as text and tables".
- `status.md`, `whats-done.md`.

---

## 6. What must not change

- `plan/baseline/northwind-prompt-pre-bookings.txt`,
  `villa-tools-post-villa-prices.txt`, `harbor-tools-tables-phase0.txt`:
  byte-identical (Rule 3).
- The battery's count outside the three judged cases; the known two
  failures stay the known two.
- `dangerouslySetInnerHTML`: still absent. `@rag/chunker`, `@rag/openai`:
  untouched. No new dependency anywhere.
- The non-stream JSON reply, the saved messages and the history: text, as
  today, now sometimes containing a pipe table.
- The sources panel and "Checked availability": unchanged unless § 7 q3
  says otherwise.

---

## 7. Questions, each with a recommendation · **answered 2026-10-04, every recommendation taken**

1. **A rate card with no date?** "Room rates please" gets D-081's sentence
   today, by your choice on 2026-09-30, because the alternative then was a
   refusal. With tables there is a third option: the weekday / weekend /
   holiday rates per room and slot from `unit_rates`, the rows the booking
   page already shows on the same chat token, followed by "tell me a date
   for the exact rate". **Recommend yes**, in code (the D-085 pattern), so
   the model never writes a rate from memory; it is the table a "price
   list" most plainly means. The cost: D-081 is amended, and a tenant with
   a long holiday calendar still gets only the three columns, never a
   per-date list.
2. **Should a one-row answer be a table?** `rt-taken` ("Is the Sea View
   Suite free?") and `price-villa` ("How much is the Overnight on …?").
   **Recommend no** (Rule 4): a sentence reads better, and it keeps the
   instruction scoped, which trap 10 wants.
3. **The evidence panel too?** "Checked availability" draws chips
   (`slot-chip`) per date and its `SlotRow` type predates prices, so the
   price and total in the result are not shown. A table there would show
   the row the reply was built from, cell for cell. **Recommend later, as
   its own small change**: it is the proof panel, not the reply, and
   mixing it in makes Phase 3's verdicts harder to read.
4. **Taglish headers or English headers in a Taglish reply?** Harbor's
   Taglish replies mix freely (D-043). **Recommend the reply language
   decides**, as it does for prose, and the code-written tables carry the
   three sets of headers. Nothing to tune until a probe shows a problem.
