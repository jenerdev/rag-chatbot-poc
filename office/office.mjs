// office.mjs — the office's ONE writer (plan/ai-employees.md § 2, Rules 3–6, 10–12).
//
//   node office/office.mjs hire <name> "<title>" --role <role> --guard <kind> [--colour c] [--model m] [--pronouns p] [--tools "a,b"] [--skills "a,b"]
//   node office/office.mjs task add --to <name> --from <who> "<title>" --why "<why>" [--doing] [--idea <slug>]
//   node office/office.mjs task move <T-id> doing|done|dropped [--note "<note>"]
//   node office/office.mjs task list [<name>] [--all] [--json]
//   node office/office.mjs msg --to <name> --from <who> "<text>"
//   node office/office.mjs inbox <name> [--ack <M-id> | --ack-all]
//   node office/office.mjs report --from <name> "<what I did; files; numbers; owed>"   to George, the office's memory
//   node office/office.mjs reports [--all | --ack-all]   George's feed: the unread, every one, or tick them all
//   node office/office.mjs index [<name>]        George's mechanical digests (decisions, open risks, the watermark)
//   node office/office.mjs idea add <slug> "<title>" --from <who> [--lane full|short]
//   node office/office.mjs gate <slug> <gate> --by <name> --verdict <V> [--file <path>] [--note "…"] [--override]
//   node office/office.mjs pipeline [<slug>] [--json]
//   node office/office.mjs organization          the organization's words into the skill and the charters, verbatim (Rule 12)
//   node office/office.mjs check                 Rule 5's audit; exit 1 on any mismatch
//
// Zero dependencies and no network, like @rag/chunker: everything here is a
// file under office/, docs/ or .claude/, read and written by this script
// alone. A board, an inbox and the pipeline are markdown a person reads, so
// each has ONE line shape, parsed and rendered by a pair of functions
// below; a line that does not parse is a `check` failure, never a silent
// skip.
//
// OFFICE_REPO points the script at another repository root (the tests use a
// temporary one); OFFICE_NOW fixes "now" (ISO) for the same reason.

import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------- where

const here = dirname(fileURLToPath(import.meta.url));
export const repo = () => (process.env.OFFICE_REPO ? resolve(process.env.OFFICE_REPO) : resolve(here, '..'));
const office = () => join(repo(), 'office');
const agentsDir = () => join(repo(), '.claude', 'agents');
const skillsDir = () => join(repo(), '.claude', 'skills');
const employeeDir = (name) => join(office(), 'employees', name);
const agentFile = (name) => join(agentsDir(), `${name}.md`);
const sequenceFile = () => join(office(), 'sequence.json');
const pipelineFile = () => join(office(), 'pipeline.md');
const settingsFile = () => join(repo(), '.claude', 'settings.json');
const organizationFile = () => join(repo(), 'plan', 'ai-employees', 'organization.md');
const organizationSkill = () => join(skillsDir(), 'office-organization', 'SKILL.md');

// The thirteen plugins the user named (plan § 6). `check` asserts that the
// project settings still enable every one: a plugin removed by hand is a
// kit an employee's charter still names.
export const REQUIRED_PLUGINS = [
  'superpowers@claude-plugins-official',
  'frontend-design@claude-plugins-official',
  'context7@claude-plugins-official',
  'github@claude-plugins-official',
  'playwright@claude-plugins-official',
  'code-review@claude-plugins-official',
  'skill-creator@claude-plugins-official',
  'code-simplifier@claude-plugins-official',
  'security-guidance@claude-plugins-official',
  'claude-md-management@claude-plugins-official',
  'feature-dev@claude-plugins-official',
  'typescript-lsp@claude-plugins-official',
  'supabase@anthropic-plugin-directory',
];

// The frontmatter keys Claude Code 2.1.310 documents for an agent file
// (plan Rule 5). An unknown key is silently ignored by Claude Code, so a
// misspelled `disallowedTools` is a guard that is not there; `check`
// refuses it.
export const KNOWN_FRONTMATTER = [
  'name', 'description', 'tools', 'disallowedTools', 'model', 'permissionMode', 'maxTurns',
  'autoCompactWindow', 'skills', 'mcpServers', 'hooks', 'memory', 'background', 'omitClaudeMd',
  'effort', 'isolation', 'color', 'initialPrompt', 'experimental',
];

// Claude Code's eight agent colours, as the avatar draws them.
const COLOURS = {
  red: '#c0392b', blue: '#2563eb', green: '#15803d', yellow: '#ca8a04',
  purple: '#7c3aed', orange: '#ea580c', pink: '#db2777', cyan: '#0891b2',
};

export const GUARD_COMMAND = 'node office/hooks/guard.mjs';
export const ORGANIZATION_SKILL = 'office-organization';
const BASE_TOOLS = 'Read, Grep, Glob, Bash, Edit, Write, SendMessage';

// The record files George digests (Rule 2); the watermark counts their lines.
const RECORD_FILES = ['status.md', 'whats-done.md', 'decisions.md', 'risks.md', 'notes.md', 'todo.md', 'CLAUDE.md'];

// ---------------------------------------------------------------- the roles and the gates (plan § 4)

// The organization's nine roles plus George's, keyed as the `role` field of
// a profile. The title is the heading the organization file uses for the
// role's section ("### Employee N: <Title>"), which `organization` copies.
export const ROLES = {
  'project-intelligence': 'Project Intelligence',
  'idea-strategist': 'Idea Strategist',
  'product-requirements-analyst': 'Product Requirements Analyst',
  'ux-architect': 'UX Architect',
  'visual-designer': 'Visual Designer',
  'technical-architect': 'Technical Architect',
  'full-stack-engineer': 'Full-Stack Engineer',
  'qa-engineer': 'QA Engineer',
  'security-reviewer': 'Security Reviewer',
  'legal-reviewer': 'Legal Reviewer',
};

// Each gate: who may write which verdicts, what must have passed before
// (per lane), and whether a deliverable file is required (plan § 4.2).
// `user` is always the project owner (organization § 4.10).
export const GATES = {
  idea: { owners: { 'idea-strategist': ['APPROVE', 'REVISE', 'RESEARCH', 'REJECT'] }, pass: ['APPROVE'], before: { full: null, short: null }, file: true },
  requirements: { owners: { 'product-requirements-analyst': ['DONE'], user: ['APPROVE', 'REVISE'] }, pass: ['APPROVE'], before: { full: 'idea', short: null }, file: true },
  ux: { owners: { 'ux-architect': ['DONE'] }, pass: ['DONE'], before: { full: 'requirements', short: null }, file: true },
  design: { owners: { 'visual-designer': ['DONE'] }, pass: ['DONE'], before: { full: 'ux', short: null }, file: true },
  architecture: { owners: { 'technical-architect': ['SUBMITTED'], 'security-reviewer': ['CONCERNS', 'CLEAR'], user: ['APPROVE', 'REVISE'] }, pass: ['APPROVE'], before: { full: 'requirements', short: null }, file: true },
  implementation: { owners: { 'full-stack-engineer': ['DONE'] }, pass: ['DONE'], before: { full: 'architecture', short: null }, file: true },
  qa: { owners: { 'qa-engineer': ['PASS', 'FAIL'] }, pass: ['PASS'], before: { full: 'implementation', short: 'implementation' }, file: true },
  security: { owners: { 'security-reviewer': ['CLEAR', 'FINDINGS:CRITICAL', 'FINDINGS:HIGH', 'FINDINGS:MEDIUM', 'FINDINGS:LOW', 'FINDINGS:INFORMATIONAL'], user: ['ACCEPTED'] }, pass: ['CLEAR', 'FINDINGS:MEDIUM', 'FINDINGS:LOW', 'FINDINGS:INFORMATIONAL', 'ACCEPTED'], before: { full: 'implementation', short: 'implementation' }, file: true },
  legal: { owners: { 'legal-reviewer': ['CLEAR', 'NEEDS REVISION', 'PROFESSIONAL REVIEW REQUIRED'] }, pass: ['CLEAR', 'PROFESSIONAL REVIEW REQUIRED'], before: { full: 'implementation', short: 'implementation' }, file: true },
  release: { owners: { 'qa-engineer': ['READY', 'READY WITH DOCUMENTED RISKS', 'NOT READY'] }, pass: ['READY', 'READY WITH DOCUMENTED RISKS'], before: { full: 'qa', short: 'qa' }, file: true },
  released: { owners: { user: ['RELEASED'] }, pass: ['RELEASED'], before: { full: 'release', short: 'release' }, file: false },
};
export const GATE_ORDER = Object.keys(GATES);
export const LANES = ['full', 'short'];
export const LADDER = ['Planned', 'Approved', 'In progress', 'Implemented', 'Tested', 'Reviewed', 'Released'];

