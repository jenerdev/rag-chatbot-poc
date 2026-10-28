// Phase 0 of plan/ai-employees.md: a logging PreToolUse hook. It records what
// Claude Code hands a hook on stdin (every top-level key, and the two identity
// fields the guard will depend on) and which copy of the hook ran (the agent
// file's, or the project settings'), then lets the call through. Throwaway.
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const log = join(here, 'phase0.log');
const copy = process.argv[2] ?? 'unlabelled';

let raw = '';
for await (const chunk of process.stdin) raw += chunk;
let input = {};
try { input = JSON.parse(raw); } catch { input = { unparsed: raw.slice(0, 200) }; }

const claudeEnv = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => k.startsWith('CLAUDE')).map(([k, v]) => [k, k.includes('KEY') ? '<hidden>' : v]),
);

mkdirSync(here, { recursive: true });
appendFileSync(log, JSON.stringify({
  at: new Date().toISOString(),
  copy,
  shell: process.env.PSModulePath && !process.env.SHELL ? 'powershell?' : (process.env.SHELL ?? 'unknown'),
  keys: Object.keys(input),
  hook_event_name: input.hook_event_name,
  tool_name: input.tool_name,
  command: input.tool_input?.command,
  agent_type: input.agent_type ?? null,
  agent_id: input.agent_id ?? null,
  permission_mode: input.permission_mode ?? null,
  session_id: input.session_id ?? null,
  claudeEnv,
}) + '\n');
process.exit(0);
