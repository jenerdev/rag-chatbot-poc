// office.test.mjs — node --test office/office.test.mjs
//
// Every test runs against a TEMPORARY repository (OFFICE_REPO), never this
// one: a hire, a task, a message, an idea, a gate, the index and the check
// all leave the real office untouched. The guard is tested through judge(),
// pure, for every kind of Rule 11, and once end to end as a process on
// stdin.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { beforeEach, afterEach, describe, test } from 'node:test';

import {
  check, gate, guardKind, hire, ideaAdd, inbox, index, msg, organization, parseBoard, parseFrontmatter, parsePipeline, pipeline, renderBoard, renderPipeline,
  taskAdd, taskList, taskMove, REQUIRED_PLUGINS, GUARD_COMMAND, SECTIONS, ORG_BEGIN, ORG_END, ORG_READ_LINE, ORGANIZATION_SKILL, withLock, sessions, sessionTurn, snapshot, LOCK_STALE_MS,
} from './office.mjs';
import { guardOf, judge } from './hooks/guard.mjs';

let repo;
const settings = (extra = {}) => ({ enabledPlugins: Object.fromEntries(REQUIRED_PLUGINS.map((p) => [p, true])), hooks: { PreToolUse: [{ matcher: 'Write|Edit|NotebookEdit|Bash', hooks: [{ type: 'command', command: GUARD_COMMAND }] }] }, ...extra });

const ORG = `# The organization

## 1. Mission

Transform ideas.

## 2. AI Employees and Responsibilities

### Employee 1: Idea Strategist

**Mission:** Evaluate ideas.

- APPROVE or REJECT.

### Employee 6: Full-Stack Engineer

**Mission:** Build it.

## 3. Employee Workflow

Eight phases.

## 4. Collaboration and Decision-Making Rules

1. Respect boundaries.

## 5. Project Context and Memory

Track it.

## 6. General Operating Principles

- Evidence over assumptions.

## 7. Definition of Success

Done when done.

## The user's recommendation before implementing

Not part of the skill.
`;

const george = () => hire({ name: 'george', title: 'Project Intelligence', role: 'project-intelligence', colour: 'blue', pronouns: 'she/her' });
const ivy = () => hire({ name: 'ivy', title: 'Idea Strategist', role: 'idea-strategist', guard: 'author:product', colour: 'yellow', tools: ['mcp__plugin_context7_context7'] });
const finn = () => hire({ name: 'finn', title: 'Full-Stack Engineer', role: 'full-stack-engineer', guard: 'builder', colour: 'green', skills: ['project-record'] });
const quinn = () => hire({ name: 'quinn', title: 'QA Engineer', role: 'qa-engineer', guard: 'tester', colour: 'red' });
const theo = () => hire({ name: 'theo', title: 'Technical Architect', role: 'technical-architect', guard: 'author:architecture', colour: 'cyan' });
const sage = () => hire({ name: 'sage', title: 'Security Reviewer', role: 'security-reviewer', guard: 'author:security', colour: 'red' });
const rhea = () => hire({ name: 'rhea', title: 'Product Requirements Analyst', role: 'product-requirements-analyst', guard: 'author:requirements', colour: 'orange' });
const lex = () => hire({ name: 'lex', title: 'Legal Reviewer', role: 'legal-reviewer', guard: 'author:legal', colour: 'purple' });

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'office-'));
  mkdirSync(join(repo, '.claude'), { recursive: true });
  mkdirSync(join(repo, 'office'), { recursive: true });
  mkdirSync(join(repo, 'plan', 'ai-employees'), { recursive: true });
  writeFileSync(join(repo, '.claude', 'settings.json'), JSON.stringify(settings()));
  writeFileSync(join(repo, 'decisions.md'), '# Decisions\n\n## D-001 · No RAG framework · **Settled**\n\ntext\n\n## D-002 · Raw fetch · **Settled**\n');
  writeFileSync(join(repo, 'risks.md'), '# Risks\n\n## R-1 · A key leaks · **High**\n\n## R-2 · Old price · **Closed 2026-09-28 (D-074)**\n\n## R-3 · Open one · **Low**\n');
  writeFileSync(join(repo, 'status.md'), 'a\nb\nc\n');
  writeFileSync(join(repo, 'whats-done.md'), '# Done\n');
  writeFileSync(join(repo, 'plan', 'ai-employees', 'organization.md'), ORG);
  process.env.OFFICE_REPO = repo;
  process.env.OFFICE_NOW = '2026-10-27T09:12:00';
});
afterEach(() => { delete process.env.OFFICE_REPO; delete process.env.OFFICE_NOW; rmSync(repo, { recursive: true, force: true }); });