// ---------------------------------------------------------------- the guard kinds (plan Rule 11)

const BASE_ALLOW = ['git log', 'git show', 'git diff', 'git status', 'git blame', 'git rev-parse', 'git ls-files', 'git branch --list', 'git shortlog', 'node office/office.mjs'];
// The user's hand (Rule 8), refused for the kinds that run anything else.
const USER_HAND = [
  '\\bgit\\s+(commit|push|merge|rebase|reset|checkout|switch|stash|cherry-pick|revert|tag)\\b',
  '\\bgit\\s+branch\\s+(-[dDm]|--delete|--move)\\b',
  '\\bgit\\s+-C\\s+\\S+\\s+(commit|push|merge|rebase|reset|checkout)\\b',
  '\\bgh\\s+(pr|release)\\s+(create|merge|edit|close)\\b',
  '\\bvercel\\b',
];
const TEST_GLOBS = ['\\.test\\.(ts|tsx|mjs|js)$', '^plan/[^/]+-(walk|a11y|check|shots|cases)\\.mjs$', '^packages/[^/]+/tools/[^/]+\\.mjs$'];

export function guardKind(kind) {
  if (kind === 'read-only') return { kind, writes: ['office/'], bash: 'allow', bashAllow: [...BASE_ALLOW] };
  const author = /^author:([a-z]+)$/.exec(kind ?? '');
  if (author) {
    const area = author[1];
    const writes = area === 'architecture' ? ['office/', 'plan/', 'decisions.md', 'risks.md'] : ['office/', `docs/${area}/`];
    const bashAllow = [...BASE_ALLOW, ...(area === 'security' ? ['pnpm audit'] : [])];
    return { kind, writes, bash: 'allow', bashAllow };
  }
  if (kind === 'tester') return { kind, writes: ['office/', 'docs/qa/'], writeGlobs: [...TEST_GLOBS], bash: 'deny', bashDeny: [...USER_HAND] };
  if (kind === 'builder') return { kind, writes: ['/'], bash: 'deny', bashDeny: [...USER_HAND] };
  throw new Error(`--guard is read-only, author:<area>, tester or builder, not "${kind}"`);
}
const EXPLICIT_TOOLS = (kind) => kind === 'read-only' || kind.startsWith('author:');

// ---------------------------------------------------------------- time

