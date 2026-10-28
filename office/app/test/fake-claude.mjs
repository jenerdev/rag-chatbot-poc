// fake-claude.mjs — stands in for `claude` in the office app's tests and
// walk, so they spend nothing (plan/office-app.md Phase 2). It prints the
// event shapes plan/office-app/phase0.md recorded from the real one.
//
// The prompt decides the turn:
//   contains "refuse"  a Write the guard refuses (is_error tool_result, PreToolUse:)
//   contains "slow"    keeps working until killed (Stop's test)
//   contains "limit"   ends on the session limit
//   contains "tool"    one allowed Read before the answer
//   otherwise          echoes "You said: <prompt>"
// FAKE_CLAUDE_LOG, when set, receives one JSON line of argv per run.

import { appendFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const argv = process.argv.slice(2);
if (process.env.FAKE_CLAUDE_LOG) appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify(argv) + '\n');
const arg = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : null; };
const prompt = arg('-p') ?? '';
const agent = arg('--agent') ?? 'nobody';
const session = arg('--resume') ?? randomUUID();
const out = (e) => process.stdout.write(JSON.stringify(e) + '\n');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const delay = Number(process.env.FAKE_CLAUDE_DELAY_MS ?? 20);

out({ type: 'system', subtype: 'hook_started', hook_name: 'SessionStart:startup' });
out({ type: 'system', subtype: 'init', session_id: session, tools: ['Read', 'Write'], agents: [agent] });
await wait(delay);

if (/slow/.test(prompt)) {
  out({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_slow', name: 'Bash', input: { command: 'pnpm test' } }] }, session_id: session });
  setInterval(() => {}, 1000);
  await wait(60000);
  process.exit(0);
}

if (/refuse/.test(prompt)) {
  out({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_w', name: 'Write', input: { file_path: `${process.cwd()}/apps/x.md`, content: 'hi' } }] }, session_id: session });
  await wait(delay);
  out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_w', is_error: true, content: `PreToolUse:Write hook error: [node office/hooks/guard.mjs]: guard: ${agent} may not do this — Write to apps/x.md` }] }, session_id: session });
}
if (/tool/.test(prompt)) {
  out({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_r', name: 'Read', input: { file_path: `${process.cwd()}/status.md` } }] }, session_id: session });
  await wait(delay);
  out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_r', content: '1\tstatus' }] }, session_id: session });
}

if (/limit/.test(prompt)) {
  out({ type: 'result', subtype: 'success', is_error: true, result: "You've hit your session limit · resets 8:20am (Asia/Manila)", total_cost_usd: 0, duration_ms: 50, session_id: session });
  process.exit(0);
}

const reply = /refuse/.test(prompt) ? 'The guard refused that Write.' : `You said: ${prompt}`;
out({ type: 'stream_event', event: { type: 'message_start' }, session_id: session });
for (const word of reply.match(/\S+\s*/g) ?? []) {
  out({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: word } }, session_id: session });
  await wait(delay / 4);
}
out({ type: 'assistant', message: { content: [{ type: 'text', text: reply }] }, session_id: session });
out({ type: 'rate_limit_event' });
out({ type: 'result', subtype: 'success', is_error: false, result: reply, total_cost_usd: 0.0125, duration_ms: 300, session_id: session });