describe('hire', () => {
  test('writes the agent file and the office folder, and refuses a second hire of the name', () => {
    const r = george();
    assert.equal(r.name, 'george');
    for (const f of ['profile.json', 'avatar.svg', 'board.md', 'inbox.md', 'notes/README.md']) assert.ok(existsSync(join(repo, 'office', 'employees', 'george', f)), f);
    const agent = readFileSync(join(repo, '.claude', 'agents', 'george.md'), 'utf8');
    const fm = parseFrontmatter(agent);
    assert.equal(fm.values.name, 'george');
    assert.equal(fm.values.tools, 'Read, Grep, Glob, Bash, Edit, Write, SendMessage');
    assert.deepEqual(fm.lists.skills, [ORGANIZATION_SKILL]);
    assert.ok(agent.includes(GUARD_COMMAND), 'the guard is in the frontmatter');
    const p = JSON.parse(readFileSync(join(repo, 'office', 'employees', 'george', 'profile.json'), 'utf8'));
    assert.equal(p.role, 'project-intelligence'); assert.equal(p.pronouns, 'she/her'); assert.equal(p.guard.kind, 'read-only');
    assert.deepEqual(p.guard.writes, ['office/']);
    assert.ok(readFileSync(join(repo, 'office', 'employees', 'george', 'avatar.svg'), 'utf8').includes('>G<'));
    assert.throws(() => george(), /already works here/);
    assert.throws(() => hire({ name: 'George', title: 'x', role: 'idea-strategist' }), /lowercase/);
    assert.throws(() => hire({ name: 'x', title: 'x', role: 'idea-strategist', colour: 'teal' }), /colour is one of/);
    assert.throws(() => hire({ name: 'x', title: 'x', role: 'barista' }), /--role is one of/);
    assert.throws(() => hire({ name: 'x', title: 'x', role: 'idea-strategist', guard: 'author' }), /--guard is/);
  });
  test('an author gets its folder, the named MCP tools and the organization markers; a builder and a tester get every tool', () => {
    ivy(); finn(); quinn(); theo(); sage();
    const ivyText = readFileSync(join(repo, '.claude', 'agents', 'ivy.md'), 'utf8');
    assert.equal(parseFrontmatter(ivyText).values.tools, 'Read, Grep, Glob, Bash, Edit, Write, SendMessage, mcp__plugin_context7_context7');
    assert.ok(ivyText.includes(ORG_BEGIN) && ivyText.includes(ORG_END) && ivyText.includes('## What the house adds'));
    const finnText = readFileSync(join(repo, '.claude', 'agents', 'finn.md'), 'utf8');
    assert.equal(parseFrontmatter(finnText).values.tools, undefined);
    assert.deepEqual(parseFrontmatter(finnText).lists.skills, [ORGANIZATION_SKILL, 'project-record']);
    assert.ok(finnText.includes(GUARD_COMMAND));
    assert.deepEqual(guardKind('author:architecture').writes, ['office/', 'plan/', 'decisions.md', 'risks.md']);
    assert.ok(guardKind('author:security').bashAllow.includes('pnpm audit'));
    assert.equal(guardKind('tester').bash, 'deny');
    assert.deepEqual(guardKind('builder').writes, ['/']);
  });
});

describe('the board', () => {
  beforeEach(() => { george(); finn(); });

  test('a task is born in the inbox with the next id, moves, and closes with a note', () => {
    const a = taskAdd({ to: 'finn', from: 'george', title: 'Pin the region', why: 'D-149' });
    assert.equal(a.id, 'T-001'); assert.equal(a.section, 'inbox'); assert.equal(a.date, '2026-10-27');
    const b = taskAdd({ to: 'finn', from: 'user', title: 'Second', why: 'because', doing: true });
    assert.equal(b.id, 'T-002'); assert.equal(b.section, 'doing');
    assert.throws(() => taskMove('T-001', 'done'), /--note/);
    taskMove('T-001', 'doing');
    const closed = taskMove('T-001', 'done', { note: 'walk 5/5' });
    assert.equal(closed.from, 'doing');
    const [{ board }] = taskList('finn', { all: true });
    assert.deepEqual(board.done, [{ id: 'T-001', date: '2026-10-27', from: 'george', title: 'Pin the region', why: 'D-149', closedAs: 'done', closedOn: '2026-10-27', note: 'walk 5/5' }]);
    assert.deepEqual(board.doing.map((t) => t.id), ['T-002']);
    assert.throws(() => taskMove('T-001', 'doing'), /already done/);
    assert.throws(() => taskMove('T-009', 'doing'), /no task T-009/);
    assert.throws(() => taskAdd({ to: 'nobody', from: 'george', title: 'x', why: 'y' }), /no employee "nobody"/);
    assert.throws(() => taskAdd({ to: 'finn', from: 'ghost', title: 'x', why: 'y' }), /no employee "ghost"/);
    assert.throws(() => taskAdd({ to: 'finn', from: 'user', title: 'a · b', why: 'y' }), /separator/);
    assert.throws(() => taskAdd({ to: 'finn', from: 'user', title: 'x', why: 'y', idea: 'nope' }), /no idea "nope"/);
    assert.equal(JSON.parse(readFileSync(join(repo, 'office', 'sequence.json'), 'utf8')).task, 2);
    assert.deepEqual(check(), []);
  });

  test('the board round-trips through its one line shape, idea included', () => {
    ideaAdd({ slug: 'analytics', title: 'GA', from: 'user' });
    taskAdd({ to: 'george', from: 'user', title: 'Brief', why: 'the plan', idea: 'analytics' });
    taskMove('T-001', 'dropped', { note: 'not needed' });
    const text = readFileSync(join(repo, 'office', 'employees', 'george', 'board.md'), 'utf8');
    const { board, problems } = parseBoard(text);
    assert.deepEqual(problems, []);
    assert.equal(board.dropped[0].idea, 'analytics');
    assert.equal(renderBoard(board, 'george'), text);
    assert.deepEqual(SECTIONS, ['doing', 'inbox', 'done', 'dropped']);
    const bad = parseBoard('## Doing\n- T-001 · not a task\n## Weird\n');
    assert.equal(bad.problems.length, 2);
  });
});