const now = () => (process.env.OFFICE_NOW ? new Date(process.env.OFFICE_NOW) : new Date());
const pad = (n) => String(n).padStart(2, '0');
// Local wall-clock dates: the office lives on the user's machine, in the
// user's day, unlike the product, whose "today" is the tenant's (trap 9).
export const today = () => { const d = now(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const stamp = () => { const d = now(); return `${today()} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };

// ---------------------------------------------------------------- files

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
const writeJson = (file, value) => writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
// With core.autocrlf a Windows checkout turns every LF into CRLF, and
// `check`'s verbatim comparisons (the skill, the charters) would fail on a
// fresh clone (found in the office-app worktree, 2026-10-28). Read as LF.
const readText = (file) => readFileSync(file, 'utf8').replace(/\r\n/g, '\n');

export const roster = () =>
  existsSync(join(office(), 'employees')) ? readdirSync(join(office(), 'employees'), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort() : [];

export const profile = (name) => readJson(join(employeeDir(name), 'profile.json'));
const byRole = (role) => roster().filter((n) => profile(n).role === role);

const mustBeEmployee = (name, what) => {
  if (!name) throw new Error(`${what} is required`);
  if (!roster().includes(name)) throw new Error(`no employee "${name}" (the roster: ${roster().join(', ') || 'nobody yet'})`);
};
const mustBeSender = (who) => { if (who !== 'user') mustBeEmployee(who, '--from'); };

// One sequence for the whole office: an id is unique across every board
// and every inbox, so a task can be named in a message without saying
// whose board it is on (Rule 3).
const nextId = (kind) => {
  const seq = existsSync(sequenceFile()) ? readJson(sequenceFile()) : { task: 0, message: 0 };
  seq[kind] = (seq[kind] ?? 0) + 1;
  writeJson(sequenceFile(), seq);
  return `${kind === 'task' ? 'T' : 'M'}-${String(seq[kind]).padStart(3, '0')}`;
};

const clean = (s, what) => {
  const v = (s ?? '').trim();
  if (!v) throw new Error(`${what} is required`);
  if (/[\r\n]/.test(v)) throw new Error(`${what} is one line`);
  if (/ · /.test(v)) throw new Error(`${what} cannot contain " · " (the line's separator)`);
  return v;
};

// ---------------------------------------------------------------- the lock (plan/office-app.md Rule 6)

// Every writer reads a file, changes it and writes it back, and the sequence
// is one file for the whole office. Two employees finishing in the same
// second, or the office app and a terminal, would both read T-013 and both
// write T-014. So every exported writer runs under ONE lock: a directory,
// because mkdir is atomic on every platform and needs no dependency. It is
// re-entrant (a writer that calls a writer does not wait for itself), and a
// lock older than LOCK_STALE_MS belongs to a process that died holding it.
const lockDir = () => join(office(), '.lock');
export const LOCK_WAIT_MS = 5000;
export const LOCK_STALE_MS = 30000;
let lockDepth = 0;
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
export function withLock(fn) {
  if (lockDepth > 0) { lockDepth++; try { return fn(); } finally { lockDepth--; } }
  const started = Date.now();
  for (;;) {
    try { mkdirSync(lockDir()); break; } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let age = 0; try { age = Date.now() - statSync(lockDir()).mtimeMs; } catch { continue; }
      if (age > LOCK_STALE_MS) { try { rmSync(lockDir(), { recursive: true, force: true }); } catch {} continue; }
      if (Date.now() - started > LOCK_WAIT_MS) throw new Error(`the office is busy: another writer has held office/.lock for ${Math.round(age / 1000)} s (try again)`);
      sleepSync(25);
    }
  }
  lockDepth = 1;
  try { return fn(); } finally { lockDepth = 0; rmSync(lockDir(), { recursive: true, force: true }); }
}
const locked = (fn) => (...args) => withLock(() => fn(...args));

// ---------------------------------------------------------------- the board

export const SECTIONS = ['doing', 'inbox', 'done', 'dropped'];
const SECTION_TITLE = { doing: 'Doing', inbox: 'Inbox', done: 'Done', dropped: 'Dropped' };

const ITEM = /^- (T-\d+) · (\d{4}-\d{2}-\d{2}) · from (\S+) · \*\*(.+?)\*\* · why: (.*?)(?: · idea: (\S+))?(?: · (done|dropped) (\d{4}-\d{2}-\d{2}): (.*))?$/;

export function parseBoard(text) {
  const board = Object.fromEntries(SECTIONS.map((s) => [s, []]));
  let section = null;
  const problems = [];
  for (const line of text.split(/\r?\n/)) {
    const heading = /^## (\w+)/.exec(line);
    if (heading) { section = SECTIONS.find((s) => SECTION_TITLE[s] === heading[1]) ?? null; if (!section) problems.push(`unknown section "${heading[1]}"`); continue; }
    if (!line.startsWith('- ')) continue;
    if (!section) { problems.push(`an item before any section: ${line}`); continue; }
    const m = ITEM.exec(line);
    if (!m) { problems.push(`a line that is not a task: ${line}`); continue; }
    const [, id, date, from, title, why, idea, closedAs, closedOn, note] = m;
    board[section].push({ id, date, from, title, why, ...(idea ? { idea } : {}), ...(closedAs ? { closedAs, closedOn, note } : {}) });
  }
  return { board, problems };
}

const renderItem = (t) =>
  `- ${t.id} · ${t.date} · from ${t.from} · **${t.title}** · why: ${t.why}` + (t.idea ? ` · idea: ${t.idea}` : '') + (t.closedAs ? ` · ${t.closedAs} ${t.closedOn}: ${t.note}` : '');

export function renderBoard(board, name) {
  const lines = [`# ${name}'s board`, '', `Written by \`node office/office.mjs task …\` only (Rule 3). Newest last.`, ''];
  for (const s of SECTIONS) {
    lines.push(`## ${SECTION_TITLE[s]}`, '');
    for (const t of board[s]) lines.push(renderItem(t));
    if (board[s].length) lines.push('');
  }
  return lines.join('\n').replace(/\n+$/, '\n');
}

const boardFile = (name) => join(employeeDir(name), 'board.md');
const loadBoard = (name) => {
  const { board, problems } = parseBoard(readText(boardFile(name)));
  if (problems.length) throw new Error(`${name}'s board does not parse: ${problems[0]}`);
  return board;
};
const saveBoard = (name, board) => writeFileSync(boardFile(name), renderBoard(board, name));

function taskAddUnlocked({ to, from, title, why, doing = false, idea }) {
  mustBeEmployee(to, '--to'); mustBeSender(from);
  // Everything is checked and the board is read BEFORE the sequence is
  // bumped: a refused task must not consume an id.
  const fields = { title: clean(title, 'the title'), why: clean(why, '--why') };
  if (idea) { if (!findIdea(idea)) throw new Error(`no idea "${idea}" on the pipeline`); fields.idea = idea; }
  const board = loadBoard(to);
  const task = { id: nextId('task'), date: today(), from, ...fields };
  board[doing ? 'doing' : 'inbox'].push(task);
  saveBoard(to, board);
  autoReport(from, 'task', `${task.id} to ${to}${doing ? ' (doing)' : ''}: ${task.title}; why: ${task.why}`);
  return { ...task, to, section: doing ? 'doing' : 'inbox' };
}

export function findTask(id) {
  for (const name of roster()) {
    const board = loadBoard(name);
    for (const s of SECTIONS) { const i = board[s].findIndex((t) => t.id === id); if (i >= 0) return { name, board, section: s, index: i }; }
  }
  return null;
}

function taskMoveUnlocked(id, to, { note } = {}) {
  if (!['doing', 'done', 'dropped'].includes(to)) throw new Error(`a task moves to doing, done or dropped, not "${to}"`);
  const found = findTask(id);
  if (!found) throw new Error(`no task ${id} on any board`);
  const { name, board, section, index } = found;
  if (section === 'done' || section === 'dropped') throw new Error(`${id} is already ${section}`);
  const [task] = board[section].splice(index, 1);
  if (to === 'doing') board.doing.push(task);
  else board[to].push({ ...task, closedAs: to, closedOn: today(), note: clean(note, `--note (a task is ${to} with a note, D-096's rule for the office)`) });
  saveBoard(name, board);
  autoReport(name, 'task', `${task.id} ${section} → ${to}: ${task.title}${to === 'doing' ? '' : `; note: ${board[to].at(-1).note}`}`);
  return { ...task, name, from: section, to };
}

export function taskList(name, { all = false } = {}) {
  const names = name ? (mustBeEmployee(name, 'the name'), [name]) : roster();
  return names.map((n) => {
    const board = loadBoard(n);
    return { name: n, board: all ? board : { doing: board.doing, inbox: board.inbox } };
  });
}

const boardWords = (list) =>
  list.map(({ name, board }) => [`${name}:`, ...SECTIONS.filter((s) => board[s]).flatMap((s) => board[s].length ? [`  ${SECTION_TITLE[s]}`, ...board[s].map((t) => `  ${renderItem(t).slice(2)}`)] : [])].join('\n')).join('\n\n');

// ---------------------------------------------------------------- the inbox

const MESSAGE = /^- \[( |x)\] (M-\d+) · (\d{4}-\d{2}-\d{2} \d{2}:\d{2}) · from (\S+) · (.*)$/;
const inboxFile = (name) => join(employeeDir(name), 'inbox.md');

export function parseInbox(text) {
  const messages = []; const problems = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith('- ')) continue;
    const m = MESSAGE.exec(line);
    if (!m) { problems.push(`a line that is not a message: ${line}`); continue; }
    messages.push({ read: m[1] === 'x', id: m[2], at: m[3], from: m[4], text: m[5] });
  }
  return { messages, problems };
}

const renderInbox = (messages, name) =>
  [`# ${name}'s inbox`, '', `Appended by \`node office/office.mjs msg …\`, ticked by \`inbox ${name} --ack\` (Rule 4). Newest last.`, '',
    ...messages.map((m) => `- [${m.read ? 'x' : ' '}] ${m.id} · ${m.at} · from ${m.from} · ${m.text}`), ''].join('\n');

const loadInbox = (name) => {
  const { messages, problems } = parseInbox(readText(inboxFile(name)));
  if (problems.length) throw new Error(`${name}'s inbox does not parse: ${problems[0]}`);
  return messages;
};

function msgUnlocked({ to, from, text }) {
  mustBeEmployee(to, '--to'); mustBeSender(from);
  const body = clean(text, 'the text');
  const messages = loadInbox(to);
  const message = { read: false, id: nextId('message'), at: stamp(), from, text: body };
  messages.push(message);
  writeFileSync(inboxFile(to), renderInbox(messages, to));
  return { ...message, to };
}

function inboxUnlocked(name, { ack, ackAll = false } = {}) {
  mustBeEmployee(name, 'the name');
  const messages = loadInbox(name);
  if (ack || ackAll) {
    let ticked = 0;
    for (const m of messages) if (!m.read && (ackAll || m.id === ack)) { m.read = true; ticked++; }
    if (ack && !ticked && !messages.some((m) => m.id === ack)) throw new Error(`no message ${ack} in ${name}'s inbox`);
    writeFileSync(inboxFile(name), renderInbox(messages, name));
  }
  return messages;
}

// ---------------------------------------------------------------- the reports (George's memory)

