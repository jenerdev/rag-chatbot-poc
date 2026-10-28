# Office app plan: the office as a page, with a floor you can see and employees you can talk to

> Today the office is files and a script. You talk to an employee by
> typing `claude --agent <name>` in a terminal, you read a board by
> opening `office/employees/<name>/board.md`, and you learn that a run
> finished by reading a JSON log. The user (2026-10-28): "create a plan to
> make the office runnable on a web app and has a ui. i can talk to ai
> employees via chat. each employees have task board. create a animated
> office with depart partition and put employee on the room partition
> sitting on their desk with their laptop."
>
> This plan gives the office ONE page on the user's own machine. The page
> is a drawn floor: one room per department, partitioned, and each of the
> ten employees seated at a desk with a laptop, moving when they work. A
> click on an employee opens their panel: a chat that IS a `claude
> --agent <name>` session, their task board and their inbox. Nothing new
> holds the truth: the boards, inboxes and pipeline stay the files
> `office.mjs` writes (plan/ai-employees.md Rules 3, 4, 10), the guard
> stays the hook (Rule 1), and the page is a view of them plus one way to
> start a session.
>
> Written 2026-10-28 by the user's request, without questions ("skip the
> questions, just write the plan"): every choice the user did not make is
> marked **my call** in § 7, with the default that stands if unanswered.
> **Status: complete, 2026-10-28** (D-153, R-65): Phases 0–6 done, the walk 16/16 three runs, Phase 5 8/8 with the real claude; evidence in `plan/office-app/`. **§ 7 answered 2026-10-28** (the user:
> "if there are questions. please follow your recommendations": every
> default stands). Nothing in the product changes.
>
> Read [`ai-employees.md`](./ai-employees.md) § 0 (the hook, not the
> prompt; one writer) and Phase 6's [`phase6.md`](./ai-employees/phase6.md)
> (`skills:` reaches a subagent only) before this one.

---

## 1. What the request assumes, and what is here

| The request says | What exists | What this plan does |
|---|---|---|
| "runnable on a web app" | `office/office.mjs`, zero dependencies; the product app is Next.js on Vercel | a SECOND, local app: `office/app/`, a `node:http` server on 127.0.0.1 and a static page. Never deployed (Rule 1) |
| "has a ui" | none; the record is markdown | one page: the floor, the side panel, the pipeline strip |
| "talk to ai employees via chat" | `claude --agent <name> -p … --output-format stream-json`, used by every Phase 6–7 run; `--resume <session>` continues one | the chat box spawns that command per message, resuming the employee's session, and streams its events to the page (Rule 2) |
| "each employees have task board" | `board.md` per employee, sections `doing`, `inbox`, `done`, `dropped`, written only by `office.mjs task …` | a board per employee in the panel, four columns; moving a card calls `taskMove()`, adding one `taskAdd()` (Rule 3) |
| "animated office with depart partition" | ten employees, nine roles, eight gates | five rooms behind glass partitions (§ 3.4), drawn as inline SVG, animated with CSS |
| "sitting on their desk with their laptop" | `avatar.svg` (initials on the profile colour) | each employee a seated figure in their colour, at a desk, a laptop whose screen shows their state (§ 3.5) |

---

## 0. The rules

### Rule 1 — Local only, and the page cannot be reached by anything but you

The server spawns agents that write files in this repo, run `pnpm`, and
spend the user's money. So:
- it listens on `127.0.0.1` only, never `0.0.0.0`;
- it prints a URL with a random 32-byte token once at start, and every
  request must carry it (a cookie set from the URL on first load);
- it refuses any request whose `Origin` or `Host` is not
  `http://127.0.0.1:<port>`, which stops a web page you visit from
  driving it (DNS rebinding, cross-site POSTs);
- it sends no CORS headers and serves its page with a strict CSP of its
  own (`default-src 'self'`).

It is never added to Vercel, `apps/web`, or `turbo`'s pipelines. A
deployed web app cannot run Claude Code against this working tree, and a
remote door to an agent that can write files is the one thing this plan
must not make.

### Rule 2 — A chat IS a `claude --agent` session; the page holds no second model

There is no API key in the office app and no model call it makes itself.
A message runs
`claude --agent <name> -p <text> --resume <session> --output-format stream-json --verbose --allowedTools <the employee's list>`,
exactly the command Phases 6–7 ran, so:
- the employee's charter, `skills:`, `tools:` and guard hook apply
  unchanged;
- what the employee says in the page is what they would say in the
  terminal;
- `claude --resume <session>` in a terminal continues the same chat.