describe('the inbox', () => {
  beforeEach(() => { george(); });
  test('a message is appended with the next id and acknowledged in place', () => {
    const m = msg({ to: 'george', from: 'user', text: 'T-001 is yours' });
    assert.equal(m.id, 'M-001'); assert.equal(m.at, '2026-10-27 09:12');
    msg({ to: 'george', from: 'user', text: 'and this' });
    assert.deepEqual(inbox('george').map((x) => x.read), [false, false]);
    inbox('george', { ack: 'M-001' });
    assert.deepEqual(inbox('george').map((x) => x.read), [true, false]);
    assert.throws(() => inbox('george', { ack: 'M-099' }), /no message M-099/);
    inbox('george', { ackAll: true });
    assert.deepEqual(inbox('george').map((x) => x.read), [true, true]);
    assert.ok(readFileSync(join(repo, 'office', 'employees', 'george', 'inbox.md'), 'utf8').includes('- [x] M-002 · 2026-10-27 09:12 · from user · and this'));
    assert.deepEqual(check(), []);
  });
});

describe('the pipeline', () => {
  beforeEach(() => { george(); ivy(); rhea(); theo(); finn(); quinn(); sage(); lex(); mkdirSync(join(repo, 'docs', 'product'), { recursive: true }); writeFileSync(join(repo, 'docs', 'product', 'analytics.md'), '# GA\n'); });
  const touch = (p) => { mkdirSync(join(repo, p, '..'), { recursive: true }); writeFileSync(join(repo, p), 'x\n'); };

  test('an idea is Planned, then Approved by the strategist, and nothing passes a gate before its predecessor', () => {
    const i = ideaAdd({ slug: 'analytics', title: 'Google Analytics', from: 'user' });
    assert.equal(i.status, 'Planned');
    assert.throws(() => ideaAdd({ slug: 'analytics', title: 'x', from: 'user' }), /already on the pipeline/);
    assert.throws(() => ideaAdd({ slug: 'Bad Slug', title: 'x', from: 'user' }), /slug/);
    assert.throws(() => gate({ slug: 'analytics', gate: 'requirements', by: 'rhea', verdict: 'DONE', file: 'docs/product/analytics.md' }), /requirements before idea has passed/);
    assert.throws(() => gate({ slug: 'analytics', gate: 'idea', by: 'rhea', verdict: 'APPROVE', file: 'docs/product/analytics.md' }), /does not own the idea gate/);
    assert.throws(() => gate({ slug: 'analytics', gate: 'idea', by: 'ivy', verdict: 'YES', file: 'docs/product/analytics.md' }), /writes APPROVE \/ REVISE \/ RESEARCH \/ REJECT/);
    assert.throws(() => gate({ slug: 'analytics', gate: 'idea', by: 'ivy', verdict: 'APPROVE' }), /--file/);
    assert.throws(() => gate({ slug: 'analytics', gate: 'idea', by: 'ivy', verdict: 'APPROVE', file: 'docs/product/missing.md' }), /does not exist/);
    const g = gate({ slug: 'analytics', gate: 'idea', by: 'ivy', verdict: 'APPROVE', file: 'docs/product/analytics.md', note: 'solves a real problem' });
    assert.equal(g.status, 'Approved');
    assert.deepEqual(check(), []);
  });

  test('the ladder climbs with the gates, In progress reads the boards, and the user may override', () => {
    ideaAdd({ slug: 'analytics', title: 'GA', from: 'user' });
    gate({ slug: 'analytics', gate: 'idea', by: 'ivy', verdict: 'APPROVE', file: 'docs/product/analytics.md' });
    touch('docs/requirements/analytics.md');
    gate({ slug: 'analytics', gate: 'requirements', by: 'rhea', verdict: 'DONE', file: 'docs/requirements/analytics.md' });
    assert.equal(pipeline('analytics')[0].status, 'Approved', 'DONE is not APPROVE');
    gate({ slug: 'analytics', gate: 'requirements', by: 'user', verdict: 'APPROVE' });
    touch('plan/analytics.md');
    gate({ slug: 'analytics', gate: 'architecture', by: 'theo', verdict: 'SUBMITTED', file: 'plan/analytics.md' });
    gate({ slug: 'analytics', gate: 'architecture', by: 'sage', verdict: 'CLEAR', file: 'plan/analytics.md' });
    assert.throws(() => gate({ slug: 'analytics', gate: 'implementation', by: 'finn', verdict: 'DONE', file: 'whats-done.md' }), /implementation before architecture/);
    gate({ slug: 'analytics', gate: 'architecture', by: 'user', verdict: 'APPROVE' });
    taskAdd({ to: 'finn', from: 'george', title: 'Build GA', why: 'plan/analytics.md', idea: 'analytics', doing: true });
    assert.equal(pipeline('analytics')[0].status, 'In progress');
    gate({ slug: 'analytics', gate: 'implementation', by: 'finn', verdict: 'DONE', file: 'whats-done.md', note: '2026-10-28 GA' });
    assert.equal(pipeline('analytics')[0].status, 'Implemented');
    touch('docs/qa/analytics.md');
    gate({ slug: 'analytics', gate: 'qa', by: 'quinn', verdict: 'PASS', file: 'docs/qa/analytics.md' });
    assert.equal(pipeline('analytics')[0].status, 'Tested');
    touch('docs/security/analytics.md'); touch('docs/legal/analytics.md');
    gate({ slug: 'analytics', gate: 'security', by: 'sage', verdict: 'FINDINGS:HIGH', file: 'docs/security/analytics.md' });
    gate({ slug: 'analytics', gate: 'legal', by: 'lex', verdict: 'CLEAR', file: 'docs/legal/analytics.md' });
    assert.equal(pipeline('analytics')[0].status, 'Tested', 'a HIGH finding is not Reviewed');
    gate({ slug: 'analytics', gate: 'security', by: 'user', verdict: 'ACCEPTED', note: 'the HIGH is the CDN script; accepted for the pilot' });
    assert.equal(pipeline('analytics')[0].status, 'Reviewed');
    gate({ slug: 'analytics', gate: 'release', by: 'quinn', verdict: 'READY WITH DOCUMENTED RISKS', file: 'docs/qa/analytics.md' });
    assert.throws(() => gate({ slug: 'analytics', gate: 'released', by: 'finn', verdict: 'RELEASED' }), /does not own/);
    gate({ slug: 'analytics', gate: 'released', by: 'user', verdict: 'RELEASED', note: 'abc1234' });
    assert.equal(pipeline('analytics')[0].status, 'Released');
    // the short lane: Approved at birth, implementation first, qa, release
    ideaAdd({ slug: 'free-field', title: 'The field on screen', from: 'george', lane: 'short' });
    assert.equal(pipeline('free-field')[0].status, 'Approved');
    gate({ slug: 'free-field', gate: 'implementation', by: 'finn', verdict: 'DONE', file: 'whats-done.md' });
    touch('docs/qa/free-field.md');
    gate({ slug: 'free-field', gate: 'qa', by: 'quinn', verdict: 'PASS', file: 'docs/qa/free-field.md' });
    assert.equal(pipeline('free-field')[0].status, 'Reviewed', 'short lane: no security or legal asked');
    // the override, the user's alone, recorded
    ideaAdd({ slug: 'rush', title: 'Rushed', from: 'user' });
    assert.throws(() => gate({ slug: 'rush', gate: 'requirements', by: 'rhea', verdict: 'DONE', file: 'docs/product/analytics.md', override: true }), /only the user/);
    const o = gate({ slug: 'rush', gate: 'requirements', by: 'user', verdict: 'APPROVE', override: true, note: 'the user said so' });
    assert.equal(o.override, true);
    const text = readFileSync(join(repo, 'office', 'pipeline.md'), 'utf8');
    assert.ok(text.includes('- requirements · APPROVE · by user · 2026-10-27 · note: the user said so · override'));
    const parsed = parsePipeline(text);
    assert.deepEqual(parsed.problems, []);
    assert.equal(renderPipeline(parsed.ideas), text);
    assert.deepEqual(check(), []);
    // a status typed by hand is caught
    writeFileSync(join(repo, 'office', 'pipeline.md'), text.replace('· **Released**', '· **Planned**'));
    assert.ok(check().some((p) => p.includes('analytics says Planned; the gates say Released')));
  });
});