// George is the office's memory (the user, 2026-10-28: "every employee
// should report all their task to him to save to memory"). ONE feed, hers
// alone: every task added, started, finished or dropped, every idea and
// every gate, written by the script as it happens, so no work is missed
// because someone forgot; and every `report` an employee sends with what
// only the doer knows. She folds the unread ones into her notes on every
// wake, then ticks them. No id: a report is never answered or named.
export const MEMORY = 'george';
export const REPORT_LINE = "**Report to George.** George holds the office's memory. The script reports to her by itself whenever a task is added, started, finished or dropped, an idea is added or a gate is written. When you finish a task or write a gate, also report what only you know, in one line: `node office/office.mjs report --from <your name> \"T-0xx: what you did; the files; the numbers you observed; what is owed\"`. For the project's context, read George's notes first (`office/employees/george/notes/README.md`).";
export const REPORT_KINDS = ['task', 'idea', 'gate', 'report'];
const REPORT = /^- \[( |x)\] (\d{4}-\d{2}-\d{2} \d{2}:\d{2}) · from (\S+) · (task|idea|gate|report) · (.*)$/;
const reportsFile = () => join(employeeDir(MEMORY), 'reports.md');

export function parseReports(text) {
  const reports = []; const problems = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith('- ')) continue;
    const m = REPORT.exec(line);
    if (!m) { problems.push(`a line that is not a report: ${line}`); continue; }
    reports.push({ read: m[1] === 'x', at: m[2], from: m[3], kind: m[4], text: m[5] });
  }
  return { reports, problems };
}

const renderReports = (reports) =>
  [`# ${MEMORY}'s reports`, '', "The office's memory feed. Appended by `node office/office.mjs` alone (tasks, ideas and gates as they happen, and `report`), ticked by `reports --ack-all` once folded into the notes. Newest last.", '',
    ...reports.map((r) => `- [${r.read ? 'x' : ' '}] ${r.at} · from ${r.from} · ${r.kind} · ${r.text}`), ''].join('\n');

const loadReports = () => {
  if (!existsSync(reportsFile())) return [];
  const { reports, problems } = parseReports(readText(reportsFile()));
  if (problems.length) throw new Error(`${MEMORY}'s reports do not parse: ${problems[0]}`);
  return reports;
};

// What the script saw. Silent when the office has no George yet, and when
// the doer is George herself: she knows what she did.
function autoReport(from, kind, text) {
  if (from === MEMORY || !roster().includes(MEMORY)) return;
  const reports = loadReports();
  reports.push({ read: false, at: stamp(), from, kind, text: text.replace(/\s+/g, ' ').trim() });
  writeFileSync(reportsFile(), renderReports(reports));
}

function reportUnlocked({ from, text }) {
  mustBeEmployee(MEMORY, 'the memory keeper');
  mustBeSender(from);
  if (from === MEMORY) throw new Error(`${MEMORY} keeps the memory: she writes her notes, not a report to herself`);
  const body = clean(text, 'the report');
  const reports = loadReports();
  const r = { read: false, at: stamp(), from, kind: 'report', text: body };
  reports.push(r);
  writeFileSync(reportsFile(), renderReports(reports));
  return r;
}

function reportsUnlocked({ ackAll = false } = {}) {
  mustBeEmployee(MEMORY, 'the memory keeper');
  const reports = loadReports();
  if (ackAll) { for (const r of reports) r.read = true; writeFileSync(reportsFile(), renderReports(reports)); }
  return reports;
}

// ---------------------------------------------------------------- the pipeline (Rule 10)

const BLOCK = /^## (\S+) · (.+?) · (full|short) lane · from (\S+) · (\d{4}-\d{2}-\d{2}) · \*\*(.+?)\*\*$/;
const GATE_LINE = /^- (\w+) · (.+?) · by (\S+) · (\d{4}-\d{2}-\d{2})(?: · file: (\S+))?(?: · note: (.*?))?(?: · (override))?$/;

export function parsePipeline(text) {
  const ideas = []; const problems = [];
  let current = null;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('## ')) {
      const m = BLOCK.exec(line);
      if (!m) { problems.push(`a heading that is not an idea: ${line}`); current = null; continue; }
      current = { slug: m[1], title: m[2], lane: m[3], from: m[4], date: m[5], status: m[6], gates: [] };
      ideas.push(current);
      continue;
    }
    if (!line.startsWith('- ')) continue;
    if (!current) { problems.push(`a gate before any idea: ${line}`); continue; }
    const g = GATE_LINE.exec(line);
    if (!g) { problems.push(`a line that is not a gate: ${line}`); continue; }
    current.gates.push({ gate: g[1], verdict: g[2], by: g[3], date: g[4], ...(g[5] ? { file: g[5] } : {}), ...(g[6] ? { note: g[6] } : {}), ...(g[7] ? { override: true } : {}) });
  }
  return { ideas, problems };
}

const renderGate = (g) => `- ${g.gate} · ${g.verdict} · by ${g.by} · ${g.date}` + (g.file ? ` · file: ${g.file}` : '') + (g.note ? ` · note: ${g.note}` : '') + (g.override ? ' · override' : '');

export function renderPipeline(ideas) {
  const lines = ['# The pipeline', '', 'Every idea, its lane, its gates and its status, DERIVED from the gates (plan/ai-employees.md Rule 10). Written by `node office/office.mjs idea|gate …` only.', ''];
  for (const i of ideas) {
    lines.push(`## ${i.slug} · ${i.title} · ${i.lane} lane · from ${i.from} · ${i.date} · **${i.status}**`, '');
    for (const g of i.gates) lines.push(renderGate(g));
    if (i.gates.length) lines.push('');
  }
  return lines.join('\n').replace(/\n+$/, '\n');
}

const loadPipeline = () => {
  if (!existsSync(pipelineFile())) return [];
  const { ideas, problems } = parsePipeline(readText(pipelineFile()));
  if (problems.length) throw new Error(`the pipeline does not parse: ${problems[0]}`);
  return ideas;
};
const savePipeline = (ideas) => writeFileSync(pipelineFile(), renderPipeline(ideas));
export const findIdea = (slug) => loadPipeline().find((i) => i.slug === slug) ?? null;

// The latest verdict written for a gate on an idea, and whether it passes.
const latest = (idea, gate) => [...idea.gates].reverse().find((g) => g.gate === gate) ?? null;
const passed = (idea, gate) => { const g = latest(idea, gate); return !!g && GATES[gate].pass.includes(g.verdict); };

// The seven rungs, from the gates alone; "In progress" also reads the
// boards (a task tied to the idea in someone's Doing).
export function statusOf(idea, boards = null) {
  if (passed(idea, 'released')) return 'Released';
  const reviewed = passed(idea, 'qa') && (idea.lane === 'short'
    ? (!latest(idea, 'security') || passed(idea, 'security')) && (!latest(idea, 'legal') || passed(idea, 'legal'))
    : passed(idea, 'security') && passed(idea, 'legal'));
  if (reviewed) return 'Reviewed';
  if (passed(idea, 'qa')) return 'Tested';
  if (passed(idea, 'implementation')) return 'Implemented';
  const approved = idea.lane === 'short' || passed(idea, 'idea');
  if (approved) {
    const ready = idea.lane === 'short' || passed(idea, 'architecture');
    const inDoing = (boards ?? taskList(undefined, { all: true })).some(({ board }) => board.doing.some((t) => t.idea === idea.slug));
    if (ready && inDoing) return 'In progress';
    return 'Approved';
  }
  return 'Planned';
}

const SLUG = /^[a-z][a-z0-9-]*$/;

