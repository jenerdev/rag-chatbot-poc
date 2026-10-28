// guard.mjs — Rules 1 and 11 of plan/ai-employees.md: an employee never
// touches what its kind forbids, and this hook says so, not its prompt.
//
// A PreToolUse hook, named in every employee's agent file AND mirrored in
// .claude/settings.json (Phase 0 observed both copies firing under
// `claude --agent` and for a subagent, and only the settings' for a
// teammate). It reads the call on stdin, finds who is calling from
// `agent_type` (the agent's name there; absent in a plain session), reads
// that employee's profile.json, and exits 2 with the reason on stderr
// unless the call is one its guard allows:
//
//   Write, Edit, NotebookEdit   the path is in the guard's `writes` prefixes
//                               or matches a `writeGlobs` pattern; never a
//                               board, an inbox, the pipeline or the
//                               sequence (the script writes those); never
//                               another employee's office folder
//   Bash                        guard.bash = "allow": an ALLOWLIST of first
//                               commands (read-only git, the office script,
//                               what the profile adds) and a few filters
//                               after a pipe;
//                               guard.bash = "deny": anything but the
//                               user's hand (commit, push, merge, deploy),
//                               the weaker wall a builder has to have
//
// An allowlist, never a denylist, wherever the role allows it: `git -c`
// can run a program, `git log --output=` writes a file, and a denylist is
// a list of what we thought of. A plain session and an employee with no
// guard pass through untouched.
//
// `judge()` is the whole decision, pure, so office.test.mjs pins every
// line below without spawning a process.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = () => (process.env.OFFICE_REPO ? resolve(process.env.OFFICE_REPO) : resolve(here, '..', '..'));