describe('the organization', () => {
  test('the skill and the charters are the file, verbatim, and check sees drift', () => {
    george(); ivy(); finn();
    const ivyText = readFileSync(join(repo, '.claude', 'agents', 'ivy.md'), 'utf8');
    assert.ok(ivyText.includes('### Employee 1: Idea Strategist\n\n**Mission:** Evaluate ideas.\n\n- APPROVE or REJECT.\n'), 'a hire is born with its section');
    const r = organization();
    assert.ok(r.changed.some((f) => f.endsWith('SKILL.md')) && r.changed.length === 1, 'the first run writes the skill and nothing else');
    const skill = readFileSync(join(repo, '.claude', 'skills', ORGANIZATION_SKILL, 'SKILL.md'), 'utf8');
    assert.ok(skill.includes('## 1. Mission') && skill.includes('## 7. Definition of Success') && !skill.includes('Employee 1') && !skill.includes('recommendation'));
    assert.ok(!ivyText.includes('Full-Stack'));
    assert.deepEqual(organization().changed, [], 'a second run changes nothing');
    assert.deepEqual(check(), []);
    writeFileSync(join(repo, 'plan', 'ai-employees', 'organization.md'), ORG.replace('Evaluate ideas.', 'Evaluate ideas well.'));
    const problems = check();
    assert.ok(problems.some((p) => p.includes('SKILL.md differs')) === false, 'the shared sections did not change');
    assert.ok(problems.some((p) => p.includes("ivy's charter head differs")));
    organization();
    assert.deepEqual(check(), []);
  });
});