function ideaAddUnlocked({ slug, title, from, lane = 'full' }) {
  if (!SLUG.test(slug ?? '')) throw new Error('a slug is lowercase letters, digits and dashes');
  if (!LANES.includes(lane)) throw new Error(`--lane is full or short, not "${lane}"`);
  mustBeSender(from);
  const ideas = loadPipeline();
  if (ideas.some((i) => i.slug === slug)) throw new Error(`"${slug}" is already on the pipeline`);
  const idea = { slug, title: clean(title, 'the title'), lane, from, date: today(), status: 'Planned', gates: [] };
  idea.status = statusOf(idea, []);
  ideas.push(idea);
  savePipeline(ideas);
  autoReport(from, 'idea', `${slug} added (${lane} lane): ${idea.title}`);
  return idea;
}

function gateUnlocked({ slug, gate: name, by, verdict, file, note, override = false }) {
  const spec = GATES[name];
  if (!spec) throw new Error(`a gate is one of ${GATE_ORDER.join(', ')}, not "${name}"`);
  const ideas = loadPipeline();
  const idea = ideas.find((i) => i.slug === slug);
  if (!idea) throw new Error(`no idea "${slug}" on the pipeline`);
  mustBeSender(by);
  const role = by === 'user' ? 'user' : profile(by).role;
  const allowed = spec.owners[role];
  if (!allowed) throw new Error(`${by} (${role}) does not own the ${name} gate; its owners: ${Object.keys(spec.owners).join(', ')}`);
  if (!allowed.includes(verdict)) throw new Error(`${role} writes ${allowed.join(' / ')} on ${name}, not "${verdict}"`);
  const before = spec.before[idea.lane];
  if (before && !passed(idea, before)) {
    if (!override) throw new Error(`${name} before ${before} has passed on "${slug}" (Rule 9); the user may --override, and it is recorded`);
    if (by !== 'user') throw new Error('only the user may --override a gate');
  }
  if (spec.file && !file && by !== 'user') throw new Error(`the ${name} gate names its deliverable: --file <path>`);
  if (file && !existsSync(join(repo(), file))) throw new Error(`--file ${file} does not exist (Rule 10: a gate is never claimed from a document that is not there)`);
  const line = { gate: name, verdict, by, date: today(), ...(file ? { file } : {}), ...(note ? { note: clean(note, '--note') } : {}), ...(override && before && !passed(idea, before) ? { override: true } : {}) };
  idea.gates.push(line);
  idea.status = statusOf(idea);
  savePipeline(ideas);
  autoReport(by, 'gate', `${slug} ${name} ${verdict}${file ? `; file: ${file}` : ''}${line.note ? `; note: ${line.note}` : ''}${line.override ? '; override' : ''} → ${idea.status}`);
  return { ...line, slug, status: idea.status };
}

export function pipeline(slug) {
  const ideas = loadPipeline();
  const boards = taskList(undefined, { all: true });
  for (const i of ideas) i.status = statusOf(i, boards);
  return slug ? ideas.filter((i) => i.slug === slug) : ideas;
}

const pipelineWords = (ideas) => ideas.length
  ? ideas.map((i) => [`${i.slug} · ${i.title} · ${i.lane} lane · ${i.status}`, ...i.gates.map((g) => `  ${renderGate(g).slice(2)}`)].join('\n')).join('\n\n')
  : 'nothing on the pipeline';

// ---------------------------------------------------------------- hire

export function parseFrontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return null;
  const keys = []; const values = {}; const lists = {};
  const lines = m[1].split(/\r?\n/);
  let listKey = null;
  for (const line of lines) {
    const k = /^([A-Za-z]\w*):\s*(.*)$/.exec(line);
    if (k) { keys.push(k[1]); values[k[1]] = k[2]; listKey = k[2] === '' ? k[1] : null; continue; }
    const item = /^\s+-\s+(\S.*)$/.exec(line);
    if (item && listKey) (lists[listKey] ??= []).push(item[1].trim());
  }
  return { keys, values, lists, raw: m[1] };
}

const initials = (name) => name.split(/[-_ ]+/).map((w) => w[0]?.toUpperCase() ?? '').join('').slice(0, 2);

export const avatarSvg = (name, title, colour) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="128" height="128" role="img" aria-label="${name}, ${title}">
  <title>${name} · ${title}</title>
  <circle cx="64" cy="64" r="62" fill="${COLOURS[colour] ?? COLOURS.blue}"/>
  <text x="64" y="64" dy="0.36em" text-anchor="middle" font-family="system-ui, sans-serif" font-size="56" font-weight="700" fill="#fff">${initials(name)}</text>
</svg>
`;

export const ORG_BEGIN = '<!-- organization: begin (copied verbatim by office.mjs organization; do not edit here) -->';
export const ORG_END = '<!-- organization: end -->';

// `skills:` preloads into a SUBAGENT only: asked as `@agent-ivy`, Ivy quoted
// the skill's Mission line; as `claude --agent ivy` she answered NOT LOADED
// (plan/ai-employees/phase6.md). So every charter opens with this line, and
// a `--agent` session reads the skill itself before anything else.
export const ORG_READ_LINE = `**Before anything else:** if the text of the \`${ORGANIZATION_SKILL}\` skill is not in your context (a \`claude --agent\` session does not preload \`skills:\`; a subagent does), Read \`.claude/skills/${ORGANIZATION_SKILL}/SKILL.md\` whole, first.`;

// The agent file a hire writes. A read-only or author employee gets the
// explicit tools list that is also the plugin wall (plan § 3.1, § 6.1),
// plus the MCP tools its row names; a tester or builder gets every tool.
// Every kind gets the guard in its own frontmatter and the organization
// skill preloaded.
const agentTemplate = ({ name, title, role, model, colour, kind, tools, skills }) => {
  const front = [
    '---',
    `name: ${name}`,
    `description: ${title}. (Written at hire by office.mjs; the charter below says what ${name} does and refuses.)`,
    ...(EXPLICIT_TOOLS(kind) ? [`tools: ${[BASE_TOOLS, ...tools].join(', ')}`] : []),
    `model: ${model}`,
    `color: ${colour}`,
    'skills:',
    ...skills.map((s) => `  - ${s}`),
    'hooks:', '  PreToolUse:', '    - matcher: "Write|Edit|NotebookEdit|Bash"', '      hooks:', '        - type: command',
    `          command: "${GUARD_COMMAND}"`,
    '---',
  ];
  const body = role === 'project-intelligence'
    ? ['', `# ${name} — ${title}`, '', ORG_READ_LINE, '', ...(name === MEMORY ? [] : [REPORT_LINE, '']), '<!-- the charter: replace this line (plan/ai-employees.md § 3.2 is George\'s) -->', '']
    : ['', `# ${name} — ${title}`, '', ORG_READ_LINE, '', ...(name === MEMORY ? [] : [REPORT_LINE, '']), ORG_BEGIN, `<!-- run \`node office/office.mjs organization\` to fill this -->`, ORG_END, '', '## What the house adds', '', '<!-- plan/ai-employees.md § 4: the deliverable, the gate, the hand-off, the rules by number, the plugins, what is refused -->', ''];
  return [...front, ...body].join('\n');
};

