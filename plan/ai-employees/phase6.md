# AI employees, Phase 6: the nine hired

2026-10-27 (the runs) and 2026-10-28 (the preload check, the fixes).
Claude Code 2.1.310, against `e1a41db`, nothing committed.

## The hires

Ivy (Idea Strategist), Rhea (Product Requirements Analyst), Uma (UX
Architect), Vera (Visual Designer), Theo (Technical Architect), Finn
(Full-Stack Engineer), Quinn (QA Engineer), Sage (Security Reviewer),
Lex (Legal Reviewer): `office.mjs hire … --role --guard --tools
--skills`, each charter the organization's section verbatim plus "What
the house adds"; the roster in `office/README.md`. `office.mjs check`: 10
employees, 13 plugins, green.

## One refusal and one allowed call each (`claude --agent <name> -p`, stream-json in `phase6/`)

| Employee | Refused by the hook | Allowed | USD | s |
|---|---|---|---|---|
| ivy, rhea, uma, vera, sage, lex | Write `apps/web/phase6-<name>.md`: "<name> (author:<area>) writes under office/, docs/<area>/ only (… Rule 11)" | n/a | 0.86–0.87 | 7–10 |
| theo | the same: "writes under office/, plan/, decisions.md, risks.md only" | n/a | 0.87 | 8 |
| quinn | Write `apps/web/lib/phase6.ts`: "(tester) writes under office/, docs/qa/ and test files only" | Write `apps/web/lib/phase6.test.ts` (then removed) | 1.53 | 10 |
| finn | `git commit --allow-empty -m phase6`: "the user's hand, not finn's (Rule 8)" | `git status --short \| head -3` | 1.22 | 13 |

Nine runs, 9.80 USD in all. Each refusal's text is the guard's own
sentence, read from the tool result, not the model's summary.

## The init event

Ivy's (`phase6/ivy.jsonl`, the `system/init` line): tools `Read, Grep,
Glob, Bash, Edit, Write, SendMessage`, exactly her `tools:` line, no
`Skill`. `mcp__plugin_context7_context7` is in her frontmatter and NOT
in the init: Context7 is unauthenticated (the user's `/mcp` login), so an
author's MCP tools are § 4.1's minus the logins still owed.

## Finding: `skills:` preloads into a subagent, not into `--agent`

Each run was also asked whether `office-organization` was preloaded. The
answers disagreed with each other (eight said no; Quinn said it and
`project-record` were). A model's report of its own context is not
evidence (phase2.md, the same lesson about tools), so on 2026-10-28 one
question with a checkable answer, no tools allowed: "quote verbatim the
sentence that begins 'Your goal is to transform', or say NOT LOADED"
(`phase6b/`):

| How Ivy was reached | Answer | USD |
|---|---|---|
| `claude --agent ivy -p …` | `NOT LOADED` | 0.38 |
| `claude -p "@agent-ivy …"` (a subagent) | the sentence, verbatim | 0.70 |

The init event lists `office-organization` among the AVAILABLE skills
under `--agent`; available is not loaded, and with no `Skill` tool an
author could not load it either. So every `--agent` session, which is
how the user talks to an employee (§ 5) and how Phase 7's runner ran
them, worked without the organization's text.

**The fix, in the one writer:** `ORG_READ_LINE` in `office/office.mjs`,
the first line under every charter's heading: "Before anything else: if
the text of the office-organization skill is not in your context (a
`claude --agent` session does not preload `skills:`; a subagent does),
Read `.claude/skills/office-organization/SKILL.md` whole, first." A hire
writes it, `check` reports a charter without it, and the ten existing
charters got it. The `skills:` line stays: it is what a subagent gets.

## George's two findings from the Phase 7 intake, fixed

1. **The guard refused `;` and `&&` inside a quoted message.**
   `guard.mjs`'s new `mask()` masks quoted text (same length) before the
   checks: inside `'…'` everything, inside `"…"` everything but `$`,
   `(` and a backtick, which still run there. An unclosed quote is
   refused. The pipe split cuts the original at the masked text's pipes.
2. **Her charter's audit listed five checks; plan § 3.2 item 6 has six**
   (the pipeline first). Her charter § 6 now has six, the pipeline first.

## Observed after the fixes

`node --test office/office.test.mjs`: 20/20 (19 before; new: quoted
text is a word, nine cases, including `"$(rm y)"`, a backtick inside
double quotes and an unclosed quote still refused; and the read line
born with a hire, its absence caught by `check`). `office.mjs check`:
consistent, 10 employees, 13 plugins, 2 ideas.

## Owed

Phase 7 rerun from Ivy's gate (her first run, and Rhea's, Finn's and
Quinn's, ended at once on the session limit, `phase7/*.jsonl`, nothing
written); the user's `/mcp` logins (Context7 for the authors).