describe('index', () => {
  test('one line per decision, open risks only, and the watermark', () => {
    george();
    const r = index('george');
    assert.equal(r.decisions, 2); assert.equal(r.risks, 3); assert.equal(r.open, 2);
    const notes = join(repo, 'office', 'employees', 'george', 'notes');
    assert.ok(readFileSync(join(notes, 'decisions-index.md'), 'utf8').includes('- D-002 · Raw fetch · Settled · decisions.md:7'));
    const open = readFileSync(join(notes, 'risks-open.md'), 'utf8');
    assert.ok(open.includes('R-1') && open.includes('R-3') && !open.includes('R-2'));
    const wm = JSON.parse(readFileSync(join(notes, 'watermark.json'), 'utf8'));
    assert.equal(wm.files['status.md'], 4); assert.equal(wm.commit, null);
  });
});

describe('check', () => {
  beforeEach(() => { george(); });
  const agent = () => join(repo, '.claude', 'agents', 'george.md');
  test('a consistent office has no problems', () => { assert.deepEqual(check(), []); });
  test('an agent file without a folder, and a folder without an agent file', () => {
    writeFileSync(join(repo, '.claude', 'agents', 'ghost.md'), '---\nname: ghost\n---\n');
    assert.ok(check().some((p) => p.includes('ghost.md has no office folder')));
    rmSync(agent());
    assert.ok(check().some((p) => p.includes('george has an office folder and no .claude/agents/george.md')));
  });
  test('an unknown frontmatter key, a reaching tools list, memory:, a missing guard, a missing preload', () => {
    organization();
    const text = readFileSync(agent(), 'utf8');
    writeFileSync(agent(), text.replace('model: inherit', 'model: inherit\ndisallowedTool: Write'));
    assert.ok(check().some((p) => p.includes('unknown frontmatter key "disallowedTool"')));
    writeFileSync(agent(), text.replace('tools: Read, Grep, Glob, Bash, Edit, Write, SendMessage', 'tools: Read, Skill, mcp__plugin_supabase_supabase'));
    const p2 = check();
    assert.ok(p2.some((p) => p.includes('reaches Skill')) && p2.some((p) => p.includes('reaches mcp__plugin_supabase_supabase, which its profile does not name')));
    writeFileSync(agent(), text.replace('model: inherit', 'model: inherit\nmemory: project'));
    assert.ok(check().some((p) => p.includes('memory:')));
    writeFileSync(agent(), text.replace(GUARD_COMMAND, 'echo nothing'));
    assert.ok(check().some((p) => p.includes('no guard hook')));
    writeFileSync(agent(), text.replace(`  - ${ORGANIZATION_SKILL}\n`, ''));
    assert.ok(check().some((p) => p.includes('does not preload')));
    // `skills:` reaches a subagent only, so the charter reads the skill under --agent.
    assert.ok(text.includes(ORG_READ_LINE), 'a hire is born with the read line');
    writeFileSync(agent(), text.replace(ORG_READ_LINE, ''));
    assert.ok(check().some((p) => p.includes('does not open with the line that reads')));
  });
  test('a duplicate id, a stale sequence, a sender who does not work here', () => {
    taskAdd({ to: 'george', from: 'user', title: 'One', why: 'w' });
    const board = join(repo, 'office', 'employees', 'george', 'board.md');
    writeFileSync(board, readFileSync(board, 'utf8') + '- T-001 · 2026-10-27 · from ghost · **Two** · why: w\n');
    const problems = check();
    assert.ok(problems.some((p) => p.includes('T-001 is on two boards')));
    assert.ok(problems.some((p) => p.includes('from "ghost"')));
    writeFileSync(join(repo, 'office', 'sequence.json'), '{"task":0,"message":0}');
    assert.ok(check().some((p) => p.includes('sequence.json says task 0')));
  });
  test('a plugin switched off, and employees with no settings mirror', () => {
    const s = settings(); delete s.enabledPlugins['supabase@anthropic-plugin-directory'];
    writeFileSync(join(repo, '.claude', 'settings.json'), JSON.stringify(s));
    assert.ok(check().some((p) => p.includes('supabase@anthropic-plugin-directory is not enabled')));
    writeFileSync(join(repo, '.claude', 'settings.json'), JSON.stringify(settings({ hooks: {} })));
    assert.ok(check().some((p) => p.includes('no guard mirror')));
  });
});

