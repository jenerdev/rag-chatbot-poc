# AI employees plan: an office of named agents that develop this project — George, and the nine-role organization

> The user wants the development of this repository done by a set of **AI
> employees**: each with a name, a job title, an avatar, its own skills, its
> own task board; each one the user can chat with directly; each able to talk
> to the others and to hand them tasks. The first hire is **George, Project
> Intelligence**: the one employee who knows the whole project (what it is,
> what it does, what is built and what is owed, every plan, every decision,
> what was done yesterday and what should be done now), who **never writes
> code**, and who briefs the others.
>
> On 2026-10-27 the user gave the office its **organization**
> ([`plan/ai-employees/organization.md`](./ai-employees/organization.md),
> verbatim): nine roles (Idea Strategist, Product Requirements Analyst, UX
> Architect, Visual Designer, Technical Architect, Full-Stack Engineer, QA
> Engineer, Security Reviewer, Legal Reviewer), an eight-gate workflow from
> an idea to a release, collaboration rules, the project memory George keeps,
> operating principles and a definition of success. "Do not implement an
> idea simply because it was requested."
>
> This plan builds the office as **files in this repo and agents in Claude
> Code**, nothing else: an agent definition per employee in `.claude/agents/`,
> an `office/` folder with each employee's profile, avatar, board and inbox,
> the organization's words as ONE skill every employee preloads, the
> deliverables of the gates under `docs/`, and ONE zero-dependency script,
> `office/office.mjs`, that is the only way a board, an inbox or the
> pipeline is written. Every employee's limits are a hook that reads its
> profile, not a sentence in its prompt. The product (the chatbot, its
> prompt, its tools, its database) is untouched by the office itself; it
> changes only through the gates.
>
> Written 2026-10-27, against `677defa` on `master`; the plugins added at
> `34c7df7` (D-150); **amended 2026-10-27 for the organization** (the roster,
> the gates, the guards by profile, § 4, § 6.2, Phases 5–8, q11–q16).
> **Status: q1–q12 answered 2026-10-27, every recommendation taken, by the
> user's word ("proceed with your recommendations", twice: the nine names
> of q11, Google Analytics for q12); Phases 0–3 done 2026-10-27
> ([`phase0.md`](./ai-employees/phase0.md), [`phase2.md`](./ai-employees/phase2.md),
> [`phase3.md`](./ai-employees/phase3.md)); George works here and has her
> digests; the thirteen plugins installed at project scope (§ 6).** Read
> [§ 0](#0-the-twelve-rules) first; the ten answers of Phase 3 are the
> user's to grade.

---

## What this plan covers

| | |
|---|---|
| **In scope** | The office: `office/` (profiles, avatars, boards, inboxes, George's digests, the pipeline) and `office/office.mjs` (hire, task, msg, inbox, index, check, idea, gate, pipeline); ONE guard hook that reads each employee's profile (read-only, author, tester, builder); George's agent file, charter and wake-up; the nine roles' charters from the organization's words, each with its gate, its deliverable folder under `docs/`, its guard and its kit; the eight gates and the seven-rung status ladder, in one file the script writes; the organization's shared sections as a skill every employee preloads; how the user talks to an employee and how employees talk; one idea through every gate as the proof, and one owed item through the short lane; the record (D-152, a CLAUDE.md paragraph; D-150 is the region pin); the thirteen plugins (§ 6), each mapped to the roles that use it |
| **Out of scope** | Editable Figma files unless the user logs the Figma server in (q14: specs first); a web UI for the office (a static page, Phase 8, optional); any change to the product except what an approved idea produces through the gates; a server, a database or a dependency for the office; running the employees unattended (schedules, `-p` mode: agent teams do not work there); a second record folder (`docs/decisions/` is not made: `decisions.md` is the record, q15) |

### What the user asked, and what the plan does with it

| The user's words | What exists today | What the plan does |
|---|---|---|
| "ai employees to handle the development of this project … each employee have their own skill and specialized works" | George (Phase 2); no other project agent | One agent file per employee: its tools, model, skills and charter; `office.mjs hire` makes the pair (the agent file and the office folder) |
| "i can talk to each employee via chat" | `claude --agent george` works (Phase 2) | `claude --agent <name>` opens a session AS that employee; `@agent-<name>` calls one from any session |
| "each employee can also talk to each other" | Subagents report to the caller only | A durable channel (the inbox file, written by `office.mjs msg`, read on every wake) and a live one (agent teams' `SendMessage`, on when the user wants a meeting) |
| "each employee have their task board. and they can assign task to other employee" | George's board, empty | `office/employees/<name>/board.md`: Doing / Inbox / Done / Dropped, ids `T-001…`, from, to, date, why; `office.mjs task add --to <name>`; the session's shared task list is a mirror of it, never the truth |
| "has their own name. and job title. has their own avatar" | George's | `profile.json` (name, title, pronouns, skills, since, colour, model, guard) and `avatar.svg` (initials on the employee's colour, replaceable by any image) |
| "first employee … knows everything about the project … Call her Project Intelligence … the name of this employee is George" | The record: `status.md`, `whats-done.md`, `decisions.md`, `risks.md`, `notes.md`, `plan/*.md`, `CLAUDE.md` (21,000 lines between them) | George (she/her, the user's word): tools `Read, Grep, Glob, Bash, Edit, Write, SendMessage`, a guard that lets her write under `office/` only and run only read-only git; digests with a watermark so she never re-reads the record whole |
| "Never implement code. Analyze, remember, document, answer questions, and brief other agents only." | A rule in a prompt is a rule the model can forget | The hook (Rule 1): a `Write` to `apps/` refused with exit 2, observed in Phase 2 |
| "use this plugins, install these plugins and ai employees should used them" (thirteen `/plugin install` lines) | Installed 2026-10-27 at project scope | § 6 says which role holds which and why; George's explicit `tools:` list reaches no MCP server and no skill |
| "before proceed on the next phase please update the plan base on the requirements" + the organization (nine roles, eight gates, the rules, the memory, the principles, the success) | George alone; three builders were the plan's q2 | § 4: the nine, each a hire with the organization's section as its charter, verbatim; Rules 9–12: the gates, the ladder, the guards by profile, the one set of words; `docs/<area>/<slug>.md` as each gate's deliverable, `plan/<slug>.md` as the architecture's (the house shape); the Full-Stack Engineer is ONE employee (q2 superseded); `idea`, `gate` and `pipeline` in the script; Phases 5–8 |
| the user's recommendation: "separate agents with dedicated role files, rather than one enormous prompt loaded into every conversation" and "`CLAUDE.md` should contain the shared rules and workflow" | `CLAUDE.md` is already the ONE orientation page, 1,073 lines | Dedicated role files, yes (`.claude/agents/`). The shared sections (§§ 1, 3–7 of the organization) go into a project SKILL, `office-organization`, preloaded by every employee's `skills:` line, and NOT into `CLAUDE.md`, so a plain session does not pay for them; `CLAUDE.md` gets one paragraph that points there (Phase 8) |

---

## 0. The twelve rules

### Rule 1 — George never changes code, and a hook says so, not her prompt

George's agent file carries a `PreToolUse` hook, `office/hooks/guard.mjs`,
that reads the call on stdin and **exits 2** (refused; the reason reaches
the model) unless:

- `Write`, `Edit`, `NotebookEdit`: the file path is under `office/`;
- `Bash`: the command begins with one of `git log`, `git show`, `git diff`,
  `git status`, `git blame`, `git branch --list`, `git rev-parse`, or
  `node office/office.mjs`. An allowlist, never a denylist: `git -c` can
  run a program, and a denylist is a list of what we thought of.

`Read`, `Grep`, `Glob` are free. The same hook is mirrored in
`.claude/settings.json` keyed on the hook input's `agent_type`, because the
frontmatter hook is documented for the subagent path and the mirror covers
a teammate. **Observed (2026-10-27, `plan/ai-employees/phase0.md`):** BOTH
copies fire under `claude --agent` and for a subagent; `agent_type` is the
agent's name in both cases and absent in a plain session; `agent_id` is a
subagent's alone. So the guard reads `agent_type`, runs twice under
`--agent` (it decides the same both times), and the settings mirror stays
for a teammate, whose frontmatter hooks are documented as not applied.
`Write(path)` permission rules never match (the docs say so), which is why
this is a hook and not a permissions entry. **Observed (Phase 2,
`phase2.md`):** every refusal in this list read back from the hook itself.

### Rule 2 — The record stays the ONE source of truth; George keeps digests, never a second record

`status.md`, `whats-done.md`, `decisions.md`, `risks.md`, `notes.md` and
`plan/*.md` are what the project knows about itself, and the employee who
does a step updates them (CLAUDE.md, "Keeping the record"). George's notes
under `office/employees/george/notes/` are **digests of the record**, each
with the commit and the line counts it was built from (`watermark.json`).
On wake she diffs the record since the watermark and amends the digests;
when a digest and the record disagree, the record wins and the digest is
rebuilt. George never edits a record file: that is what Rule 1's path
test says, and Rule 2 says why. The organization's § 5 ("Project Context
and Memory", "Use the project's existing documentation and source of
truth whenever possible") is this rule in the user's words; the
deliverables under `docs/` (Rule 9) are inputs TO the record, never a
second one: what was built is in `whats-done.md`, what was decided in
`decisions.md`, and a requirements file says what was asked.

### Rule 3 — A task exists only on a board file, in git

`office/employees/<name>/board.md` is the board. A task has an id
(`T-001`, one sequence for the whole office, in `office/sequence.json`),
`from`, `to`, the date, a title, a `why` line and a status (`inbox`,
`doing`, `done`, `dropped`). Only `office.mjs task` writes one. The
shared task list that agent teams keep (`~/.claude/tasks/`) is
session-scoped and lives outside the repo; it is a **mirror** an employee
may use during a meeting, and anything on it that is not on a board at
the end of the session was never assigned.

### Rule 4 — Two channels: the inbox file always, `SendMessage` when a team is live

A message between employees is a line appended to the recipient's
`inbox.md` by `office.mjs msg` (never rewritten; `office.mjs inbox --ack`
marks it read). Every employee reads its inbox and its board **first on
every wake**, before the user's question: that is the stand-up. When the
user turns agent teams on for a session
(`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`), employees may also talk live
through `SendMessage`; a decision reached live is written to the inbox or
the board before the meeting ends, or it did not happen (Rule 3).

### Rule 5 — One employee is one agent file and one office folder, and `check` proves they agree

`.claude/agents/<name>.md` holds the identity Claude Code reads (name,
description, tools, model, colour, hooks, skills, the charter as the
body); `office/employees/<name>/` holds what people read (profile, avatar,
board, inbox, notes). `office.mjs hire <name> "<title>" --guard <kind>`
writes both from one template; `office.mjs check` fails when a folder has
no agent file or an agent file no folder, when `profile.json`'s name
differs from the frontmatter's, when a frontmatter key is not in the
documented list (unknown keys are **silently ignored** by Claude Code, so
a misspelled `disallowedTools` is a guard that is not there), when a
board's ids are not unique, when the thirteen plugins are not all enabled,
when a read-only or author employee's `tools:` reaches `Skill` or an MCP
server it was not given, when an employee does not preload the
`office-organization` skill (Rule 12), or when a gate on the pipeline
names a deliverable file that does not exist (Rule 10).

### Rule 6 — The office is files and one script with no dependency

`office/office.mjs` is Node with zero dependencies and `node:test` tests,
like `@rag/chunker`: readable alone, no install. No server, no database,
no vector index for the office: George searches the record with `Grep`,
which is what the record's headings and `D-`/`R-` numbers were written
for. The product's pipeline is not borrowed to index the project.

### Rule 7 — An employee spends nothing it was not asked to spend

The battery, the walks that call OpenAI, the voice checks and anything
that mints a token against the live database cost money or write rows. A
task that needs one says so in its `why` line, and the employee runs
exactly that. George spends nothing, ever: she has no network tool and her
Bash allowlist reaches no `pnpm`, no `node` but the office script. The
seven authors (§ 4) spend nothing either, by the same allowlist; the QA
Engineer and the Full-Stack Engineer run what their task names.

The plugins add two kinds of spend (§ 6). security-guidance's Stop hook
runs a model review of the diff after every turn, in every session of
this repo, George's included: accepted for the engineer and QA as the
price of the review, and measured on George in Phase 3 (a session that
edited only markdown under `office/`), where Rule 7 decides whether her
sessions keep it. The four MCP servers (GitHub, Supabase, Playwright,
Context7) can act on live systems: § 6.3 holds them to the house rules,
and q9 and q10 set the two that can write.

### Rule 8 — Employees never commit, merge, push, deploy or release

That is the user's hand, as it is for Claude today ("commit or push only
when the user asks"), and the organization's own words ("Do not deploy to
production without the required authorization"). An engineer's task ends
with the record updated and the suites' numbers on the board; QA says
READY or not (gate 8); the user commits, deploys and marks the idea
released (`office.mjs gate <slug> released --by user`).

### Rule 9 — Nothing is built that was not approved: eight gates, and a short lane for what is already owed

"Do not implement an idea simply because it was requested." A new product
or a significant feature passes the organization's eight phases as eight
**gates**, each with ONE owner, ONE deliverable file and ONE verdict
written by `office.mjs gate` (§ 2, § 4.2): idea (APPROVE / REVISE /
RESEARCH / REJECT), requirements, ux, design, architecture,
implementation, review (qa: PASS / FAIL; security: CLEAR / FINDINGS with
a severity; legal: CLEAR / NEEDS REVISION / PROFESSIONAL REVIEW
REQUIRED), release (READY / READY WITH DOCUMENTED RISKS / NOT READY). A
gate's owner hands the next gate its task (`task add`) and a message
naming the deliverable it produced. The Full-Stack Engineer takes no task
whose idea has not passed the idea, requirements and architecture gates
(UX and design when the idea has a screen); George's audit (§ 3.2 item 6)
checks the pipeline before the board.

The organization says "for new products and significant features". An
item the record already calls owed (a walk, a field on a screen, a
tradeoff the user chose), or a defect QA found, takes the **short lane**:
`idea add --lane short`, gates implementation and review (qa; security
and legal when George or QA asks for them), because its idea,
requirements and architecture ARE the plan it is owed from. George decides
the lane and says why; the user may override.

### Rule 10 — The ladder is derived, in one file the script writes

`office/pipeline.md` holds every idea and its gates. Its status is the
organization's seven rungs, **derived** from the gates, never typed:
Planned (the idea is on the file), Approved (gate 1 APPROVE), In progress
(the architecture gate passed and the engineer's task is in Doing),
Implemented (the implementation gate, written by the engineer with the
record entry it points to), Tested (qa PASS), Reviewed (security and
legal written, no CRITICAL or HIGH open without a documented acceptance),
Released (the user's word, with the commit). "Never claim a feature is
implemented merely because it is documented or planned": Implemented is
a gate the engineer writes AFTER the record entry exists, and `check`
refuses a gate whose file is missing.

### Rule 11 — One guard, four kinds, read from the profile

`office/hooks/guard.mjs` stays the ONE hook, in every employee's
frontmatter and in the settings mirror, and decides from
`profile.json`'s `guard`:

| Kind | Writes (Write / Edit / NotebookEdit) | Bash | Who |
|---|---|---|---|
| `read-only` | `office/` only, and never a board or an inbox directly | the allowlist of Rule 1 | George |
| `author` | `office/`, its own `docs/<area>/`; the Technical Architect also `plan/`, `decisions.md`, `risks.md` | the allowlist of Rule 1 (the Security Reviewer also `pnpm audit`) | Idea Strategist, Product Requirements Analyst, UX Architect, Visual Designer, Technical Architect, Security Reviewer, Legal Reviewer |
| `tester` | `office/`, `docs/qa/`, test files only (`*.test.ts`, `*.test.tsx`, `*.test.mjs`, `plan/*-walk.mjs`, `plan/*-a11y.mjs`, `packages/*/tools/*.mjs`) | everything but the user's hand (below) | QA Engineer |
| `builder` | everything but another employee's `office/employees/<x>/` and any board or inbox (the script writes those) | everything but the user's hand: `git commit\|push\|merge\|rebase\|reset\|checkout\|stash\|branch -D`, `gh pr create\|merge`, `vercel` | Full-Stack Engineer |

A board or an inbox is written by the script alone, for every kind: a
direct `Edit` of `board.md` is refused. The two allowlists are allowlists;
the builder's and the tester's are **denylists of the user's hand**,
accepted as the weaker wall because an engineer runs anything, and Rule 8
stays a prompt rule beside it (§ 7.12). `hire --guard <kind>` writes the
kind's table into the profile; the hook reads the profile, so a kind can
be tightened for one employee without a second hook.

### Rule 12 — The organization's words are ONE file, copied, never reworded

`plan/ai-employees/organization.md` is the user's text verbatim. The
shared sections (§ 1 Mission, § 3 Workflow, § 4 Collaboration, § 5 Memory,
§ 6 Principles, § 7 Success) become ONE project skill,
`.claude/skills/office-organization/SKILL.md`, by copy, preloaded by
every employee's `skills:` line (George included: § 5 is her mission in
the user's words). Each role's "Employee N" section is copied into that
employee's agent file as the first part of its charter; the house
additions (where its deliverable goes, which gate it owns, whom it hands
to, the CLAUDE.md rules by number that bind it) follow under their own
heading. When the user changes the organization file, Phase 6's copy
step is re-run, and `check` compares the skill with the file byte for
byte.

---

## 1. The office

```
.claude/agents/
  george.md                 the agent: frontmatter + charter (§ 3)
  <nine>.md                 one per role (§ 4), from the organization's section + the house additions
.claude/skills/
  office-organization/SKILL.md   the shared sections of the organization, verbatim (Rule 12); every employee preloads it
  project-record/SKILL.md        how the record is kept (CLAUDE.md "Keeping the record", the whats-done entry shape, the D-number form); the engineer and QA preload it (q4)
.claude/settings.json       the guard mirror (PreToolUse on Write|Edit|NotebookEdit|Bash) and the thirteen plugins
office/
  README.md                 who works here, how to talk to one, the rules in a paragraph
  office.mjs                the ONE writer of boards, inboxes and the pipeline (§ 2)
  office.test.mjs           node --test
  sequence.json             { "task": 12, "message": 40 }
  pipeline.md               every idea, its lane, its gates, its derived status (Rule 10)
  hooks/guard.mjs           Rule 11
  employees/
    george/                 profile.json, avatar.svg, board.md, inbox.md, notes/ (§ 1 of the first plan: README, watermark, project-map, decisions-index, risks-open, owed, briefs/, drafts/)
    <nine>/                 the same four files; notes/ for what the role keeps between tasks
docs/
  product/<slug>.md         gate 1, the Idea Strategist's required output
  requirements/<slug>.md    gate 2, the Product Requirements Analyst's
  ux/<slug>.md              gate 3, the UX Architect's (wireframes as text or inline SVG)
  design/<slug>.md          gate 4, the Visual Designer's (tokens in tokens.css's terms, D-101)
  qa/<slug>.md              gate 7 (qa) and gate 8 (release): the test plan, the results, the traceability, the readiness
  security/<slug>.md        gate 7 (security): findings with severity
  legal/<slug>.md           gate 7 (legal): concerns, jurisdiction, the recommendation
plan/<slug>.md              gate 5: the Technical Architect's plan, in the HOUSE shape (§ 0 rules, traps, phases, questions), where every plan already lives
```

No `docs/architecture/` (the architecture is a plan, and plans are in
`plan/`) and no `docs/decisions/` (`decisions.md` is the record, Rule 2;
q15). The deliverable folders are made by the first `gate` that writes
into them.

**The board**, `board.md`, is markdown a person reads and a script
rewrites:

```
## Doing
- T-014 · 2026-10-28 · from george · **Phase 4 walk of booking-types** · why: owed since 2026-09-27, status.md ▶ Next up

## Inbox
- T-015 · 2026-10-28 · from user · **Pin preferredRegion** · why: D-149's largest production win, a tradeoff the user chose
```

**A message**, one line in `inbox.md`:

```
- [ ] M-041 · 2026-10-28 09:12 · from george · T-014 is yours; the plan's § 4 names the four checks; run nothing that spends (Rule 7)
```

**The pipeline**, `pipeline.md`, one block per idea, the status derived:

```
## analytics · Google Analytics on the public pages · full lane · from user · 2026-10-28 · **Approved**
- idea · APPROVE · by ivy · 2026-10-28 · docs/product/analytics.md
- requirements · DONE · by rhea · 2026-10-29 · docs/requirements/analytics.md
- requirements · APPROVE · by user · 2026-10-29
```

**The avatar** is an SVG the `hire` command draws (two initials on the
employee's colour, the same eight colours Claude Code allows for an
agent's `color`); the user replaces it with any PNG or SVG of the same
base name. The office page (Phase 8) and the README's roster table draw
it. `pronouns` in `profile.json` holds what the user decides (George:
she/her, the user's "Call her"), and every template reads it.

---

## 2. The script

`node office/office.mjs <command>`, zero dependencies, every write
through it (Rules 3, 4, 6, 10):

| Command | Does | Since |
|---|---|---|
| `hire <name> "<title>" [--colour c] [--model m] [--pronouns p] [--guard read-only\|author:<area>\|tester\|builder]` | writes `.claude/agents/<name>.md` from the template (the kind's tools list, the guard hook, the `skills:` preload) and `office/employees/<name>/` with profile (the kind's guard table), avatar, empty board and inbox; refuses a name that exists | Phase 1; the kinds Phase 5 |
| `task add --to <name> --from <who> "<title>" --why "<why>" [--doing] [--idea <slug>]` | the next `T-` id, in the recipient's Inbox; `--doing` lands it in Doing; `--idea` ties it to a pipeline block | Phase 1; `--idea` Phase 5 |
| `task move <id> doing\|done\|dropped [--note "…"]` | moves it; `done` and `dropped` take a note | Phase 1 |
| `task list [<name>] [--all] [--json]` | the board(s) as text; `--json` for the page | Phase 1 |
| `msg --to <name> --from <who> "<text>"` | the next `M-` id, appended to the inbox | Phase 1 |
| `inbox <name> [--ack <id>\|--ack-all]` | reads; `--ack` ticks the box | Phase 1 |
| `index [<name>]` | regenerates `decisions-index.md` and `risks-open.md` from the headings of `decisions.md` and `risks.md`, and refreshes `watermark.json` (George runs this on wake; it is the one write that is mechanical) | Phase 1 |
| `idea add <slug> "<title>" --from <who> [--lane full\|short]` | a block on `pipeline.md`, status Planned; `full` by default; `short` for an owed item or a defect (Rule 9) | Phase 5 |
| `gate <slug> <gate> --by <name> --verdict <V> [--file <path>] [--note "…"]` | one gate line; refuses an owner that is not the gate's (§ 4.2), a verdict the gate does not have, a `--file` that does not exist, a gate whose predecessor has no passing verdict (the user may `--override`, recorded); re-derives the status | Phase 5 |
| `pipeline [<slug>] [--json]` | the ideas and their status; `--json` for the page | Phase 5 |
| `check` | Rule 5's audit; exit 1 on any mismatch; `pnpm office:check` | Phase 1; extended Phases 5–6 |
| `organization` | copies the shared sections of `plan/ai-employees/organization.md` into the skill and each role's section into its agent file's charter head, byte for byte, and reports what changed (Rule 12) | Phase 5 |
| `page` | Phase 8: writes `office/office.html`, everything inlined | Phase 8 |

`from`, `to` and `--by` are validated against the roster plus `user`; an
unknown name is an error, not a new employee (Rule 5).

---

## 3. George

### 3.1 The agent file

```yaml
---
name: george
description: Project Intelligence. The one employee who knows the whole project — what it is, every feature, decision, plan, risk and owed item, what was done yesterday and what is next. Ask her before starting any work on this repo, to brief another employee, or to audit that a finished task kept the record. She never writes code.
tools: Read, Grep, Glob, Bash, Edit, Write, SendMessage
model: inherit
color: blue
skills:
  - office-organization
hooks:
  PreToolUse:
    - matcher: "Write|Edit|NotebookEdit|Bash"
      hooks:
        - type: command
          command: "node office/hooks/guard.mjs"
---
```

(`skills:` joins in Phase 5, when the skill exists.) No `memory:` field: it
would auto-enable Write and Edit outside the hook's reach and put her notes
in `.claude/agent-memory/`, outside the office. No `isolation:` (a
worktree would swallow her notes). `permissionMode` stays `default`: the
hook, not the mode, is the wall. The `tools:` list is explicit, so it is
the plugin wall too: no `Skill`, so no plugin skill fires in her session;
no `mcp__*` tool, so the GitHub, Supabase, Playwright and Context7 servers
do not exist for her (§ 6.1). A plugin's hooks still run around her
(security-guidance's four, superpowers' session start), because a hook is
not a tool. **Observed (Phase 2):** 7 tools in her init event, 0 MCP, no
Skill; 99 and 65 in a plain session's.

### 3.2 The charter (the body of the file)

The user's words, verbatim, open it:

> Mode: Non-coding, read-only project advisor.
> Mission: Maintain a reliable, comprehensive understanding of the
> application's vision, features, architecture, implementation status,
> development history, decisions, blockers, and next steps.
> Primary rule: Never implement code. Analyze, remember, document, answer
> questions, and brief other agents only.

Then what the plan adds (written in Phase 2; items 8–10 join in Phase 5):

1. **Where the truth is.** The record files and `plan/*.md`, by name, with
   what each answers (CLAUDE.md's table), and the sizes: `whats-done.md`
   is 10,000 lines, so it is read by heading (`grep -n "^## "`) and by
   offset, never whole. `CLAUDE.md` is the map of the code; `flow.md`
   what the pipeline does; `decisions.md` why.
2. **The wake-up.** Read `notes/README.md`; run `office.mjs index`; read
   `git log --oneline <watermark>..HEAD` and `git diff --stat` of the
   record files; read what changed in `status.md` (▶ Next up first) and
   the new `whats-done.md` headings; amend `project-map.md`, `owed.md`
   and the watermark; read the inbox and the board; then the question.
3. **How to answer.** The answer first, then where it comes from: a
   D-number, an R-number, a plan's section, a `whats-done.md` date, a
   file and line. "The record does not say" when it does not; never a
   guess dressed as a record. Dates absolute. Numbers as the record has
   them (observed, never predicted).
4. **The daily brief.** When asked "what did we do yesterday" or "what
   now", write `briefs/<today>.md` (yesterday's `whats-done.md` headings
   and commits; today's ▶ Next up; the owed items; open tasks per
   employee; the pipeline's statuses) and answer from it.
5. **Briefing another employee.** A task through `office.mjs task add`
   with a `why` the record supports, and a message naming the plan
   sections and the rules that apply (Rule 7 when money is involved; the
   CLAUDE.md rules by number). George assigns; she does not build.
6. **The audit.** When an employee reports done, George checks the
   pipeline first (the gate exists, its file exists, its predecessor
   passed), then that `status.md` and `whats-done.md` were updated for a
   built thing, that `decisions.md` has the D-number the task promised,
   that the suites' numbers are on the board, and that the baselines are
   byte-identical when the chatbot was said to be untouched; then `task
   move <id> done`, or a message back saying what is missing.
7. **What she refuses.** Any edit outside `office/`, any `pnpm`, any
   network, any commit (she cannot: the hook), and any request to "just
   fix it quickly" is answered with a task for the right employee. A plan
   she wants to draft goes under `office/employees/george/drafts/` (q8).
8. **Intake.** An idea from the user reaches George first: `office.mjs
   idea add <slug> "<title>" --from user` (the lane by Rule 9, said in
   the block), then a task to the Idea Strategist (full lane) or the
   Full-Stack Engineer (short lane), with the record's context in a
   message: what exists, what the plan already says, what is owed near it.
9. **The ladder.** George reports an idea's status from `office.mjs
   pipeline`, never from a document's existence (Rule 10), and says which
   gate is next and whose it is.
10. **The organization's memory.** The organization's § 5 list is what her
    digests hold: `project-map.md` (vision, features, architecture,
    implemented), `owed.md` (outstanding tasks, known bugs, technical
    debt), the pipeline (approved and rejected ideas, requirements,
    designs, reviews, status), and `briefs/` (next actions); test results
    and security and legal findings are read from `docs/qa/`,
    `docs/security/` and `docs/legal/` and summarised, never copied.

### 3.3 What she must know on day one

`project-map.md`, built in Phase 3 from `CLAUDE.md`, `architecture.md`,
`techstack.md`, `screens.md`, `flow.md` and the D-number paragraphs: the
product (a multi-tenant RAG chatbot for resorts with bookings, payments,
staff roles, a platform), the stack (Next.js 15, Supabase Postgres with
pgvector and RLS, OpenAI over raw fetch, pnpm workspaces, no framework in
the pipeline), the five packages, the 18 screens, the 45 SQL files, the
suites and their last numbers, the two deleted test tenants and what
cannot run without them, and the owed list as of today (the booking-types
Phase 4 walk; promos', dashboard's and notifications' walks; the platform
form's free-guest field on screen; custom SMTP, R-21; the eval tenants'
rebuild; `todo.md`'s lines).

---

## 4. The nine

### 4.1 The roster

Titles and charters are the organization's (Rule 12); names are the
user's (q11 recommends nine); the guard kind and the kit are the plan's.
Every one: `model: inherit` (q7), `skills: office-organization` (+ what
the row says), the guard hook in its frontmatter, `color` as the row says
(eight colours for ten employees: two pairs share).

| # | Title (the organization's) | Recommended name | Guard (Rule 11) | Owns gate | Deliverable | Hands to | Preloaded skills | MCP tools (named in `tools:`) |
|---|---|---|---|---|---|---|---|---|
| 1 | Idea Strategist | Ivy (yellow) | author: `docs/product/` | 1 idea | `docs/product/<slug>.md`: the required output, the decision and its justification | 2 | office-organization; superpowers' `brainstorming` | Context7 (what exists elsewhere), GitHub read (q10: what the repo's issues say) |
| 2 | Product Requirements Analyst | Rhea (orange) | author: `docs/requirements/` | 2 requirements | `docs/requirements/<slug>.md`: FR-ids, stories, rules, flows, acceptance criteria, edge cases, open questions | 3, 5 (and 7 QA, for traceability) | office-organization | none |
| 3 | UX Architect | Uma (pink) | author: `docs/ux/` | 3 ux | `docs/ux/<slug>.md`: journeys, flows, sitemap, screen inventory, wireframes (text or inline SVG), interaction and navigation rules, a11y, responsive | 4 | office-organization | Playwright (to LOOK at the screens that exist; never a check, § 6.3) |
| 4 | Visual Designer | Vera (purple) | author: `docs/design/` | 4 design | `docs/design/<slug>.md`: screens, tokens IN `tokens.css`'s terms (D-101: a new shade is a `color-mix()` of the five theme keys), components, states, responsive, hand-off | 5, 6 | office-organization; `frontend-design` | Figma when logged in (q14); Playwright to look |
| 5 | Technical Architect | Theo (cyan) | author: `docs/architecture/` is NOT made; `plan/`, `decisions.md`, `risks.md` | 5 architecture | `plan/<slug>.md` in the house shape (§ 0 rules, traps, data model, phases, questions), the implementation tasks as its phases; a D-number when a decision is made | 6, and 8 (security, before implementation) | office-organization; superpowers' `writing-plans` (the house shape wins, § 6.3); `supabase-postgres-best-practices` | Supabase read-only (q9), Context7 |
| 6 | Full-Stack Engineer | Finn (green) | builder | 6 implementation | the code, its tests, the record (`status.md`, `whats-done.md`, the D-number if the plan promised one), the CLAUDE.md paragraph; the gate points at the `whats-done.md` entry | 7 (qa, security, legal) | office-organization; project-record (q4); superpowers' `test-driven-development`, `systematic-debugging`, `verification-before-completion`; `supabase-postgres-best-practices` | Supabase read-only, Context7, GitHub read |
| 7 | QA Engineer | Quinn (red) | tester | 7 qa, 8 release | `docs/qa/<slug>.md`: strategy, cases, executed / not run / failed, defects with steps (each a `task add --to finn`), regression, FR-to-test traceability, the readiness recommendation | 6 (defects), the user (release) | office-organization; project-record; `code-review` | Playwright (end-to-end, and the recorded walks stay scripts), GitHub read |
| 8 | Security Reviewer | Sage (red) | author: `docs/security/`; Bash + `pnpm audit` | 7 security | `docs/security/<slug>.md`: findings with severity, files, evidence, impact, remediation, verification, residual; never a secret value | 6 (findings), 5 (before implementation) | office-organization; the built-in `security-review`; `code-review` | Supabase read-only (policies, buckets), GitHub read |
| 9 | Legal Reviewer | Lex (purple) | author: `docs/legal/` | 7 legal | `docs/legal/<slug>.md`: concern, jurisdiction and assumptions, impact, evidence, remediation, questions, the recommendation; RA 10173 and `plan/legal.md` are the starting points | 6 or 2 (a change of behaviour goes back to requirements, organization § 4.5) | office-organization | Context7 (a third-party service's documented terms) |

The engineer is ONE employee (q2 superseded by the organization). The
three domains the first plan split builders by (Postgres, the web app,
the pipeline and its battery) are three sections of the engineer's
charter, each naming the CLAUDE.md rules and traps that bind it.

### 4.2 The gates

| Gate | Owner | Verdicts | Passes when | The next task goes to |
|---|---|---|---|---|
| 1 idea | Idea Strategist | APPROVE / REVISE / RESEARCH / REJECT | APPROVE | 2; REVISE back to the user; RESEARCH a task to whoever can answer (often George); REJECT closes the block |
| 2 requirements | Product Requirements Analyst writes DONE; the user APPROVE (q13) | DONE; APPROVE / REVISE | APPROVE | 3 (a screen) or 5 (none) |
| 3 ux | UX Architect | DONE | DONE | 4 |
| 4 design | Visual Designer | DONE | DONE | 5 |
| 5 architecture | Technical Architect writes SUBMITTED; the user APPROVE (q13); the Security Reviewer may add CONCERNS before | SUBMITTED; APPROVE / REVISE | APPROVE | 6 |
| 6 implementation | Full-Stack Engineer | DONE (with the record entry's heading as `--note`) | DONE, and the file named is the `whats-done.md` entry (`--file whats-done.md` plus the heading) | 7: qa always, security when code touched a route, a policy, a token, a bucket, a secret or an input; legal when guest data, consent, a notice, a third party or a claim is touched (the engineer says which in the hand-off message; George's audit checks the choice) |
| 7 qa / security / legal | QA Engineer / Security Reviewer / Legal Reviewer | PASS / FAIL; CLEAR / FINDINGS:<highest severity>; CLEAR / NEEDS REVISION / PROFESSIONAL REVIEW REQUIRED | qa PASS; security no CRITICAL or HIGH open, or an ACCEPTED line by the user naming the finding; legal CLEAR, or PROFESSIONAL REVIEW REQUIRED recorded as a block with the question | 6 for FAIL or findings; 8 when all pass |
| 8 release | QA Engineer | READY / READY WITH DOCUMENTED RISKS / NOT READY | READY or READY WITH DOCUMENTED RISKS, the risks listed in `docs/qa/<slug>.md` | the user: commit, deploy, `gate <slug> released --by user --note "<commit>"` |

The short lane (Rule 9) is gates 6, 7 (qa) and 8.

### 4.3 The hand-off, in words

Every gate ends the same way: the owner writes its file, runs `gate`,
`task add`s the next owner with `--idea <slug>` and a `why` that names
the file, `msg`s it the two or three things the file does not say (what
was assumed, what is open, what the user said), and `task move`s its own
task done with a note. The next owner's wake reads the inbox and the
board first (Rule 4) and the file second. Nobody is told by chat alone.

---

## 5. Talking to an employee, and employees talking

| Who | How | Lives |
|---|---|---|
| The user → one employee, a whole session | `claude --agent george` (the header shows `@george`; her tools and hook apply) | until the session ends |
| The user → one employee, from any session | `@agent-george what is owed on bookings?` (a subagent call; its answer comes back to this session) | one call; `SendMessage` resumes it |
| An employee → another, durable | `office.mjs msg --to <name> --from <me> "…"`; read on the recipient's next wake (Rule 4) | in git |
| An employee → another, live | agent teams on for the session; employees spawned from their agent files (tools, model and body apply; `skills` and `hooks` from the file do NOT, so the settings mirror is what guards an employee in a team, and the organization skill is read, not preloaded, there) ; `SendMessage` by name | the session |
| An employee → a task for another | `office.mjs task add --to <name> …` (Rule 3) | in git |

Agent teams are experimental (2.1.310): one team per session, not
restored by `/resume`, not available in `-p`, and while the env var is set
a subagent Claude names can silently become a teammate. The plan keeps the
variable **off** by default and on for a meeting (q3). A gate review is a
natural meeting: the engineer, QA, security and legal in one session,
with the verdicts still written by the script.

---

## 6. The toolkit: thirteen plugins, and who holds which

The user named thirteen plugins and asked that the employees use them.
All thirteen are installed at **project scope** (2026-10-27):
`.claude/settings.json` lists them under `enabledPlugins`, so every
session opened in this repo, an employee's included, has them, and a
fresh clone gets them on its first session. Twelve come from
`claude-plugins-official`; `supabase` resolved to
`anthropic-plugin-directory`. What each is, from `claude plugin details`:

| Plugin | What it adds | Always on |
|---|---|---|
| superpowers 7.0.0 | 15 skills: brainstorming, writing-plans, executing-plans, test-driven-development, systematic-debugging, verification-before-completion, requesting- and receiving-code-review, subagent-driven-development, dispatching-parallel-agents, using-git-worktrees, finishing-a-development-branch, writing-skills, using-superpowers, diagnosing-superpowers; a SessionStart hook | ~850 tokens |
| feature-dev | the `feature-dev` workflow skill; three agents: code-explorer, code-architect, code-reviewer | ~240 |
| frontend-design | one skill: distinctive, production-grade interfaces | ~80 |
| code-review | one skill: a multi-agent review with confidence scoring | ~20 |
| code-simplifier 1.0.0 | one agent: simplify recently changed code, behaviour kept | ~70 |
| security-guidance 2.0.16 | four hooks (SessionStart, UserPromptSubmit, PostToolUse on edits and on `git commit`/`push`, Stop): pattern warnings on edits, a model review of the diff when a turn ends | 0 in context; a model call per Stop |
| claude-md-management 1.0.0 | two skills: claude-md-improver (an audit), revise-claude-md (capture a session's learnings) | ~180 |
| skill-creator | one skill: write, test and benchmark a skill | ~110 |
| supabase 0.1.17 | two skills: supabase, supabase-postgres-best-practices; the Supabase MCP server (projects, SQL, auth, storage) | ~640 |
| context7 | the Context7 MCP server: version-specific library docs | 0 |
| github | the GitHub MCP server: issues, PRs, search, the API | 0 |
| playwright | the Playwright MCP server: a browser Claude drives | 0 |
| typescript-lsp 1.0.0 | a TypeScript language server, out of process; needs `typescript-language-server` on PATH (installed, 5.3.0, 2026-10-27) | 0 |

Also on this machine, synced from claude.ai and not one of the thirteen:
**figma** (the Figma MCP server and its skills; "needs authentication"),
which the organization's Visual Designer section asks for "when design
tools are available" (q14).

Observed after the install (2026-10-27): the Playwright server connected;
Context7, GitHub and Supabase answer "needs authentication" (a `/mcp`
login each, the user's hand, Phase 1); security-guidance's hooks run on
Python, and this machine has only the Store stub on `python`, so they do
nothing until one is installed (Phase 1).

### 6.1 George holds none of them, by construction

George's `tools:` list is explicit (§ 3.1): no `Skill`, no `mcp__*`. So
no plugin skill can fire in her session and no MCP server exists for her,
by the same mechanism that keeps her off `pnpm`, not by a second rule.
What she gets from the plugins is what runs AROUND a session: superpowers'
SessionStart line and security-guidance's hooks. **Observed (Phase 2):**
the init event, 7 tools and 0 MCP as George, 99 and 65 in a plain
session; "no Skill tool", "no MCP tool" when asked. The seven authors
are built the same way: an explicit `tools:` line that names the MCP
tools of § 4.1 and nothing else.

### 6.2 Who holds which

| Plugin | Role(s) | How |
|---|---|---|
| superpowers | Idea Strategist (`brainstorming`); Technical Architect (`writing-plans`, the house shape winning); Full-Stack Engineer (`test-driven-development`, `systematic-debugging`, `verification-before-completion`, `executing-plans`, `subagent-driven-development` on call) | `skills:` preloads as § 4.1 says; the rest on call through `Skill` for the engineer and QA, who have it |
| feature-dev | Technical Architect (`code-architect`, `code-explorer` agents); Full-Stack Engineer (`feature-dev` skill, `code-explorer`) | on call; an author with `Agent` in its tools may dispatch the explorer (read-only agents) |
| frontend-design | Visual Designer | preloaded; `tokens.css` decides (§ 6.3) |
| code-review | QA Engineer, Security Reviewer | preloaded; findings become tasks on the engineer's board, never fixes |
| code-simplifier | Full-Stack Engineer (after a review says so), QA Engineer (may run it as the reviewer's second opinion) | on call |
| security-guidance | everyone, around every session; the Security Reviewer reads its commit-time review when the user commits | hooks |
| claude-md-management | Full-Stack Engineer (`revise-claude-md` for ITS paragraph, the doer writes); the user (`claude-md-improver` when George's audit says CLAUDE.md drifted) | on call |
| skill-creator | the hiring step (Phase 5: `office-organization`, `project-record`; any employee's own skill later) | the user's or Claude's plain session |
| supabase | Technical Architect, Full-Stack Engineer (`supabase-postgres-best-practices` preloaded); Architect, Engineer, Security Reviewer (the MCP, read-only, q9) | `skills:`; `tools:` names the read tools |
| context7 | Idea Strategist, Technical Architect, Full-Stack Engineer, Legal Reviewer | `tools:` |
| github | Idea Strategist, Full-Stack Engineer, QA Engineer, Security Reviewer: READ tools (q10) | `tools:` |
| playwright | UX Architect, Visual Designer (to look), QA Engineer (end to end) | `tools:`; the recorded walks stay CDP scripts |
| typescript-lsp | Full-Stack Engineer, QA Engineer | out of process; no line in a file |
| figma (synced) | Visual Designer, when the user logs in (q14) | `tools:` then |

### 6.3 Where a plugin has its own rules, the house rules win

- **A plan is in the house shape** (§ 0 rules, traps, phases, questions
  with recommendations), not superpowers' `writing-plans` shape;
  `brainstorming` before one is welcome.
- **A branch is finished by the user** (Rule 8): `finishing-a-development-branch`
  and `using-git-worktrees` are preloaded into nobody, and the builder's
  and the tester's guards refuse the commit and the merge they end with.
- **A walk is a script in `plan/`** (`ui-refresh-cdp.mjs`, raw CDP on
  Chrome, screenshots recorded): the Playwright MCP is for looking at a
  page, or for QA's exploratory pass, never the record of a check.
- **A schema change is a file in `packages/db/sql/`**, applied as today
  and guarded for re-runs (traps 20 and 25): the Supabase MCP never
  applies a migration the repo does not hold, and is configured
  read-only (q9).
- **Styles are the tokens** (D-101): `frontend-design` informs the
  shape; `tokens.css` decides every colour and size, a design file speaks
  in its terms, and `ui-refresh-a11y.mjs` stays at 0.
- **A review is words on the board**: `/code-review`'s findings go to the
  engineer as tasks with the idea's slug; the reviewer never fixes.
- **A requirement is the analyst's** (organization § 4.5, § 4.6): a
  plugin's suggestion that changes behaviour is a message to the
  Product Requirements Analyst, not an edit.

---

## 7. Traps

### 7.1 `Write(path)` never matches, and `memory:` opens the door

A permissions rule `Write(office/**)` would allow nothing and deny
nothing: the docs say `Write`, `NotebookEdit` and `Glob` path rules never
match. The guard is the hook (Rule 1). `memory: project` on an employee
would grant Write and Edit by itself; it is not used.

### 7.2 The hook's identity field, observed

`agent_type` / `agent_id` are "present when the hook fires inside a
subagent or when the session uses `--agent`". A guard that reads a field
that is absent is a guard that passes everything. **Observed, Phase 0:**
`agent_type` present and equal to the agent's name under `--agent` (with
`CLAUDE_CODE_AGENT` in the hook's environment too), as a subagent
(`agent_id` beside it) and in print mode with the teams variable set;
absent in a plain session. The hook's command ran under Git Bash from
PowerShell too. An interactive teammate is owed to the user's hand (teams
do not run in `-p`); Phase 4 reads its log line.

### 7.3 The record is too big to read whole

`whats-done.md` is 10,000 lines. A `Read` of it is most of a context
window, and George would do it every wake. Hence the digests, the
watermark and "by heading and offset" in the charter; Phase 3 measures a
wake in tokens and seconds and records it.

### 7.4 Team state is not the office

`~/.claude/teams/` is deleted at session end; `~/.claude/tasks/` outlives
it but lives outside the repo and the office. A task "assigned" there and
nowhere else is lost (Rule 3). The TaskCreated hook can enforce it later
(a task created in a team must name a `T-` id); Phase 4 decides.

### 7.5 Windows

The hook runs `node office/hooks/guard.mjs`. **Observed, Phase 0:** the
command ran under Git Bash whichever shell the user had, so no `shell:
powershell` line is needed for a `node` hook. Paths in the hook input are
forward-slash on this machine; the path test normalises both.

### 7.6 A charter that drifts from the record

George's "what she must know" (§ 3.3) is a snapshot of 2026-10-27 and will
be wrong by November. The charter names the FILES, not the facts; the
facts live in her digests, rebuilt from the record (Rule 2). The one list
in the agent file is the list of record files. The nine's charters have
the same shape: the organization's words (which do not drift) and the
house's pointers (file names, rule numbers), never a fact about today.

### 7.7 An employee that commits

Rule 8 is a rule in a prompt for the engineer and QA (they need `git` and
`pnpm`). Their guard refuses `git commit|push|merge|rebase|reset|checkout|
stash|branch -D`, `gh pr create|merge` and `vercel` (Rule 11): a
denylist, the weaker wall, so Rule 8 stays in the charter beside it, and
George's audit reads `git status` after a task.

### 7.8 A plugin is a dependency with hooks

The thirteen came from a marketplace and update from it; a version bump
can change a hook. Three facts to carry: security-guidance's SessionStart
hook installs the Agent SDK with `pip` and needs a Python this machine
lacks (the Store stub answers `python`); `typescript-lsp` needs the global
binary (in, 5.3.0); Context7, GitHub and Supabase need a `/mcp` login
that lives in the user's config, not the repo, so a fresh clone has the
plugins and not the logins. And two of superpowers' skills end in a
commit or a merge (§ 6.3): an employee that reaches them meets its guard.
`office.mjs check` asserts that `enabledPlugins` still holds the thirteen,
so a plugin removed by hand is a kit a charter still names, caught.

### 7.9 "Implemented" is never a document

The organization says it ("Never claim a feature is implemented merely
because it is documented or planned"), and the office's shape invites the
mistake: by gate 5 an idea has four polished files and a plan, and reads
as done. Rule 10's ladder is derived from the gates, Implemented is the
engineer's gate pointing at a `whats-done.md` entry, and George reports
from `pipeline`, never from `docs/`.

### 7.10 A gate skipped by a message

"Finn, the requirements are obvious, just build it" is the sentence Rule
9 exists for. `gate` refuses a gate whose predecessor has no passing
verdict; the user may `--override`, and the override is a line on the
block with the user's name, so a skipped gate is a recorded decision, not
a habit. The engineer's charter says to refuse a task whose idea is not
at Approved-with-architecture, and to say so in one line.

### 7.11 Ten agents cost every session a little

Every agent's `description` is listed for the Agent tool in every session
of this repo, ten of them: a few hundred tokens, always. Keep each
description to two sentences (the plan's § 4.1 cells are the drafts).
The charters themselves cost nothing until an agent runs. The
`office-organization` skill is preloaded by the employees only (`skills:`),
not auto-loaded by plain sessions, which is why it is a skill and not a
CLAUDE.md section (the user's recommendation, read the house's way).

### 7.12 The builder's guard is a denylist

Rule 11 says it and § 7.7 repeats it: an engineer who runs anything cannot
be allowlisted, so the guard names the user's hand and refuses that. What
it does not name (an `rm -rf`, a `curl` to the world) is what CLAUDE.md,
the charter and the review gates are for. The author kinds and George are
allowlisted and stay so; a role that needs one more command gets it in
its profile's `bash` list, read back by `check`, not in the hook.

### 7.13 `docs/` is not a second record

Seven folders of well-written files will tempt a reader to treat them as
the truth about the product. They are the truth about what was ASKED and
DESIGNED, by whom, when; what was BUILT is `whats-done.md`, what was
DECIDED `decisions.md`, what is NEXT `status.md` (Rule 2). George's
`project-map.md` points from a feature to both, and a requirements file
that the build departed from is amended by the analyst on the engineer's
message (organization § 4.3), never silently.

---

## 8. Phases

### Phase 0 — The spike: who is calling the hook
**Done 2026-10-27** ([`phase0.md`](./ai-employees/phase0.md), the log and
the hook beside it); the interactive teammate run is owed to the user's
hand, in Phase 4. A throwaway agent `probe` with a `PreToolUse` hook on
`Bash` that appends the whole stdin JSON to a log; the same hook in
`.claude/settings.json`; `echo hi` five ways (plain, `--agent`,
`@agent-`, the teams variable in `-p`, PowerShell). Observed: both copies
fire under `--agent` and for a subagent; `agent_type` is the field.

### Phase 1 — The office
**Done 2026-10-27:** `office/office.mjs` (hire, task, msg, inbox, index,
check), `office.test.mjs` 15/15, `office/README.md`, `pnpm office:check`
and `pnpm office:test`. Owed, the user's hand: Python, the three `/mcp`
logins; then `claude mcp list` read back with all four plugin servers
connected.

### Phase 2 — George
**Done 2026-10-27** ([`phase2.md`](./ai-employees/phase2.md)): hired
(blue, she/her, read-only); the charter (§ 3.2 items 1–7); the guard in
her frontmatter and mirrored in settings; every refusal read back from
the hook itself (a forced Write to `apps/`, a forced Edit of `status.md`,
`git commit`, `pnpm test`), the allowed calls allowed (a Write under
`office/`, `git log -1`, `office.mjs check`); the plugin wall read from
the init event (99 tools and 65 MCP in a plain session, 7 and 0 as
George). `office.mjs index` on the real record: 142 decisions, 52 open
risks of 57.

### Phase 3 — George's first day
**Done 2026-10-27** ([`phase3.md`](./ai-employees/phase3.md)): the first day 335 s, 4.73 USD, 55 turns, four digests (465 lines) every fact cited; a quiet second wake 28 s, 1.18 USD, 14 turns, nothing amended; the ten questions answered in ONE turn (76 s, 2.21 USD) because the shell fed them all at once (the trap is in phase3.md), each with its source; the Stop review not measurable without Python. The answers are the user's to grade.
In `claude --agent george`: the digests built (§ 3.3), `index` run, the
watermark set, the first brief written. Measured and recorded: the tokens
and seconds of the build, and of a SECOND wake with nothing changed in the
record (the wake must be cheap; § 7.3); the cost of security-guidance's
Stop review on that session (Rule 7). Then the user's ten questions, the
answers judged by the user against the record: "what is this project",
"what did we do yesterday", "what should we do now", "what is owed",
"why do customers book on a page and not in the chat" (D-069), "which
tenants exist and what cannot run", "what is the price function" (one:
`unit_quote()`), "who may read sources" (D-140), "what is trap 8", "what
would you have the next employee do first". Each answer must cite where it
came from; an uncited answer is a failed question. Her charter gains
items 8–10 of § 3.2 at the start of this phase (intake, the ladder, the
organization's memory), so the first day is lived under the organization.

### Phase 4 — Talking
**Half done 2026-10-27** (`plan/ai-employees/phase4/mention.json`): `@agent-george` from a plain print-mode session answered trap 8 with its source and, forced, had its Write to `apps/phase4.md` refused by the hook with its own sentence (2 turns, 52 s, 1.86 USD); she also found that trap 8 has no `risks.md` entry though CLAUDE.md says every trap is expanded there. The interactive agent-teams session is the user's hand and stays owed.
`@agent-george` from a plain session (one question, one answer, the hook
still guarding: a logging line proves it fired). Agent teams on for ONE
interactive session, the user's hand: George and a `probe` teammate;
George assigns a task through the script, messages it live, the probe
acknowledges in the inbox; the session ends; the board and the inbox hold
it; the team's own task list is inspected and the difference recorded
(§ 7.4); the hook's log line for the teammate read (§ 7.2). The variable
off again.

### Phase 5 — The guards by profile, the pipeline, the two skills
**Done 2026-10-27:** `guard.mjs` judges from the profile's `guard` object (kind, `writes`, `writeGlobs`, `bash` allow or deny with its list); a board, an inbox, the pipeline and the sequence refused for every kind, another employee's folder too; `hire --role --guard --tools --skills`; `idea add`, `gate`, `pipeline` with the derived ladder, the owner and verdict tables, the predecessor rule and the user's `--override`, the `--file` existence check; `task add --idea`; `organization` and the `office-organization` skill (196 lines, verbatim, diffed by `check`); `project-record` written by hand from CLAUDE.md's text (the skill-creator plugin's eval step skipped); George migrated (role, guard object, the preload). `office.test.mjs` 19/19, every row of Rule 11 pinned; `check` green.
Code first, nobody hired yet. `guard.mjs` reads `profile.json`'s `guard`
(kind, `writes`, `bash`) and judges by it (Rule 11); a direct Edit of a
board or an inbox refused for every kind; the builder's and tester's
denylists; `hire --guard read-only|author:<area>|tester|builder` writes
the kind's table; `office.test.mjs` pins every row of Rule 11's table
with a call per kind (the Technical Architect's `plan/` and
`decisions.md`; the Security Reviewer's `pnpm audit`; QA's `*.test.ts`
yes and `apps/web/lib/x.ts` no; the engineer's `git commit` no and
`pnpm test` yes). `idea`, `gate` and `pipeline` (Rule 10: the block
shape, the derived status, the owner and verdict tables of § 4.2, the
predecessor rule and `--override`, the `--file` existence check); `task
add --idea`; `check` extended (the gate files, the skill preloads, the
`tools:` of authors). `organization`: the copy step of Rule 12, and
`.claude/skills/office-organization/SKILL.md` written by it (the shared
sections, verbatim, with a three-line frontmatter); `check` diffs the
skill against the source. `project-record` written with `skill-creator`
from CLAUDE.md's "Keeping the record" and the whats-done entry shape
(q4). George's agent file gains `skills: office-organization`. Tests,
`pnpm office:check`, `pnpm office:test`; the web build and `pnpm
typecheck` unchanged.

### Phase 6 — The nine hired
q11's names. For each: `hire <name> "<title>" --guard <kind> --colour
<c> --pronouns <p>`; `organization` copies its section in; the house
additions written under "## What the house adds" (its deliverable path,
the gate it owns and the verdicts, whom it hands to and how (§ 4.3), the
CLAUDE.md rules and traps by number that bind it, the plugins it holds
and the house rule that wins (§ 6.3), what it refuses and says in one
line); the `tools:` line (authors: `Read, Grep, Glob, Bash, Edit, Write,
SendMessage` plus the MCP tools of § 4.1 by name; the engineer and QA:
no `tools:` line, so every tool, with `Skill`); `skills:` as § 4.1. Then
one refusal and one allowed call per employee as `claude --agent
<name> -p`, read back from the hook (an author writing outside its
folder; QA editing `apps/web/lib/x.ts`; the engineer's `git commit`); the
init event per employee (the authors' MCP tools are exactly § 4.1's).
`office/README.md`'s roster; `check` green with ten employees.

### Phase 7 — One idea through every gate, and one owed item through the short lane
The proof. q12 picks the idea (recommended: Google Analytics on the
public pages, from `todo.md`: small to build, and it touches legal
(consent, RA 10173, the privacy text), security (a third-party script on
a public page), UX (a notice) and design (where it sits), so every gate
has something real to say). The user gives it to George; George `idea
add`s it and tasks the Idea Strategist; each gate runs in its owner's
session (`claude --agent <name>`), the user approving requirements and
architecture (q13); the engineer builds on a branch; QA, security and
legal review; QA says READY or not; the user commits, deploys and marks
it released. Recorded per gate: the file, the verdict, the tokens and
minutes of the session, what the next owner had to ask that the file did
not say (the measure of "make the next employee's work easier"). Then
the short lane on the platform form's free-guest field on screen (owed
since 2026-10-26): George → the engineer → QA → the user, in a day.
Phase 7's findings amend § 4.2 and § 4.3.

### Phase 8 — The record, and the office page (optional)
D-152 in `decisions.md` (the office; D-151 went to analytics, 2026-10-28; the hook, not the prompt; digests,
not a second record; files, not a service; the gates and the ladder; the
organization as a skill, not a CLAUDE.md section); a paragraph in
`CLAUDE.md` under the dated list (how to talk to an employee, Rules 1, 2,
3, 8, 9 in three lines, "a new employee is `office.mjs hire`", "an idea
starts with George"); `status.md` and `whats-done.md`. Optional:
`office.mjs page` writes `office/office.html`, one static page,
everything inlined (the roster with avatars and titles, every board,
every inbox, the pipeline with its ladder, George's latest brief), no
script that fetches, opened from disk; the tokens and the
no-literal-colour rule do not apply (it is not the app), but it draws the
same eight colours.

---

## 9. Questions, each with a recommendation

q1–q10 were answered 2026-10-27 ("proceed with your recommendations");
q2 is superseded by the organization and kept for the record.

1. **Where George's knowledge lives.** (a) Digests under `office/` with a
   watermark, rebuilt from the record on wake (Rule 2); (b) the record
   read every time (10,000 lines per wake, § 7.3); (c) a vector index of
   the record through the product's own pipeline (a dependency on the
   product, OpenAI spend per wake, and a tenant for the project, against
   Rule 6 and Rule 7). **Recommended and taken: (a).**
2. **The roster after George.** *(Superseded 2026-10-27 by the
   organization: ONE Full-Stack Engineer, and the eight other roles of
   § 4. The three domains this question split builders by are three
   sections of the engineer's charter.)* It had recommended three
   builders (Postgres, web, pipeline) and a reviewer.
3. **Agent teams on by default?** **Recommended and taken: off**, set per
   session for a meeting; the inbox is the channel that always works.
4. **A skill for the record's conventions?** **Recommended and taken:
   yes**, `project-record`, in Phase 5, written from CLAUDE.md's text, not
   a second wording of it; the engineer and QA preload it.
5. **Should George write the record?** **Recommended and taken: no**: the
   doer writes, George audits, and George's briefs are her documents.
6. **Commit the office, boards and briefs included?** **Recommended and
   taken: yes**, all of `office/`, `docs/` and `.claude/agents/` and
   `.claude/skills/`; `.claude/settings.local.json` stays ignored.
7. **The model per employee.** **Recommended and taken: `inherit` for
   all** until Phase 3's numbers say a cheaper model answers the ten
   questions as well.
8. **May George draft a plan?** **Recommended and taken:** drafts under
   `office/employees/george/drafts/`, in the house shape, moved into
   `plan/` by the user or the Technical Architect; the hook unchanged.
9. **The Supabase MCP's reach.** **Recommended and taken:** configured
   read-only and scoped to the one project at the login, held by the
   Technical Architect, the Full-Stack Engineer and the Security Reviewer
   for `explain`, counts and reading a policy back; every write stays a
   file.
10. **The GitHub MCP and Rule 8.** **Recommended and taken:** READ tools
    only, named in the agent files; the user opens the PR; no mirror of
    the board into issues.
11. **The nine's names and pronouns.** The user named George; the
    organization names titles. **Recommend** Ivy (Idea Strategist), Rhea
    (Product Requirements Analyst), Uma (UX Architect), Vera (Visual
    Designer), Theo (Technical Architect), Finn (Full-Stack Engineer),
    Quinn (QA Engineer), Sage (Security Reviewer), Lex (Legal Reviewer):
    short, distinct first letters where the title's first letter allows,
    one per role, `they/them` unless the user says otherwise. Any name
    the user prefers replaces a row; the agent file's `name:` is
    lowercase.
12. **The first idea for Phase 7, and the short-lane item.**
    **Recommend** Google Analytics on the public pages (`todo.md`'s own
    line; every gate has real work, and the legal gate meets the
    privacy text and the DPA groundwork of D-129–D-131 head on), and the
    platform form's free-guest field on screen for the short lane (owed
    since 2026-10-26, one screen, no money). A larger candidate,
    Facebook Messenger (`todo.md`), is a second full run once the first
    has amended § 4.2.
13. **Who approves a gate the organization calls "submit for review"?**
    Requirements (gate 2) and architecture (gate 5) are submitted; the
    organization's owner of decisions is "the project owner" (§ 4.10).
    **Recommend the user**, with one command each (`gate <slug>
    requirements --by user --verdict APPROVE`), George recommending in
    a message beforehand; REVISE sends it back with the reason as the
    note. Not George: she advises, she does not decide (q5's reasoning).
14. **Figma.** The Visual Designer's section asks for real designs "when
    design tools are available"; the figma plugin is synced from
    claude.ai and needs a login; the house's design system is
    `tokens.css`, not a Figma library. **Recommend** specs in
    `docs/design/` first (tokens in `tokens.css`'s terms, inline SVG for a
    layout), and the Figma tools named in Vera's `tools:` the day the
    user logs in, with `figma-generate-library` building the library FROM
    `tokens.css` (the figma plugin's own skill), never the other way.
15. **`docs/decisions/`.** The user's recommended structure has it; the
    house has `decisions.md` with 150 numbered decisions and
    `office.mjs index` over its headings. **Recommend no folder**: a
    decision made at a gate is a D-number written by the Technical
    Architect or the engineer in `decisions.md` (Rule 2), and the
    product-level decision of gate 1 (APPROVE / REJECT) lives on the
    pipeline and in `docs/product/<slug>.md`.
16. **One engineer, or the engineer may split work to subagents?**
    superpowers' `subagent-driven-development` dispatches subagents for
    parallel pieces; a subagent of the engineer inherits its tools and
    runs under the same guard (Phase 0: `agent_type` is the name of the
    agent file, so a generic subagent is NOT guarded as the engineer).
    **Recommend** the engineer may dispatch `feature-dev`'s read-only
    explorers and nothing that writes; parallel building waits until
    a second engineer is hired, with its own file and guard.
