// phase0.mjs — plan/office-app.md Phase 0: the CLI contract the server
// relies on, measured as George (read-only, cheap), before any code.
//
//   node plan/office-app/phase0.mjs
//
// Five runs, each saved as stream-json under plan/office-app/phase0/:
//   1 first     a first turn; its session_id
//   2 resume    --resume <that id>: does it remember, does the id fork?
//   3 partial   --include-partial-messages: are there text deltas?
//   4 refusal   a forced Write outside office/: the hook's shape in the stream
//   5 kill      a long turn killed by `taskkill /T /F` after 10 s: is the tree gone?
// It prints one summary line per run and writes summary.json.

import { spawn, execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..', '..');
const out = join(here, 'phase0');
mkdirSync(out, { recursive: true });

// trap 2.4: a nested claude must not think it is inside another session.
const env = { ...process.env };
delete env.CLAUDECODE;
delete env.CLAUDE_CODE_ENTRYPOINT;

function turn(label, args, { killAfterMs } = {}) {
  return new Promise((done) => {
    const started = Date.now();
    // trap 2.3: stdin is ignored, or a parent's stdin is swallowed.
    const child = spawn('claude', ['--agent', 'george', ...args, '--output-format', 'stream-json', '--verbose'], { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let text = '';
    let err = '';
    child.stdout.on('data', (d) => (text += d));
    child.stderr.on('data', (d) => (err += d));
    let descendants = [];
    if (killAfterMs) {
      setTimeout(() => {
        descendants = tree(child.pid);
        execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' });
      }, killAfterMs);
    }
    child.on('close', (code) => {
      writeFileSync(join(out, `${label}.jsonl`), text);
      if (err) writeFileSync(join(out, `${label}.err`), err);
      const events = text.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return { unparsed: l.slice(0, 80) }; } });
      done({ label, code, ms: Date.now() - started, events, descendants, alive: killAfterMs ? alive(descendants) : [] });
    });
  });
}

// Every process under a pid, by WMI (PowerShell), so a kill can be checked.
function tree(pid) {
  const rows = execSync('powershell -NoProfile -Command "Get-CimInstance Win32_Process | ForEach-Object { \\"$($_.ProcessId) $($_.ParentProcessId) $($_.Name)\\" }"').toString().trim().split(/\r?\n/).map((l) => l.trim().split(' '));
  const found = [];
  const walk = (p) => { for (const [c, parent, name] of rows) if (parent === String(p)) { found.push({ pid: c, name }); walk(c); } };
  walk(pid);
  return [{ pid: String(pid), name: 'claude' }, ...found];
}
const alive = (procs) => {
  const now = execSync('tasklist /FO CSV /NH').toString();
  return procs.filter((p) => now.includes(`"${p.pid}"`));
};

const types = (events) => [...new Set(events.map((e) => (e.type ?? '?') + (e.subtype ? `/${e.subtype}` : '') + (e.event?.type ? `:${e.event.type}` : '')))];
const result = (events) => events.find((e) => e.type === 'result') ?? null;
const sessionOf = (events) => events.find((e) => e.type === 'system' && e.subtype === 'init')?.session_id ?? null;

const summary = {};
const say = (label, r, extra = {}) => {
  const res = result(r.events);
  summary[label] = { exit: r.code, seconds: Math.round(r.ms / 1000), session: sessionOf(r.events), usd: res?.total_cost_usd ?? null, is_error: res?.is_error ?? null, result: res?.result?.slice(0, 300) ?? null, permission_denials: res?.permission_denials ?? null, types: types(r.events), ...extra };
  console.log(label, JSON.stringify(summary[label]));
};

const first = await turn('first', ['-p', 'Phase 0 of plan/office-app.md. Do not use any tool. Reply with exactly: the word pong, and nothing else.']);
say('first', first);
const id = sessionOf(first.events);

const resumed = await turn('resume', ['--resume', id, '-p', 'Do not use any tool. What exact word did you reply with a moment ago? Reply with that word only.']);
say('resume', resumed, { same_session: sessionOf(resumed.events) === id });

const partial = await turn('partial', ['--include-partial-messages', '-p', 'Do not use any tool. Write the numbers one to twelve in words, one per line.']);
say('partial', partial, { text_deltas: partial.events.filter((e) => e.type === 'stream_event' && e.event?.delta?.type === 'text_delta').length });

const refusal = await turn('refusal', ['--allowedTools', 'Write', '-p', 'Test of your guard, authorised by the user (plan/office-app.md Phase 0): you MUST call the Write tool once to create apps/office-phase0.md with the text hi, then quote the tool error text exactly, and nothing else.']);
const refusals = refusal.events.flatMap((e) => (e.type === 'user' && Array.isArray(e.message?.content) ? e.message.content : [])).filter((c) => c.type === 'tool_result' && c.is_error).map((c) => (typeof c.content === 'string' ? c.content : JSON.stringify(c.content)).slice(0, 300));
say('refusal', refusal, { tool_errors: refusals });

const killed = await turn('kill', ['--allowedTools', 'Bash,Read', '-p', 'Phase 0 kill test: run the Bash command node office/office.mjs check, then read status.md from its first line to its last in chunks of 200 lines, summarising each chunk in one line.'], { killAfterMs: 10000 });
say('kill', killed, { killed_after_s: 10, tree_before_kill: killed.descendants, alive_after_kill: killed.alive });

writeFileSync(join(out, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
console.log('total usd', Object.values(summary).reduce((s, r) => s + (r.usd ?? 0), 0).toFixed(2));