describe('the guard', () => {
  const repoOf = () => resolve(repo);
  const call = (who, kind, tool_name, tool_input, cwd) => judge({ tool_name, tool_input, cwd: cwd ?? repoOf(), agent_type: who }, guardKind(kind), repoOf());
  const g = (tool, input) => call('george', 'read-only', tool, input);

  test('read-only writes: under office/ only, relative or absolute, either slash; never a board', () => {
    assert.equal(g('Write', { file_path: 'office/employees/george/notes/x.md' }), null);
    assert.equal(g('Edit', { file_path: join(repo, 'office', 'README.md') }), null);
    assert.equal(g('Write', { file_path: join(repo, 'office', 'x.md').replace(/\\/g, '/') }), null);
    assert.match(g('Write', { file_path: 'apps/web/README.md' }), /writes under office\/ only/);
    assert.match(g('Edit', { file_path: join(repo, 'status.md') }), /status\.md/);
    assert.match(g('NotebookEdit', { notebook_path: 'plan/x.ipynb' }), /NotebookEdit to plan\/x\.ipynb/);
    assert.match(g('Write', { file_path: 'officer/x.md' }), /officer/);
    assert.match(g('Write', { file_path: '../elsewhere/office/x.md' }), /outside the repository/);
    assert.match(g('Write', {}), /no file path/);
    assert.match(g('Edit', { file_path: 'office/employees/george/board.md' }), /only office\.mjs writes a board/);
    assert.match(g('Edit', { file_path: 'office/pipeline.md' }), /only office\.mjs/);
    assert.match(g('Write', { file_path: 'office/employees/finn/notes/x.md' }), /finn's folder, not george's/);
  });

  test('read-only bash: the allowlist, the pipe filters, and what is refused', () => {
    assert.equal(g('Bash', { command: 'git log -1' }), null);
    assert.equal(g('Bash', { command: 'git log --oneline -20 | head -5' }), null);
    assert.equal(g('Bash', { command: 'git diff --stat HEAD~3 -- status.md | grep -c md' }), null);
    assert.equal(g('Bash', { command: `cd "${repo}" && git status --short` }), null);
    assert.equal(g('Bash', { command: 'node office/office.mjs check' }), null);
    assert.equal(g('Bash', { command: 'node office/office.mjs task add --to finn --from george "x" --why "y"' }), null);
    assert.match(g('Bash', { command: 'git commit --allow-empty -m x' }), /not in george's allowlist/);
    assert.match(g('Bash', { command: 'pnpm test' }), /not in george's allowlist/);
    assert.match(g('Bash', { command: 'node plan/x.mjs' }), /allowlist/);
    assert.match(g('Bash', { command: 'git log --output=x' }), /--output/);
    assert.match(g('Bash', { command: 'git -c core.pager=x log' }), /allowlist/);
    assert.match(g('Bash', { command: 'git log; rm -rf x' }), /second command/);
    assert.match(g('Bash', { command: 'git log && rm x' }), /chained/);
    assert.match(g('Bash', { command: 'git log > out.txt' }), /redirection/);
    assert.match(g('Bash', { command: 'git log | sh' }), /after a pipe only/);
    assert.match(g('Bash', { command: 'git log $(rm x)' }), /substitution/);
    assert.match(g('Bash', { command: 'cd /elsewhere && git log' }), /cd out of the repository/);
    assert.equal(g('Read', { file_path: 'apps/x' }), null);
  });

  test('read-only bash: quoted text is a word, not a command (George, Phase 7)', () => {
    assert.equal(g('Bash', { command: `node office/office.mjs msg --to finn --from george "a; b && c | d > e" ` }), null);
    assert.equal(g('Bash', { command: `node office/office.mjs msg --to finn --from george 'it is $(not run); x'` }), null);
    assert.equal(g('Bash', { command: `node office/office.mjs msg --to finn --from george "say \\"a; b\\" here"` }), null);
    assert.equal(g('Bash', { command: `git log --grep "a|b" | head -3` }), null);
    assert.match(g('Bash', { command: `node office/office.mjs msg --to finn --from george "x" ; rm y` }), /second command/);
    assert.match(g('Bash', { command: `node office/office.mjs msg --to finn --from george "$(rm y)"` }), /substitution/);
    assert.match(g('Bash', { command: 'node office/office.mjs msg --to finn --from george "x`rm y`"' }), /substitution/);
    assert.match(g('Bash', { command: `node office/office.mjs msg --to finn --from george "unclosed; rm y` }), /unclosed quote/);
    assert.match(g('Bash', { command: `git log "x" | sh` }), /after a pipe only/);
  });

  test('every row of Rule 11: author, architecture, security, tester, builder', () => {
    // an author writes its folder and the office, nothing else
    assert.equal(call('ivy', 'author:product', 'Write', { file_path: 'docs/product/analytics.md' }), null);
    assert.equal(call('ivy', 'author:product', 'Write', { file_path: 'office/employees/ivy/notes/x.md' }), null);
    assert.match(call('ivy', 'author:product', 'Write', { file_path: 'docs/requirements/analytics.md' }), /writes under office\/, docs\/product\/ only/);
    assert.match(call('ivy', 'author:product', 'Edit', { file_path: 'apps/web/lib/x.ts' }), /Rule 11/);
    assert.match(call('ivy', 'author:product', 'Bash', { command: 'pnpm test' }), /allowlist/);
    // the architect: plan/, decisions.md, risks.md
    assert.equal(call('theo', 'author:architecture', 'Write', { file_path: 'plan/analytics.md' }), null);
    assert.equal(call('theo', 'author:architecture', 'Edit', { file_path: 'decisions.md' }), null);
    assert.equal(call('theo', 'author:architecture', 'Edit', { file_path: 'risks.md' }), null);
    assert.match(call('theo', 'author:architecture', 'Edit', { file_path: 'status.md' }), /Rule 11/);
    assert.match(call('theo', 'author:architecture', 'Write', { file_path: 'packages/db/sql/x.sql' }), /Rule 11/);
    // security: pnpm audit allowed, nothing else of pnpm
    assert.equal(call('sage', 'author:security', 'Bash', { command: 'pnpm audit' }), null);
    assert.equal(call('sage', 'author:security', 'Bash', { command: 'pnpm audit --prod | head' }), null);
    assert.match(call('sage', 'author:security', 'Bash', { command: 'pnpm test' }), /allowlist/);
    assert.match(call('sage', 'author:security', 'Bash', { command: 'pnpm audit; rm x' }), /second command/);
    // the tester: tests and docs/qa, every command but the user's hand
    assert.equal(call('quinn', 'tester', 'Write', { file_path: 'apps/web/lib/x.test.ts' }), null);
    assert.equal(call('quinn', 'tester', 'Write', { file_path: 'plan/analytics-walk.mjs' }), null);
    assert.equal(call('quinn', 'tester', 'Edit', { file_path: 'packages/db/tools/verify.mjs' }), null);
    assert.equal(call('quinn', 'tester', 'Write', { file_path: 'docs/qa/analytics.md' }), null);
    assert.match(call('quinn', 'tester', 'Edit', { file_path: 'apps/web/lib/x.ts' }), /and test files only/);
    assert.match(call('quinn', 'tester', 'Edit', { file_path: 'packages/db/sql/x.sql' }), /Rule 11/);
    assert.equal(call('quinn', 'tester', 'Bash', { command: 'pnpm test && pnpm typecheck' }), null);
    assert.equal(call('quinn', 'tester', 'Bash', { command: 'node --conditions=react-server plan/x-walk.mjs' }), null);
    assert.match(call('quinn', 'tester', 'Bash', { command: 'git commit -m x' }), /user's hand/);
    // the builder: anywhere but the script's files and others' folders; no commit, push, merge, deploy
    assert.equal(call('finn', 'builder', 'Write', { file_path: 'apps/web/lib/x.ts' }), null);
    assert.equal(call('finn', 'builder', 'Edit', { file_path: 'status.md' }), null);
    assert.equal(call('finn', 'builder', 'Write', { file_path: 'packages/db/sql/schema-x.sql' }), null);
    assert.equal(call('finn', 'builder', 'Write', { file_path: 'office/employees/finn/notes/x.md' }), null);
    assert.match(call('finn', 'builder', 'Edit', { file_path: 'office/employees/george/notes/x.md' }), /george's folder/);
    assert.match(call('finn', 'builder', 'Edit', { file_path: 'office/employees/finn/board.md' }), /only office\.mjs/);
    assert.match(call('finn', 'builder', 'Edit', { file_path: 'office/sequence.json' }), /only office\.mjs/);
    assert.equal(call('finn', 'builder', 'Bash', { command: 'pnpm test' }), null);
    assert.equal(call('finn', 'builder', 'Bash', { command: 'git add -A && git status' }), null);
    assert.equal(call('finn', 'builder', 'Bash', { command: 'git log --oneline | head' }), null);
    for (const c of ['git commit -m x', 'git push origin master', 'git merge feat', 'git rebase master', 'git reset --hard', 'git checkout -- .', 'git stash', 'git branch -D x', 'cd /x && git push', 'git -C . push', 'gh pr create', 'vercel deploy', 'npx vercel'])
      assert.match(call('finn', 'builder', 'Bash', { command: c }), /user's hand/, c);
  });

  test('guardOf: the profile decides who is guarded', () => {
    george(); finn();
    assert.equal(guardOf('george', repoOf()).kind, 'read-only');
    assert.equal(guardOf('finn', repoOf()).kind, 'builder');
    assert.equal(guardOf('nobody', repoOf()), null);
    assert.equal(guardOf(undefined, repoOf()), null);
    assert.equal(guardOf('../x', repoOf()), null);
  });

  test('as a process: exit 2 with the reason, 0 for a plain session and an allowed call', () => {
    george(); finn();
    const run = (input) => spawnSync(process.execPath, [resolve('office/hooks/guard.mjs')], { input: JSON.stringify(input), encoding: 'utf8', env: { ...process.env, OFFICE_REPO: repo } });
    const refused = run({ agent_type: 'george', tool_name: 'Write', tool_input: { file_path: 'apps/web/README.md' }, cwd: repo });
    assert.equal(refused.status, 2); assert.match(refused.stderr, /george may not do this/);
    assert.equal(run({ agent_type: 'george', tool_name: 'Write', tool_input: { file_path: 'office/x.md' }, cwd: repo }).status, 0);
    assert.equal(run({ tool_name: 'Write', tool_input: { file_path: 'apps/web/README.md' }, cwd: repo }).status, 0);
    assert.equal(run({ agent_type: 'finn', tool_name: 'Bash', tool_input: { command: 'pnpm test' }, cwd: repo }).status, 0);
    assert.equal(run({ agent_type: 'finn', tool_name: 'Bash', tool_input: { command: 'git push' }, cwd: repo }).status, 2);
    assert.equal(run({ agent_type: 'george', tool_name: 'Bash', tool_input: { command: 'pnpm test' }, cwd: repo }).status, 2);
  });
});

describe('the lock, the session index, the snapshot (plan/office-app.md Phase 1)', () => {
  const script = resolve('office/office.mjs');
  beforeEach(() => { george(); ivy(); });

  test('two processes adding 20 tasks each at once end with 40 distinct ids', () => {
    const body = 'for (let i = 0; i < 20; i++) m.taskAdd({ to: "ivy", from: "george", title: "t" + process.argv[1] + i, why: "race" });';
    const runner = join(repo, 'race.mjs');
    writeFileSync(runner, `import * as m from ${JSON.stringify(pathToFileURL(script).href)}; ${body}`);
    const { spawn } = require_child();
    return Promise.all(['a', 'b'].map((tag) => new Promise((done, fail) => {
      const c = spawn(process.execPath, [runner, tag], { env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] });
      let err = ''; c.stderr.on('data', (d) => (err += d));
      c.on('close', (code) => (code === 0 ? done() : fail(new Error(err))));
    }))).then(() => {
      const ids = parseBoard(readFileSync(join(repo, 'office', 'employees', 'ivy', 'board.md'), 'utf8')).board.inbox.map((x) => x.id);
      assert.equal(ids.length, 40);
      assert.equal(new Set(ids).size, 40, 'no id twice');
      assert.equal(JSON.parse(readFileSync(join(repo, 'office', 'sequence.json'), 'utf8')).task, 40);
      assert.ok(!existsSync(join(repo, 'office', '.lock')), 'the lock is released');
    });
  });

  test('a stale lock is taken; a fresh one held by another makes a writer wait, then refuse in words', () => {
    const lock = join(repo, 'office', '.lock');
    mkdirSync(lock);
    const old = new Date(Date.now() - LOCK_STALE_MS - 1000);
    require_fs().utimesSync(lock, old, old);
    assert.equal(taskAdd({ to: 'ivy', from: 'george', title: 'after a stale lock', why: 'x' }).id, 'T-001');
    assert.ok(!existsSync(lock));
    assert.equal(withLock(() => withLock(() => 'nested')), 'nested', 're-entrant');
  });

  test('the session index: a first turn, a second, a bad id refused; the guard keeps sessions.json the script\'s', () => {
    const id = '0f9c2a7e-1b2c-4d5e-8f90-123456789abc';
    sessionTurn('ivy', { id, title: 'What is   owed\non analytics?', usd: 0.25 });
    const s = sessionTurn('ivy', { id, usd: 0.5 });
    assert.deepEqual([s.turns, s.usd, s.title], [2, 0.75, 'What is owed on analytics?']);
    assert.equal(sessions('ivy').length, 1);
    assert.throws(() => sessionTurn('ivy', { id: '../x' }), /uuid/);
    assert.throws(() => sessions('nobody'), /no employee/);
    const reason = judge({ tool_name: 'Write', tool_input: { file_path: 'office/employees/ivy/sessions.json' }, cwd: repo, agent_type: 'ivy' }, guardKind('author:product'), repo);
    assert.match(reason, /only office.mjs writes/);
    assert.match(judge({ tool_name: 'Write', tool_input: { file_path: 'office/.lock/x' }, cwd: repo, agent_type: 'finn' }, guardKind('builder'), repo), /only office.mjs/);
  });

  test('snapshot() is what the files hold, parsed by the same parsers check uses', () => {
    organization();
    ideaAdd({ slug: 'office-app', title: 'The office as a page', from: 'user', lane: 'short' });
    taskAdd({ to: 'ivy', from: 'george', title: 'read it', why: 'because', idea: 'office-app' });
    msg({ to: 'ivy', from: 'george', text: 'hello; with a semicolon' });
    const s = snapshot();
    assert.deepEqual(s.employees.map((e) => e.name), ['george', 'ivy']);
    const ivyRow = s.employees.find((e) => e.name === 'ivy');
    assert.deepEqual([ivyRow.title, ivyRow.colourHex, ivyRow.unread, ivyRow.board.inbox[0].title, ivyRow.guard.kind], ['Idea Strategist', '#ca8a04', 1, 'read it', 'author:product']);
    assert.equal(s.ideas[0].status, 'Approved');
    assert.deepEqual(s.sections, SECTIONS);
    assert.deepEqual(s.problems, check());
  });

  test('a CRLF checkout of the skill and a board still passes check; a CRLF AGENT file is reported', () => {
    organization();
    for (const f of [join(repo, '.claude', 'skills', ORGANIZATION_SKILL, 'SKILL.md'), join(repo, 'office', 'employees', 'ivy', 'board.md')]) {
      writeFileSync(f, readFileSync(f, 'utf8').replace(/\r?\n/g, '\r\n'));
    }
    assert.deepEqual(check(), []);
    const agent = join(repo, '.claude', 'agents', 'ivy.md');
    writeFileSync(agent, readFileSync(agent, 'utf8').replace(/\r?\n/g, '\r\n'));
    assert.ok(check().some((p) => p.includes('ivy.md has CRLF line endings')));
  });
});

import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const require_ = createRequire(import.meta.url);
function require_child() { return require_('node:child_process'); }
function require_fs() { return require_('node:fs'); }