const FILTERS = /^(head|tail|grep|wc|sort|uniq|cut|cat|ls)(\s|$)/;
// What no allowed command needs, and what would turn one into a write.
const FORBIDDEN = [
  [/[;\n]/, 'a second command after ";" or a newline'],
  [/&&|\|\|/, 'a chained command'],
  [/>|<<?/, 'a redirection'],
  [/\$\(|`/, 'a command substitution'],
];
// What would turn a git read into a write or a program: tested on the first
// segment alone, so `grep -c` after a pipe is still a filter.
const GIT_DANGER = [
  [/--output(=|\s)/, '--output writes a file'],
  [/--exec|--upload-pack|--receive-pack|(^|\s)-c(\s|$)/, 'an option that runs a program'],
];
// The files the script alone writes (Rules 3, 4, 10), for every kind.
const SCRIPT_ONLY = /^office\/(employees\/[^/]+\/((board|inbox)\.md|sessions\.json)|pipeline\.md|sequence\.json|\.lock(\/.*)?)$/;

export const slash = (p) => p.replace(/\\/g, '/');

// The command with its quoted text masked, the same length, so the checks
// below see only what bash would act on: a message's ";" is a word, not a
// second command (George, Phase 7). Inside '…' bash expands nothing; inside
// "…" a `$(` or a backtick still runs, so those stay visible. An unclosed
// quote returns null: refused, never guessed.
export function mask(command) {
  let out = '';
  let quote = null;
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (quote === "'") { out += c === "'" ? c : 'x'; if (c === "'") quote = null; continue; }
    if (quote === '"') {
      if (c === '\\' && i + 1 < command.length) { out += 'xx'; i++; continue; }
      if (c === '"') { out += c; quote = null; continue; }
      out += c === '$' || c === '(' || c === '`' ? c : 'x';
      continue;
    }
    if (c === "'" || c === '"') quote = c;
    out += c;
  }
  return quote ? null : out;
}

const underPrefix = (rel, prefix) => (prefix.endsWith('/') ? rel === prefix.slice(0, -1) || rel.startsWith(prefix) : rel === prefix);

export function judge({ tool_name: tool, tool_input: input = {}, cwd, agent_type: who }, guard, repo = repoRoot()) {
  if (!guard) return null;
  if (tool === 'Write' || tool === 'Edit' || tool === 'MultiEdit' || tool === 'NotebookEdit') {
    const given = input.file_path ?? input.notebook_path ?? '';
    if (!given) return `${tool} with no file path`;
    const abs = isAbsolute(given) ? given : resolve(cwd ?? repo, given);
    const rel = slash(relative(repo, abs));
    if (rel.startsWith('..') || isAbsolute(rel)) return `${tool} outside the repository: ${given}`;
    if (SCRIPT_ONLY.test(rel)) return `${tool} to ${rel}: only office.mjs writes a board, an inbox, the pipeline or the sequence (Rules 3, 4, 10)`;
    const other = /^office\/employees\/([^/]+)\//.exec(rel);
    if (other && other[1] !== who) return `${tool} to ${rel}: that is ${other[1]}'s folder, not ${who}'s`;
    const writes = guard.writes ?? [];
    if (writes.includes('/')) return null; // a builder: anywhere, bar the lines above
    if (writes.some((p) => underPrefix(rel, p))) return null;
    if ((guard.writeGlobs ?? []).some((g) => new RegExp(g).test(rel))) return null;
    return `${tool} to ${rel}: ${who} (${guard.kind}) writes under ${writes.join(', ')}${guard.writeGlobs?.length ? ' and test files' : ''} only (plan/ai-employees.md Rule 11)`;
  }
  if (tool === 'Bash') {
    let command = (input.command ?? '').trim();
    if (guard.bash === 'deny') {
      for (const re of guard.bashDeny ?? []) if (new RegExp(re).test(command)) return `the user's hand, not ${who}'s (Rule 8): ${command}`;
      return null;
    }
    // The Bash tool often prefixes `cd "<the repo>" && `; one leading cd into the repo is fine.
    const cd = /^cd\s+("[^"]+"|'[^']+'|\S+)\s*&&\s*/.exec(command);
    if (cd) {
      const target = cd[1].replace(/^["']|["']$/g, '');
      if (slash(resolve(target)) !== slash(repo)) return `cd out of the repository: ${target}`;
      command = command.slice(cd[0].length);
    }
    const masked = mask(command);
    if (masked === null) return `an unclosed quote in: ${command}`;
    for (const [re, why] of FORBIDDEN) if (re.test(masked)) return `${why} in: ${command}`;
    // Split where the MASKED text has a pipe; the same positions cut the original.
    const cuts = [...masked.matchAll(/\|/g)].map((m) => m.index);
    const bounds = [-1, ...cuts, command.length];
    const segments = bounds.slice(1).map((end, i) => command.slice(bounds[i] + 1, end).trim());
    const maskedFirst = masked.slice(0, bounds[1]).trim();
    const [first, ...rest] = segments;
    const allowed = (guard.bashAllow ?? []).some((p) => first === p || first.startsWith(p + ' '));
    if (!allowed) return `not in ${who}'s allowlist (${(guard.bashAllow ?? []).join(', ')}): ${first}`;
    if (/^git\b/.test(first)) for (const [re, why] of GIT_DANGER) if (re.test(maskedFirst)) return `${why} in: ${first}`;
    for (const seg of rest) if (!FILTERS.test(seg)) return `after a pipe only head, tail, grep, wc, sort, uniq, cut, cat or ls: ${seg}`;
    return null;
  }
  return null;
}

export function guardOf(agentType, repo = repoRoot()) {
  if (!agentType || !/^[a-z][a-z0-9-]*$/.test(agentType)) return null;
  const file = resolve(repo, 'office', 'employees', agentType, 'profile.json');
  if (!existsSync(file)) return null;
  try {
    const g = JSON.parse(readFileSync(file, 'utf8')).guard;
    return g && typeof g === 'object' ? g : null;
  } catch { return null; }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  let input = {};
  try { input = JSON.parse(raw || '{}'); } catch { input = {}; }
  const who = input.agent_type;
  const guard = guardOf(who);
  if (!guard) process.exit(0);
  const reason = judge(input, guard);
  if (reason === null) process.exit(0);
  console.error(`guard: ${who} may not do this — ${reason}`);
  process.exit(2);
}
