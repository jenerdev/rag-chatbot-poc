# Office app, Phase 0: the CLI contract, measured

2026-10-28, Claude Code 2.1.312, as George (`claude --agent george -p …
--output-format stream-json --verbose`), from `phase0.mjs`; every run's
events are in `phase0/<label>.jsonl`, the summary in `phase0/summary.json`.
Five runs, 1.37 USD.

| Trap 2.1 asks | Observed | So the server |
|---|---|---|
| Does `--resume <id>` with `-p` continue? | yes: asked "what word did you reply with", it answered `pong`; **`session_id` unchanged** (`fc021029-…` both runs; 0.34 then 0.39 USD) | stores one id per chat; a turn is `--resume <id>` |
| Are there text deltas? | with `--include-partial-messages`: `stream_event` events (`message_start`, `content_block_start`, `content_block_delta` ×5 with `delta.type = text_delta`, `content_block_stop`, `message_delta`, `message_stop`), and the whole `assistant` message as well | streams `text_delta`s to the page, and treats the `assistant` message as the authority for the final text |
| A hook refusal's shape? | a `user` event with a `tool_result`, `is_error: true`, content `PreToolUse:Write hook error: [node office/hooks/guard.mjs]: guard: george may not do this — …`; and **the same call in `result.permission_denials`** (tool name, id, input) | marks a tool line refused when its `tool_result` is an error starting `PreToolUse:` |
| The session's id, where? | `system/init.session_id`, before any text | answers the POST once `init` arrives, so the page can open the stream |
| The cost, where? | `result.total_cost_usd` (and `is_error`, `result`) | records the turn from `result` only |
| A kill mid-turn? | `taskkill /PID <pid> /T /F` at 10 s: exit 1, **no `result` event**, the events up to then intact; the tree held one process at that instant (`claude.exe`, the Bash call had ended), and **none alive after** | Stop is `taskkill /T /F` on Windows; a turn without `result` is recorded as stopped, cost unknown |
| Other events | `system/hook_started`, `system/hook_response` (the SessionStart hooks), `system/status`, `system/notification`, `system/thinking_tokens`, `rate_limit_event` | ignores them, passes `rate_limit_event` through for the top bar |

**Not shown by this run:** a child process alive under `claude` at the kill
(the tree was one process). Phase 5's Stop is taken during a Bash call
instead. The session-limit `result` (`is_error: true`, "You've hit your
session limit · resets …") was observed in ai-employees Phase 7
(`phase7/*.limit.jsonl`), not here.