function hireUnlocked({ name, title, role, colour = 'blue', model = 'inherit', pronouns = 'they/them', guard: kind = 'read-only', tools = [], skills = [] }) {
  if (!/^[a-z][a-z0-9-]*$/.test(name ?? '')) throw new Error('a name is lowercase letters, digits and dashes');
  if (!title?.trim()) throw new Error('a title is required');
  if (!ROLES[role]) throw new Error(`--role is one of ${Object.keys(ROLES).join(', ')}`);
  if (!COLOURS[colour]) throw new Error(`a colour is one of ${Object.keys(COLOURS).join(', ')}`);
  const guard = guardKind(kind);
  if (existsSync(employeeDir(name)) || existsSync(agentFile(name))) throw new Error(`"${name}" already works here`);
  const preload = [ORGANIZATION_SKILL, ...skills.filter((s) => s !== ORGANIZATION_SKILL)];
  mkdirSync(join(employeeDir(name), 'notes'), { recursive: true });
  mkdirSync(agentsDir(), { recursive: true });
  writeJson(join(employeeDir(name), 'profile.json'), { name, title, role, pronouns, skills: [], since: today(), colour, model, guard, tools, preload });
  writeFileSync(join(employeeDir(name), 'avatar.svg'), avatarSvg(name, title, colour));
  saveBoard(name, Object.fromEntries(SECTIONS.map((s) => [s, []])));
  writeFileSync(inboxFile(name), renderInbox([], name));
  if (name === MEMORY) writeFileSync(reportsFile(), renderReports([]));
  writeFileSync(join(employeeDir(name), 'notes', 'README.md'), `# ${name}'s notes\n\nWhat each file here holds, read first on every wake. Nothing yet.\n`);
  writeFileSync(agentFile(name), agentTemplate({ name, title, role, model, colour, kind, tools, skills: preload }));
  // A hire is born with the organization's section in its charter (Rule 12).
  if (existsSync(organizationFile())) fillCharter(name, organizationSections().employees);
  if (!existsSync(sequenceFile())) writeJson(sequenceFile(), { task: 0, message: 0 });
  return { name, title, role, files: [agentFile(name), employeeDir(name)] };
}

// ---------------------------------------------------------------- the organization (Rule 12)

