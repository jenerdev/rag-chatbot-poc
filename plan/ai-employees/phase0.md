# Phase 0 — who is calling the hook (2026-10-27)

The spike of [`plan/ai-employees.md`](../ai-employees.md) § 8 Phase 0, run on
Claude Code 2.1.310, Windows 11, against `34c7df7`. A throwaway agent
`probe` (`tools: Bash`, a `PreToolUse` hook on `Bash` in its frontmatter
running `phase0-hook.mjs frontmatter`) and the same hook in
`.claude/settings.json` running `phase0-hook.mjs settings`. Each run asked
for one `echo`. The hook appended one JSON line per firing to `phase0.log`
(kept beside this file, 11 lines: the eight below, two from the session
that ran the spike, one PowerShell). `probe.md` and the settings hook were
removed afterwards; `phase0-hook.mjs` stays as the record of what was run.

## Observed

| Run (print mode, `-p`) | Hooks that fired | `agent_type` | `agent_id` | `CLAUDE_CODE_AGENT` in the hook's env |
|---|---|---|---|---|
| a plain session, `echo phase0-plain` | settings only | absent (null) | absent | unset |
| `claude --agent probe`, `echo phase0-agent` | **both**, settings then frontmatter, same instant | `probe` | absent | `probe` |
| `@agent-probe` from a plain session, `echo phase0-mention` | **both** | `probe` | `aee40b940d0036d37` | unset |
| `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`, "spawn a teammate from probe", `echo phase0-team` | **both** | `probe` | `a5e6fa2751e170abd` | unset |
| `claude --agent probe` from PowerShell, `echo phase0-ps` | **both** | `probe` | absent | `probe` |

Every firing carried the same keys: `session_id`, `transcript_path`,
`cwd`, `prompt_id`, `permission_mode`, `effort`, `hook_event_name`,
`tool_name`, `tool_input`, `tool_use_id`, plus `agent_type` when an
agent was running and `agent_id` when it was a subagent. The plain
session's line also carried `scratchpad_dir`. `permission_mode` was
`default` in every `-p` run.

The hook command ran under Git Bash in every case, the PowerShell run
included: Claude Code runs a hook's command in its own shell, so no
`shell: powershell` line is needed for a `node …` command.

## What it decides (Rule 1 and § 7.2 amended)

- **The guard reads `agent_type`.** It is the agent's name whenever an
  agent runs, under `--agent` and as a subagent, and absent in a plain
  session. `agent_id` is a subagent's alone and is not used.
- **Both copies fire under `--agent` and for a subagent.** The guard will
  run twice on each call there; it decides the same both times, and a
  refusal from either refuses. The settings mirror stays for the case the
  docs give it: a teammate, whose frontmatter `hooks` are not applied.
- **The interactive teammate is owed.** Agent teams need an interactive
  session; in `-p` with the variable set the "teammate" ran as a
  subagent (an `agent_id`, the same shape as the `@agent-probe` run).
  Phase 4 runs that case by the user's hand and reads the log.
- **`CLAUDE_CODE_AGENT` is a second signal under `--agent`**, in the
  hook's environment; not relied on, recorded.
