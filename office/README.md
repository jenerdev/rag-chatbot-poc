# The office

The AI employees who develop this repository ([`plan/ai-employees.md`](../plan/ai-employees.md)).
Each one is an agent file in [`.claude/agents/`](../.claude/agents/) (what
Claude Code reads: tools, model, colour, hooks, the charter) and a folder
under `employees/` (what people read: the profile, the avatar, the task
board, the inbox, the notes). `office.mjs` is the only thing that writes a
board or an inbox.

## Who works here

| | Name | Title | Guard | Since |
|---|---|---|---|---|
| ![finn](employees/finn/avatar.svg) | Finn | Full-Stack Engineer | builder: everything but a board, an inbox and the user's hand (commit, push, merge, deploy) | 2026-10-27 |
| ![george](employees/george/avatar.svg) | George | Project Intelligence | read-only: writes under `office/` only; read-only git and the script; no plugin skill, no MCP server | 2026-10-27 |
| ![ivy](employees/ivy/avatar.svg) | Ivy | Idea Strategist | author: `docs/product/` and the office; read-only git | 2026-10-27 |
| ![lex](employees/lex/avatar.svg) | Lex | Legal Reviewer | author: `docs/legal/` and the office; read-only git | 2026-10-27 |
| ![quinn](employees/quinn/avatar.svg) | Quinn | QA Engineer | tester: test files and `docs/qa/`; every command but the user's hand | 2026-10-27 |
| ![rhea](employees/rhea/avatar.svg) | Rhea | Product Requirements Analyst | author: `docs/requirements/` and the office; read-only git | 2026-10-27 |
| ![sage](employees/sage/avatar.svg) | Sage | Security Reviewer | author: `docs/security/` and the office; read-only git and `pnpm audit` | 2026-10-27 |
| ![theo](employees/theo/avatar.svg) | Theo | Technical Architect | author: `docs/architecture/` (as `plan/`, `decisions.md`, `risks.md`) and the office; read-only git | 2026-10-27 |
| ![todd](employees/todd/avatar.svg) | Todd | Task Tracker | read-only: changes no file; read-only git and the script; lists what is pending, who owns it, what is next | 2026-10-28 |
| ![uma](employees/uma/avatar.svg) | Uma | UX Architect | author: `docs/ux/` and the office; read-only git | 2026-10-27 |
| ![vera](employees/vera/avatar.svg) | Vera | Visual Designer | author: `docs/design/` and the office; read-only git | 2026-10-27 |

A new employee is `node office/office.mjs hire <name> "<title>" --role <role> --guard <kind>`; the hire is born with the organization's section for its role in its charter (`plan/ai-employees/organization.md`, the user's words verbatim), and the house additions are written under "What the house adds". George is the tenth: she knows the project and routes an idea to the right gate.

## George is the office's memory

Every employee reports to George, and she saves it to memory (the user,
2026-10-28). The feed is `employees/george/reports.md`, written by the
script alone:

- **By itself:** every task added, started, finished or dropped, every
  idea and every gate, as it happens.
- **By the doer:** `node office/office.mjs report --from <me> "T-0xx: what I did; files; numbers; owed"`
  at the end of a task and after a gate. Every charter but George's
  carries that line, and `check` says whose does not.

On every wake George reads `reports`, saves each one in
`employees/george/notes/work-log.md` (and amends `owed.md` and
`project-map.md` when one changes them), then `reports --ack-all`. Ask
her what anyone did, and when.

## Talking to an employee

- A whole session as one: `claude --agent george`.
- One question from any session: `@agent-george what is owed on bookings?`
- Employee to employee, durable: `node office/office.mjs msg --to <name> --from <me> "…"`; every employee reads its inbox and its board first on every wake.
- Employee to employee, live: agent teams, switched on for a session with `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`; a decision reached live is written to a board or an inbox before the session ends, or it did not happen.
- **In a browser: `pnpm office`** ([`plan/office-app.md`](../plan/office-app.md), D-153). It prints `http://127.0.0.1:4600/?token=…`; open that. The floor is five rooms (Product, Design studio, Engineering, Front office, Review), each employee at a desk. A click opens their Chat, Board and Inbox.
  - **A chat is a real `claude --agent <name>` session.** `claude --resume <id>` in a terminal continues it.
  - **The board and the inbox are these files**, written through `office.mjs`.
  - **The top bar shows today's spend** against `OFFICE_DAILY_USD` (default 10), and the page asks before a turn that goes over it.
  - **One builder-or-tester turn runs at a time**; a second is queued.
  - **Local only:** 127.0.0.1, a token, Origin and Host checked. Never deploy it.
  - `OFFICE_PORT` picks the port. `node --test office/app/*.test.mjs` runs its tests, and `plan/office-app-walk.mjs` is its browser walk; both use a fake `claude` and spend nothing.

## The script

```
node office/office.mjs hire <name> "<title>" [--colour c] [--model m] [--pronouns p] [--guard read-only|builder]
node office/office.mjs task add --to <name> --from <who> "<title>" --why "<why>" [--doing]
node office/office.mjs task move <T-id> doing|done|dropped [--note "<note>"]
node office/office.mjs task list [<name>] [--all] [--json]
node office/office.mjs msg --to <name> --from <who> "<text>"
node office/office.mjs inbox <name> [--ack <M-id> | --ack-all]
node office/office.mjs report --from <me> "<what I did; files; numbers; owed>"   to George
node office/office.mjs reports [--all | --ack-all]   George's feed: unread, all, or tick them
node office/office.mjs index [<name>]      George's mechanical digests: every decision, the open risks, the watermark
node office/office.mjs check               the audit: exit 1 on any mismatch
pnpm office:check · pnpm office:test       the same check, and node --test
```

`from` and `to` are an employee's name or `user`; an unknown name is an
error, never a new employee. Ids (`T-001`, `M-001`) are one sequence for
the whole office (`sequence.json`). A task is `done` or `dropped` with a
note.

## The rules, in a paragraph

George never changes code, and a hook says so (`hooks/guard.mjs`, in her
agent file and mirrored in `.claude/settings.json`): writes under `office/`
only, read-only git and this script only. The record (`status.md`,
`whats-done.md`, `decisions.md`, `risks.md`, `plan/*.md`) stays the one
source of truth; George keeps digests of it with a watermark, and the
employee who does a step writes the record, George audits. A task exists
only on a board file, in git; the session's own task list is a mirror.
Every employee is one agent file and one folder, and `check` proves they
agree. The office is files and this one zero-dependency script. An
employee spends nothing it was not asked to spend. Employees never commit,
merge, push or deploy: that is the user's hand.