The server never passes `--permission-mode bypassPermissions` or
`--dangerously-skip-permissions` (the classifier refused exactly that on
2026-10-28, rightly). A tool outside `--allowedTools` is denied, and the
page shows the denial.

### Rule 3 — `office.mjs` stays the ONE writer

The server imports `office.mjs`'s functions (`taskAdd`, `taskMove`,
`msg`, `inbox`, `pipeline`, `check`) and never writes a board, an inbox,
the pipeline or the sequence itself. Moving a card in the page is
`taskMove(id, to, { note })`. A new function `snapshot()` in `office.mjs`
returns every profile, board, inbox and idea as JSON, parsed by the same
parsers `check` uses, so the page cannot disagree with the files.

### Rule 4 — The files are the truth; the page is told when they change

The server watches `office/` (`fs.watch`, recursive) and pushes a
`changed` event over SSE. The page re-reads `snapshot()`. Whether the
board moved because of the page, a terminal session or a background
runner, the floor shows it. The page keeps no state the files do not.

### Rule 5 — Money is shown before it is spent and after

Every `result` event carries `total_cost_usd`. The panel shows each
turn's cost under it, and the top bar shows today's total, summed from
the session index (§ 3.2). A daily cap (`OFFICE_DAILY_USD`, default 10)
makes the page ask once before the turn that would cross it. This is
Rule 7 of ai-employees.md, made visible.

### Rule 6 — One writer to the working tree at a time

Authors write only their own folders, so they can run side by side. A
**builder** (Finn) or **tester** (Quinn) changes the tree, runs
`pnpm build` or a dev server, and trap 16 says a build breaks a running
dev server. So at most ONE builder-or-tester session runs at once; a
second is queued with its reason on screen. `office.mjs`'s writes take a
lock (§ 3.1), because two employees ending at the same second both
read-modify-write `sequence.json`.

### Rule 7 — The floor is drawn by hand and still reads without motion