// The organization file's sections by their "## N." headings, and the
// nine "### Employee N: <Title>" sections inside § 2, verbatim.
export function organizationSections() {
  const text = readText(organizationFile());
  const lines = text.split(/\r?\n/);
  const sections = {}; const employees = {};
  let key = null; let emp = null;
  for (const line of lines) {
    const h2 = /^## (\d)\. (.+)$/.exec(line);
    if (h2) { key = h2[1]; emp = null; sections[key] = [line]; continue; }
    if (/^## /.test(line)) { key = null; emp = null; continue; }
    const h3 = /^### Employee \d: (.+)$/.exec(line);
    if (key === '2' && h3) { emp = h3[1].trim(); employees[emp] = [line]; continue; }
    if (emp) employees[emp].push(line);
    else if (key) sections[key].push(line);
  }
  const trim = (arr) => arr.join('\n').replace(/\s+$/, '') + '\n';
  return { shared: ['1', '3', '4', '5', '6', '7'].map((k) => trim(sections[k] ?? [])).join('\n'), employees: Object.fromEntries(Object.entries(employees).map(([k, v]) => [k, trim(v)])) };
}

export const skillText = (shared) =>
  `---\nname: ${ORGANIZATION_SKILL}\ndescription: The AI employee organization this office runs under — mission, workflow (eight gates), collaboration rules, project memory, operating principles, definition of success. The user's words, verbatim, from plan/ai-employees/organization.md; preloaded by every employee.\n---\n\n# The organization (verbatim; the source is plan/ai-employees/organization.md)\n\n${shared}`;

// One employee's charter head: the organization's section for its role,
// between the markers, byte for byte. Returns the file when it changed.
function fillCharter(name, employees) {
  const p = profile(name);
  const section = employees[ROLES[p.role]];
  if (!section) return null; // George: no organization section
  const file = agentFile(name);
  if (!existsSync(file)) return null;
  const text = readText(file);
  const b = text.indexOf(ORG_BEGIN); const e = text.indexOf(ORG_END);
  if (b < 0 || e < 0 || e < b) return null;
  const next = text.slice(0, b + ORG_BEGIN.length) + '\n' + section + ORG_END + text.slice(e + ORG_END.length);
  if (next === text) return null;
  writeFileSync(file, next);
  return file;
}

function organizationUnlocked() {
  const { shared, employees } = organizationSections();
  const changed = [];
  mkdirSync(dirname(organizationSkill()), { recursive: true });
  const skill = skillText(shared);
  if (!existsSync(organizationSkill()) || readText(organizationSkill()) !== skill) { writeFileSync(organizationSkill(), skill); changed.push(organizationSkill()); }
  for (const name of roster()) { const f = fillCharter(name, employees); if (f) changed.push(f); }
  return { changed, employees: Object.keys(employees) };
}

// ---------------------------------------------------------------- index

// The mechanical digests (Rule 2): one line per decision and per open risk,
// from the headings of decisions.md and risks.md, with the line to jump to;
// and the watermark, the commit and the record files' line counts the
// digests were built from. George's other digests are hers to write.
const HEADING = /^## ((?:D|R)-\d+) · (.+?) · \*\*(.+?)\*\*/;

function indexUnlocked(name = 'george') {
  mustBeEmployee(name, 'the name');
  const notes = join(employeeDir(name), 'notes');
  mkdirSync(notes, { recursive: true });
  const headings = (file) => readText(join(repo(), file)).split(/\r?\n/).flatMap((line, i) => { const m = HEADING.exec(line); return m ? [{ id: m[1], title: m[2], status: m[3], line: i + 1 }] : []; });
  const decisions = headings('decisions.md');
  const risks = headings('risks.md');
  const open = risks.filter((r) => !/\bclosed\b/i.test(r.status));
  const row = (file) => (h) => `- ${h.id} · ${h.title} · ${h.status} · ${file}:${h.line}`;
  writeFileSync(join(notes, 'decisions-index.md'), [`# Every decision, one line (generated by \`office.mjs index\`, ${today()})`, '', ...decisions.map(row('decisions.md')), ''].join('\n'));
  writeFileSync(join(notes, 'risks-open.md'), [`# Open risks (generated by \`office.mjs index\`, ${today()}; "closed" in the status heading means closed)`, '', ...open.map(row('risks.md')), ''].join('\n'));
  let commit = null;
  try { commit = execSync('git rev-parse --short HEAD', { cwd: repo(), stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { /* no git here: the tests' temporary repo */ }
  const files = Object.fromEntries(RECORD_FILES.filter((f) => existsSync(join(repo(), f))).map((f) => [f, readText(join(repo(), f)).split(/\r?\n/).length]));
  writeJson(join(notes, 'watermark.json'), { commit, built: now().toISOString(), files });
  return { decisions: decisions.length, risks: risks.length, open: open.length, commit, files };
}

// ---------------------------------------------------------------- check

export function check() {
  const problems = [];
  const names = roster();
  const agents = existsSync(agentsDir()) ? readdirSync(agentsDir()).filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3)).sort() : [];
  for (const n of names) if (!agents.includes(n)) problems.push(`${n} has an office folder and no .claude/agents/${n}.md`);
  for (const a of agents) if (!names.includes(a)) problems.push(`.claude/agents/${a}.md has no office folder`);
  const skillExists = existsSync(organizationSkill());
  const org = existsSync(organizationFile()) ? organizationSections() : null;
  if (org && skillExists && readText(organizationSkill()) !== skillText(org.shared)) problems.push(`${ORGANIZATION_SKILL}/SKILL.md differs from plan/ai-employees/organization.md (run office.mjs organization)`);
  const ids = new Map();
  let maxTask = 0; let maxMessage = 0;
  const boards = [];
  for (const n of names) {
    const dir = employeeDir(n);
    for (const f of ['profile.json', 'avatar.svg', 'board.md', 'inbox.md']) if (!existsSync(join(dir, f))) problems.push(`${n} has no ${f}`);
    if (!existsSync(join(dir, 'profile.json'))) continue;
    const p = profile(n);
    if (p.name !== n) problems.push(`${n}/profile.json says name "${p.name}"`);
    if (!ROLES[p.role]) problems.push(`${n}/profile.json has no known role ("${p.role}")`);
    if (!p.guard || typeof p.guard !== 'object' || !p.guard.kind) problems.push(`${n}/profile.json has no guard object`);
    else { try { guardKind(p.guard.kind); } catch (e) { problems.push(`${n}: ${e.message}`); } }
    if (agents.includes(n)) {
      const text = readText(agentFile(n));
      // Measured 2026-10-28 (office-app Phase 5): with CRLF endings Claude
      // Code silently drops an agent whose description holds ": " (seven of
      // ten: "--agent 'ivy' not found"); .gitattributes keeps them LF.
      if (readFileSync(agentFile(n), 'utf8').includes('\r\n')) problems.push(`.claude/agents/${n}.md has CRLF line endings: Claude Code drops such an agent when its description holds ": " (.gitattributes says eol=lf)`);
      const fm = parseFrontmatter(text);
      if (!fm) problems.push(`.claude/agents/${n}.md has no frontmatter`);
      else {
        if (fm.values.name !== n) problems.push(`.claude/agents/${n}.md says name "${fm.values.name}"`);
        for (const k of fm.keys) if (!KNOWN_FRONTMATTER.includes(k)) problems.push(`.claude/agents/${n}.md has an unknown frontmatter key "${k}" (Claude Code ignores it silently)`);
        if (!text.includes(GUARD_COMMAND)) problems.push(`${n}'s agent file has no guard hook`);
        if (fm.keys.includes('memory')) problems.push(`${n} has memory: (it grants Write and Edit outside the guard)`);
        if (fm.keys.includes('isolation')) problems.push(`${n} has isolation: (a worktree would swallow the notes)`);
        if (skillExists && !(fm.lists.skills ?? []).includes(ORGANIZATION_SKILL)) problems.push(`${n} does not preload the ${ORGANIZATION_SKILL} skill (Rule 12)`);
        if (n !== MEMORY && names.includes(MEMORY) && !text.includes(REPORT_LINE)) problems.push(`${n}'s charter does not carry the line that reports to ${MEMORY}`);
        if (skillExists && !text.includes(ORG_READ_LINE)) problems.push(`${n}'s charter does not open with the line that reads the ${ORGANIZATION_SKILL} skill under --agent`);
        const kind = p.guard?.kind ?? '';
        if (EXPLICIT_TOOLS(kind)) {
          const tools = (fm.values.tools ?? '').split(',').map((s) => s.trim()).filter(Boolean);
          if (!tools.length) problems.push(`${n} (${kind}) has no explicit tools list`);
          if (tools.includes('Skill')) problems.push(`${n} (${kind}) reaches Skill`);
          for (const t of tools.filter((t) => t.startsWith('mcp__'))) if (!(p.tools ?? []).includes(t)) problems.push(`${n} reaches ${t}, which its profile does not name`);
        }
        if (org && p.role !== 'project-intelligence') {
          const section = org.employees[ROLES[p.role]];
          const b = text.indexOf(ORG_BEGIN); const e = text.indexOf(ORG_END);
          if (b < 0 || e < 0) problems.push(`${n}'s charter has no organization markers`);
          else if (section && text.slice(b + ORG_BEGIN.length, e) !== '\n' + section) problems.push(`${n}'s charter head differs from the organization's "${ROLES[p.role]}" section (run office.mjs organization)`);
        }
      }
    }
    if (existsSync(join(dir, 'board.md'))) {
      const { board, problems: bp } = parseBoard(readText(join(dir, 'board.md')));
      for (const x of bp) problems.push(`${n}'s board: ${x}`);
      boards.push({ name: n, board });
      for (const s of SECTIONS) for (const t of board[s]) {
        if (ids.has(t.id)) problems.push(`${t.id} is on two boards (${ids.get(t.id)} and ${n})`); else ids.set(t.id, n);
        maxTask = Math.max(maxTask, Number(t.id.slice(2)));
        if (t.from !== 'user' && !names.includes(t.from)) problems.push(`${t.id} is from "${t.from}", who does not work here`);
      }
    }
    if (n === MEMORY && existsSync(reportsFile())) for (const x of parseReports(readText(reportsFile())).problems) problems.push(`${n}'s reports: ${x}`);
    if (existsSync(join(dir, 'inbox.md'))) {
      const { messages, problems: ip } = parseInbox(readText(join(dir, 'inbox.md')));
      for (const x of ip) problems.push(`${n}'s inbox: ${x}`);
      for (const m of messages) maxMessage = Math.max(maxMessage, Number(m.id.slice(2)));
    }
  }
  const seq = existsSync(sequenceFile()) ? readJson(sequenceFile()) : { task: 0, message: 0 };
  if (seq.task < maxTask) problems.push(`sequence.json says task ${seq.task}, a board holds T-${String(maxTask).padStart(3, '0')}`);
  if (seq.message < maxMessage) problems.push(`sequence.json says message ${seq.message}, an inbox holds M-${String(maxMessage).padStart(3, '0')}`);
  if (existsSync(pipelineFile())) {
    const { ideas, problems: pp } = parsePipeline(readText(pipelineFile()));
    for (const x of pp) problems.push(`the pipeline: ${x}`);
    for (const i of ideas) {
      const derived = statusOf(i, boards);
      if (i.status !== derived) problems.push(`${i.slug} says ${i.status}; the gates say ${derived}`);
      for (const g of i.gates) {
        if (!GATES[g.gate]) problems.push(`${i.slug}: unknown gate "${g.gate}"`);
        if (g.file && !existsSync(join(repo(), g.file))) problems.push(`${i.slug}: ${g.gate} names ${g.file}, which does not exist (Rule 10)`);
      }
      for (const t of boards.flatMap(({ board }) => SECTIONS.flatMap((s) => board[s]))) if (t.idea && !ideas.some((x) => x.slug === t.idea)) problems.push(`${t.id} names idea "${t.idea}", which is not on the pipeline`);
    }
  }
  let settings = {};
  try { settings = readJson(settingsFile()); } catch { problems.push('.claude/settings.json is missing or not JSON'); }
  for (const pl of REQUIRED_PLUGINS) if (settings.enabledPlugins?.[pl] !== true) problems.push(`plugin ${pl} is not enabled in .claude/settings.json`);
  if (names.length && !JSON.stringify(settings.hooks ?? {}).includes(GUARD_COMMAND)) problems.push(`employees exist (${names.join(', ')}) and .claude/settings.json has no guard mirror (Rule 1)`);
  return problems;
}

// ---------------------------------------------------------------- the session index (plan/office-app.md § 3.1)

// One line per chat an employee has had through the office app: its
// Claude Code session id, when it started, its first words as a title, how
// many turns and what they cost. No transcript: Claude Code keeps that in
// ~/.claude/projects/, and two copies would disagree.
const sessionsFile = (name) => join(employeeDir(name), 'sessions.json');
export function sessions(name) {
  mustBeEmployee(name, 'the name');
  return existsSync(sessionsFile(name)) ? readJson(sessionsFile(name)) : [];
}
function sessionTurnUnlocked(name, { id, title, usd = 0 }) {
  mustBeEmployee(name, 'the name');
  if (!/^[0-9a-f-]{36}$/.test(id ?? '')) throw new Error(`a session id is a uuid, not "${id}"`);
  const list = sessions(name);
  const at = now().toISOString();
  const s = list.find((x) => x.id === id);
  // `log` is one { at, usd } per turn, so "spent today" (office-app Rule 5)
  // is a sum of today's turns, not of whole sessions that began yesterday.
  if (s) { s.turns += 1; s.usd = Math.round((s.usd + usd) * 1e6) / 1e6; s.last = at; (s.log ??= []).push({ at, usd }); }
  else list.push({ id, started: at, title: (title ?? '').replace(/\s+/g, ' ').trim().slice(0, 80) || '(untitled)', turns: 1, usd: Math.round(usd * 1e6) / 1e6, last: at, log: [{ at, usd }] });
  writeJson(sessionsFile(name), list);
  return list.find((x) => x.id === id);
}

// ---------------------------------------------------------------- the snapshot (plan/office-app.md Rule 3)

// The whole office as JSON, parsed by the same parsers `check` uses, so the
// page cannot show a board the files do not hold. A board or inbox that
// does not parse is reported in `problems`, never guessed.
export function snapshot() {
  const employees = roster().map((name) => {
    const p = profile(name);
    const b = existsSync(boardFile(name)) ? parseBoard(readText(boardFile(name))) : { board: Object.fromEntries(SECTIONS.map((s) => [s, []])), problems: [] };
    const i = existsSync(inboxFile(name)) ? parseInbox(readText(inboxFile(name))) : { messages: [], problems: [] };
    return {
      name, title: p.title, role: p.role, pronouns: p.pronouns, colour: p.colour, colourHex: COLOURS[p.colour] ?? COLOURS.blue,
      guard: p.guard ?? null, board: b.board, inbox: i.messages, unread: i.messages.filter((m) => !m.read).length,
      sessions: existsSync(sessionsFile(name)) ? readJson(sessionsFile(name)) : [],
    };
  });
  const boards = employees.map((e) => ({ name: e.name, board: e.board }));
  const ideas = existsSync(pipelineFile()) ? loadPipeline().map((i) => ({ ...i, status: statusOf(i, boards) })) : [];
  return { employees, ideas, sections: SECTIONS, ladder: LADDER, problems: check() };
}

export const hire = locked(hireUnlocked);
export const taskAdd = locked(taskAddUnlocked);
export const taskMove = locked(taskMoveUnlocked);
export const msg = locked(msgUnlocked);
export const inbox = locked(inboxUnlocked);
export const ideaAdd = locked(ideaAddUnlocked);
export const gate = locked(gateUnlocked);
export const organization = locked(organizationUnlocked);
export const index = locked(indexUnlocked);
export const sessionTurn = locked(sessionTurnUnlocked);
export const report = locked(reportUnlocked);
export const reports = locked(reportsUnlocked);

// ---------------------------------------------------------------- the command line

const parseArgs = (argv) => {
  const positional = []; const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') continue;
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) { flags[key] = next; i++; } else flags[key] = true;
    } else positional.push(a);
  }
  return { positional, flags };
};
const list = (v) => (typeof v === 'string' ? v.split(',').map((s) => s.trim()).filter(Boolean) : []);

