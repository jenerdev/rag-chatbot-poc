# Office app, Phase 5: one real day

2026-10-28, Claude Code 2.1.312, `phase5.mjs`. The server ran in-process
on a temporary COPY of the office, agents, skills, settings and guard
hook, with the real `claude` and a 0.5 USD cap. Summary in
`phase5/summary.json`, output in `phase5.log`.

## Run 1 (`phase5-run1-crlf.log`): 5/8, a real finding

George's two turns passed. Ivy, Theo and Finn each ended with no
`result`. Reproduced by hand with the server's exact arguments:
`--agent 'ivy' not found. Available agents: … george, … rhea, … uma`.

- **The cause:** the worktree's checkout (`core.autocrlf=true`) gave every
  file CRLF endings, and Claude Code silently drops an agent whose
  frontmatter `description` holds `": "`. That is seven of the ten; George,
  Rhea and Uma have none.
- **The proof:** Ivy's file converted to LF answered at once (0.31 USD).
- **Not only this worktree:** any fresh Windows clone with autocrlf would
  have lost seven employees.
- **Fixed:**
  - `.gitattributes`: `eol=lf` for `.claude/agents`, `.claude/skills`,
    `office/` and the organization file.
  - `check`: names a CRLF agent file.
  - `readText()`: reads CRLF as LF, for the verbatim comparisons (Phase 1).

## Run 2 (`phase5.log`): 8/8

| Check | Observed |
|---|---|
| George answers, cost = `result.total_cost_usd`, indexed | 0.3245 USD, 5 s; `sessions.json` usd equal |
| A second turn resumes the SAME session | same id, turns 2, "You asked about this office's purpose." (0.3469) |
| The cap: 402 first, then `overCap` | 402 at 0.67 spent of 0.5; Ivy then answered (0.3010) |
| A refusal forced on Theo | `PreToolUse:Write hook error: … theo (author:architecture) writes under office/, plan/, decisions.md, risks.md only`; desk state `refused`; no file written (0.3235) |
| Stop during a Bash call | 5 processes carried the run's marker before Stop, 0 after (taskkill /T /F) |
| A past chat reads back from Claude Code's transcript | 4 messages from `~/.claude/projects/…/<id>.jsonl` |
| The terminal continues the page's chat | `claude --agent george --resume <id> -p …` returned the same `session_id` and quoted the first question (0.3659) |
| Nothing under `apps/` or `packages/` changed | `git status --porcelain -- apps packages` equal before and after |

Spent through the page in run 2: 1.30 USD, plus 0.37 for the terminal turn.