Inline SVG and CSS keyframes, no animation or canvas library (the
house's D-101: no component library, no icon package). Every state an
animation shows is also text: a status line under each desk and the
panel's header. `prefers-reduced-motion: reduce` stops every loop and
keeps the stills. Each employee is a `<button>` with their name, title
and state as its accessible name; the floor is reachable by Tab.

---

## 2. Traps

### 2.1 `--resume` in print mode, partial text, and the shapes of events

Phase 0 of ai-employees.md measured hooks; nothing measured the events a
chat needs. These go to Phase 0 below before any code:
- `--resume <id>` with `-p`: whether it continues the session, and
  whether `session_id` stays the same or forks;
- `--include-partial-messages`: whether text arrives as deltas that can
  be streamed word by word, or only per message;
- a hook refusal: its shape in the stream (Phase 6 saw it as a
  `tool_result` with `is_error` and the text
  `PreToolUse:Write hook error: …`);
- a tool denied by `--allowedTools`: a different shape, `permission_denials`
  in `result`;
- the session limit: Phase 7 saw `result` with `is_error: true` and
  "You've hit your session limit · resets 8:20am": the page must show it
  as a limit, not a crash.

### 2.2 Killing a child on Windows

Phase 7's runner learned that pnpm's pid does not take `next`'s node with
it. A **Stop** button that kills `claude`'s pid may leave a `pnpm dev` or
a build running under it. Stop is `taskkill /PID <pid> /T /F` on Windows
and a process-group kill elsewhere, and Phase 0 checks that the tree is
gone.

### 2.3 Stdin

Phase 3 lost nine answers to a `claude -p` that read the loop's stdin.
Every spawn sets `stdio: ['ignore', 'pipe', 'pipe']`.

### 2.4 `CLAUDECODE` inherited from the shell that started the server

The runners unset `CLAUDECODE` and `CLAUDE_CODE_ENTRYPOINT` so a nested
`claude` does not think it is inside another session. The server removes
both from the child's environment.

### 2.5 A file watcher that fires per byte

An `office.mjs` write is several `writeFileSync` calls; `fs.watch` fires
for each, and on Windows sometimes twice. Changes are debounced (150 ms)
into one `changed` event.

### 2.6 The page is another way to type in the user's hand

A chat with Finn can still ask him to commit; his guard refuses it
(Rule 8 of ai-employees.md). The page adds no button that commits,
pushes, merges, switches branches or deploys. Those stay the user's,
in a terminal.

---

## 3. The shape

### 3.1 `office/office.mjs`: three additions, tested

- **The lock.** `withLock(fn)`: `mkdirSync('office/.lock')` with retry
  (every 25 ms for 5 s, then a refusal in words), removed in `finally`;
  a lock older than 30 s is stale and taken. Every function that writes
  (`taskAdd`, `taskMove`, `msg`, `inbox --ack`, `idea add`, `gate`,
  `hire`) runs inside it. `.lock` goes in `.gitignore`.
- **`snapshot()`.** `{ employees: [{ name, title, role, pronouns, colour,
  guard: kind, board, inbox, unread }], ideas, sequence, problems }`,
  where `problems` is `check()`'s list, so the page shows a broken office
  the way `pnpm office:check` does.
- **The session index.** `office/employees/<name>/sessions.json`, written
  through `office.mjs` only: `[{ id, started, title, turns, usd, last }]`.
  It holds no transcript. Claude Code keeps the transcript in
  `~/.claude/projects/`, and the page reads it back from there for
  history. SCRIPT_ONLY in `guard.mjs` gains `sessions.json`.

### 3.2 `office/app/server.mjs`: `node:http`, zero dependencies

| Route | Does |
|---|---|
| `GET /` | the page (`office/app/public/index.html`), with the token cookie |
| `GET /public/*` | `office.js`, `floor.js`, `panel.js`, `office.css`, the static files |
| `GET /api/office` | `snapshot()` plus each employee's live state (§ 3.3) |
| `GET /api/events` | SSE: `changed`, `state` (an employee started, waits, stopped), `chat` (one stream event of one session) |
| `GET /api/employees/:name/sessions` | the session index |
| `GET /api/employees/:name/sessions/:id` | that session's messages, read from the Claude Code transcript, as `{ role, text, tools[] }` |
| `POST /api/employees/:name/chat` | `{ session?, text }` → spawns the turn (Rule 2), answers `202 { session, turn }`; the stream arrives on `/api/events` |
| `POST /api/employees/:name/stop` | kills that employee's running turn (trap 2.2) |
| `POST /api/tasks` | `{ to, title, why, idea? }` → `taskAdd({ from: 'user', … })` |
| `POST /api/tasks/:id/move` | `{ to, note? }` → `taskMove()` |
| `POST /api/employees/:name/inbox/ack` | `inbox(name, { ackAll })` |

Every handler: the token, the Origin and Host check (Rule 1), a body cap
of 32 KB, a name matched against `/^[a-z][a-z0-9-]*$/` AND an existing
profile, and errors in ONE map (a refusal → 400 with `office.mjs`'s own
sentence, a missing employee → 404, the lock → 409).
`pnpm office` (root `package.json`) runs it and prints the URL.
`OFFICE_PORT` defaults to 4600.

### 3.3 An employee's live state

Derived, never stored:

| State | When | On the floor |
|---|---|---|
| `away` | no task in `doing`, no unread, no turn running | seated, laptop closed |
| `ready` | unread messages or a task in `inbox` | laptop open, an envelope with the count over the desk |
| `working` | a turn is running | typing; screen lines scroll; the name of the tool in use under the desk ("Reading plan/analytics.md") |
| `doing` | a task in `doing`, no turn running | laptop open, the task's title on the screen |
| `refused` | the last turn met a hook refusal | a red flash on the laptop for 2 s, then the previous state; the refusal text in the panel |
| `queued` | a builder-or-tester turn waiting (Rule 6) | an hourglass over the desk, "waits for Finn" |
| `limit` | the last turn ended on the session limit | a clock and "resets 8:20am" |

### 3.4 The floor: five rooms behind glass

A cutaway, front elevation, like a dollhouse: the building is cut open
and you look into five rooms side by side, two rows on a wide screen,
glass partitions between them, a door gap in each. It is drawn once, as
one SVG with a `viewBox`, so it scales. **My call**, the grouping by
department (§ 7 q2):

| Room | Who | Why together |
|---|---|---|
| **Front office** (reception, centre front) | George | intake: every idea reaches her first (charter § 8) |
| **Product** | Ivy, Rhea | gates 1 and 2: the idea and its requirements |
| **Design studio** | Uma, Vera | gates 3 and 4 |
| **Engineering** | Theo, Finn | gate 5 and gate 6 |
| **Review** | Quinn, Sage, Lex | gate 7: QA, security, legal side by side |

Each room has a sign with its name and the gates it owns, a plant or a
shelf for texture, and desks facing the viewer. On a phone (< 700 px) the
rooms stack one per row and the floor scrolls down; the panel becomes a
full-screen sheet.

Between rooms runs a thin **pipeline strip** along the bottom: each idea
as a chip on its rung (Planned … Released, ai-employees.md Rule 10),
coloured by lane. A click opens the idea's gates.

### 3.5 An employee at a desk

One SVG `<symbol>` per pose, coloured by `currentColor` from the
profile's colour (`COLOURS` in `office.mjs`): a seated figure from the
waist up (head, hair as a shape, shoulders, arms to the keyboard), a
chair back behind, a desk in front, a laptop open or closed, a mug. The
initials of `avatar.svg` on a name card on the desk. The animations, CSS
only:
- **breathing:** the torso scales 1 → 1.01, 4 s, always (off under reduced motion);
- **typing:** hands alternate, 0.3 s, while `working`;
- **screen:** three lines slide up in the laptop, while `working`; the
  screen glows the room's accent;
- **sip:** the mug lifts every 20–40 s at random, while `away` or `doing`;
- **look up:** the head turns to the viewer for 1 s when a message
  arrives;
- **refused:** the screen flashes `--danger` once.

No walking, no characters moving between rooms: the request says
seated, and motion that means nothing is noise. A **handoff** (a task
added from one employee to another) draws one paper plane along a curve
from desk to desk, 1.2 s, then the envelope appears. That is the one
motion that crosses rooms, and it means something.

### 3.6 The panel: Chat, Board, Inbox

A click on an employee opens a panel on the right (a sheet on a phone),
headed by their name, title, pronouns, guard kind in words ("writes
under docs/product/ only") and state.

- **Chat:**
  - the session list (newest first, from the index), **New chat**, and
    the open one;
  - your message, then the reply streaming in;
  - each tool call as one quiet line ("Read docs/requirements/analytics.md",
    "Bash: node office/office.mjs gate …"), expandable to its result;
  - a hook refusal as a red line with the guard's sentence;
  - the turn's cost and time under it;
  - a **Stop** button while it runs;
  - Enter sends, Shift+Enter is a new line;
  - the text is rendered as text, like the product's chat (no
    `innerHTML` from the model; code blocks and pipe tables drawn by a
    hand parser, as `apps/web/lib/tables.ts` does).
- **Board:**
  - four columns, Doing, Inbox, Done, Dropped (`SECTIONS`);
  - a card shows its id, title, from, idea and date; open, it shows the
    why and the note;
  - move a card with its menu (Move to Doing / Done / Dropped, with a
    note for Done and Dropped) and, on a pointer, by dragging; both call
    the same route;
  - **Add task** (to this employee, from you).
- **Inbox:** the messages, newest last, unread first marked; **Mark all
  read**; a message's task and idea ids are links that open them.

### 3.7 The page

`office/app/public/`: `index.html`, `office.css` (tokens on `:root`, a
dark scheme under `prefers-color-scheme`, and a body background), `floor.js`
(the SVG, the states), `panel.js` (chat, board, inbox), `office.js` (the
SSE client and the `snapshot()` store), `text.js` (the reply as text
plus tables, pure, tested). ES modules, no build step, no framework. The
top bar: the office name, today's spend against the cap, `check()`'s
problems as a warning, and the pipeline toggle.

---

## 4. Phases

### Phase 0 — The CLI contract, measured (trap 2.1, 2.2)
Five print-mode runs as George (read-only, cheap), each saved in
`plan/office-app/phase0/`:
1. a first turn;
2. `--resume` with the id it printed;
3. `--include-partial-messages`;
4. a forced hook refusal;
5. a run killed mid-turn by the method of trap 2.2, then `tasklist`
   showing no child left.

Recorded in `plan/office-app/phase0.md`: the event types and the fields
the server reads, whether the id forks, the cost of each. About 3 USD.
**Check:** every row of trap 2.1 has an observed answer.

### Phase 1 — `office.mjs`: the lock, `snapshot()`, the session index
`withLock()` around every writer; `snapshot()`; `sessions.json` read and
written through two functions; SCRIPT_ONLY gains it.
**Check:** `office.test.mjs` gains:
- two processes each adding 20 tasks at once end with 40 distinct ids;
- a stale lock is taken;
- `snapshot()` equals what `check` parsed;
- a guard refusal for a Write to `sessions.json`.

`pnpm office:check` green.

### Phase 2 — The server
`office/app/server.mjs` and its routes (§ 3.2), the token, the origin
check, the SSE stream, the spawn (Rule 2, traps 2.3, 2.4), Stop, the
watcher with its debounce, the queue of Rule 6.
**Check:** `office/app/server.test.mjs` (node:test) on a temporary repo
and a FAKE `claude` (a script on PATH that prints recorded Phase 0
events), so the tests spend nothing:
- 401 without the token;
- 403 for a foreign Origin, and for a Host that is not 127.0.0.1;
- 404 for an unknown employee;
- a chat streams the fake's events in order;
- Stop leaves no process;
- a second builder turn is queued;
- a task moved through the route appears on the board file;
- a file changed outside fires one `changed`.

### Phase 3 — The floor
The SVG building, five rooms, ten desks, the poses and states of § 3.3,
the handoff plane, reduced motion, the phone stack, the pipeline strip.
**Check:** a CDP walk (`plan/office-app-walk.mjs`, on
`plan/ui-refresh-cdp.mjs`, as every house walk), against the server with
the fake `claude`:
- ten buttons with the right names;
- each state drawn by a fake turn;
- reduced motion stops every animation (`getAnimations()` is empty);
- 1280 and 375 shots, light and dark, in `plan/office-app/walk/`.

### Phase 4 — The panel
Chat (sessions, streaming, tool lines, refusals, cost, Stop), Board
(columns, menu, drag, add), Inbox (read, mark read, links), `text.js`.
**Check:**
- `text.js` tested pure;
- the walk drives a chat with the fake;
- it moves a card, then reads `board.md` and finds the card moved;
- it adds a task and acknowledges an inbox;
- axe at 0 violations over the floor, each tab, and the phone sheet.

### Phase 5 — One real day
With the real `claude`: one chat with George ("what is owed?"), one with
Ivy resuming it, a refusal forced on Theo, a Stop, the cap prompt (cap
set to 0.5 for the run). About 4 USD.
**Check:** costs on the page equal each `result`'s `total_cost_usd`, the
terminal's `claude --resume <id>` continues the page's chat, and nothing
under `apps/` or `packages/` changed.

### Phase 6 — The record
- **`decisions.md`:** D-153, the office app (local only; a chat is a
  session; one writer; the floor). D-152 is the office's own, Phase 8 of
  ai-employees.md.
- **`risks.md`:** an entry for the local door (Rule 1's measures and what
  they do not cover: anything else running as the user).
- **The rest:** a CLAUDE.md paragraph and the `pnpm office` line under
  Commands; `office/README.md`; `status.md`; `whats-done.md`.

---

## 5. What must not change

- `apps/web`, every package, every SQL file, the three chatbot
  baselines: byte-identical; the walk checks `git status` under them.
- The guard's verdicts: the page reaches no tool the terminal would not.
- `office.mjs`'s board, inbox and pipeline line shapes: the files stay
  readable and writable from a terminal, and a board edited by the page
  diffs like one edited by `task move`.

---

## 6. Cost

Phases 0 and 5 call the real `claude`: about 7 USD together. Every other
check uses the fake. Building it is the engineer's session time: by
Phase 7's runs, roughly 2–4 USD per phase, so about 15–25 USD in all,
the fake keeping the tests at zero.

---

## 7. Questions, each with a default that stands if unanswered

All of these were **my call**, and the user took every default
(2026-10-28, "please follow your recommendations"): q1–q7 are answered as
written below.

1. **Local only (Rule 1).** **Default: yes.** A hosted office would need
   the Agent SDK on a server, an API key billed per token instead of the
   user's subscription, a copy of the repo and real authentication. That
   is a different project.
2. **The rooms (§ 3.4).** **Default:** Front office (George), Product
   (Ivy, Rhea), Design studio (Uma, Vera), Engineering (Theo, Finn),
   Review (Quinn, Sage, Lex). The other natural split is one room per
   gate, which is eight small rooms for ten people.
3. **The look.** **Default:** a flat, warm illustration in the employees'
   colours, a front cutaway like a dollhouse; not isometric (four times
   the drawing, and the desks are harder to read) and not pixel art.
4. **The daily cap (Rule 5).** **Default:** 10 USD, asked once per day
   when crossed.
5. **Drag on the board.** **Default:** drag on a pointer AND a menu on
   every card. A board that only drags fails a keyboard.
6. **Through the office's own pipeline?** This is a new feature, and
   plan/ai-employees.md Rule 9 says a new feature takes the full lane
   (Ivy → … → Theo). **Default:** this plan stands in for gates 1–5,
   because the user asked for it directly. George `idea add`s it on the
   short lane, and Finn builds it from this file.
7. **Who builds it.** **Default:** Finn, phase by phase, on a branch
   `feat/office-app`, after `deps-upgrade` is merged; Quinn reviews each
   phase's walk.