export function main(argv) {
  const { positional, flags } = parseArgs(argv);
  const [command, ...rest] = positional;
  switch (command) {
    case 'hire': {
      const r = hire({ name: rest[0], title: rest[1], role: flags.role, colour: flags.colour ?? flags.color, model: flags.model, pronouns: flags.pronouns, guard: flags.guard, tools: list(flags.tools), skills: list(flags.skills) });
      return `${r.name} hired as ${r.title} (${r.role}): ${r.files.join(' and ')}. Now write the charter in the agent file (office.mjs organization fills the organization's part).`;
    }
    case 'task': {
      const [sub] = rest;
      if (sub === 'add') { const t = taskAdd({ to: flags.to, from: flags.from, title: rest[1], why: flags.why, doing: flags.doing === true, idea: typeof flags.idea === 'string' ? flags.idea : undefined }); return `${t.id} on ${t.to}'s board (${t.section}): ${t.title}`; }
      if (sub === 'move') { const t = taskMove(rest[1], rest[2], { note: flags.note }); return `${t.id} on ${t.name}'s board: ${t.from} → ${t.to}`; }
      if (sub === 'list') { const l = taskList(rest[1], { all: flags.all === true }); return flags.json === true ? JSON.stringify(l, null, 2) : boardWords(l); }
      throw new Error('task add | move | list');
    }
    case 'msg': { const m = msg({ to: flags.to, from: flags.from, text: rest[0] }); return `${m.id} to ${m.to} from ${m.from}`; }
    case 'inbox': {
      const l = inbox(rest[0], { ack: typeof flags.ack === 'string' ? flags.ack : undefined, ackAll: flags['ack-all'] === true });
      return l.length ? l.map((m) => `${m.read ? '[x]' : '[ ]'} ${m.id} · ${m.at} · from ${m.from} · ${m.text}`).join('\n') : `${rest[0]}'s inbox is empty`;
    }
    case 'report': { const r = report({ from: flags.from, text: rest[0] }); return `reported to ${MEMORY} from ${r.from}`; }
    case 'reports': {
      const l = reports({ ackAll: flags['ack-all'] === true });
      const shown = flags.all === true ? l : l.filter((r) => !r.read || flags['ack-all'] === true);
      return shown.length ? shown.map((r) => `${r.read ? '[x]' : '[ ]'} ${r.at} · from ${r.from} · ${r.kind} · ${r.text}`).join('\n') : 'no unread reports';
    }
    case 'index': { const r = index(rest[0]); return `indexed ${r.decisions} decisions and ${r.open} open risks of ${r.risks}; watermark at ${r.commit ?? '(no git)'}`; }
    case 'idea': {
      if (rest[0] !== 'add') throw new Error('idea add <slug> "<title>" --from <who> [--lane full|short]');
      const i = ideaAdd({ slug: rest[1], title: rest[2], from: flags.from, lane: typeof flags.lane === 'string' ? flags.lane : 'full' });
      return `${i.slug} on the pipeline (${i.lane} lane): ${i.status}`;
    }
    case 'gate': {
      const g = gate({ slug: rest[0], gate: rest[1], by: flags.by, verdict: flags.verdict, file: typeof flags.file === 'string' ? flags.file : undefined, note: typeof flags.note === 'string' ? flags.note : undefined, override: flags.override === true });
      return `${g.slug} · ${g.gate} · ${g.verdict} · by ${g.by}${g.override ? ' · override' : ''} → ${g.status}`;
    }
    case 'pipeline': { const p = pipeline(rest[0]); return flags.json === true ? JSON.stringify(p, null, 2) : pipelineWords(p); }
    case 'organization': { const r = organization(); return r.changed.length ? `copied the organization into: ${r.changed.join(', ')}` : `the skill and ${r.employees.length} sections are already verbatim`; }
    case 'check': { const problems = check(); if (problems.length) { process.exitCode = 1; return problems.map((p) => `✘ ${p}`).join('\n'); } return `✔ the office is consistent: ${roster().length} employee(s), ${REQUIRED_PLUGINS.length} plugins enabled, ${pipeline().length} idea(s) on the pipeline`; }
    default: throw new Error('office.mjs hire | task | msg | inbox | report | reports | index | idea | gate | pipeline | organization | check');
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(main(process.argv.slice(2))); } catch (e) { console.error(`office.mjs: ${e.message}`); process.exitCode = 1; }
}
