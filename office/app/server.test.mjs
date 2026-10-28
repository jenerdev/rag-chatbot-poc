// server.test.mjs — plan/office-app.md Phase 2: the office app's server on a
// temporary repo and the fake claude, so nothing is spent.
//
//   node --test office/app/server.test.mjs

import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execSync } from 'node:child_process';
import { after, before, describe, test } from 'node:test';

import * as office from '../office.mjs';
import { readTranscript, slim, startOffice, toolSummary } from './server.mjs';

const FAKE = resolve('office/app/test/fake-claude.mjs');
let repo, o, log, projects;

const call = (method, path, { body, origin, cookie = true, host } = {}) => new Promise((done, fail) => {
  const u = new URL(o.url);
  const headers = { ...(cookie ? { cookie: `office_token=${o.token}` } : {}), ...(host ? { host } : {}) };
  if (method === 'POST') { headers['content-type'] = 'application/json'; headers.origin = origin ?? o.url; } else if (origin) headers.origin = origin;
  const req = request({ host: '127.0.0.1', port: u.port, path, method, headers }, (res) => {
    let text = ''; res.on('data', (d) => (text += d)); res.on('end', () => { let json = null; try { json = JSON.parse(text); } catch {} done({ status: res.statusCode, json, text, headers: res.headers }); });
  });
  req.on('error', fail);
  if (body !== undefined) req.write(JSON.stringify(body));
  req.end();
});

// An SSE listener that collects events until a predicate holds.
function listen() {
  const events = [];
  const waiters = [];
  const u = new URL(o.url);
  const req = request({ host: '127.0.0.1', port: u.port, path: '/api/events', headers: { cookie: `office_token=${o.token}` } }, (res) => {
    let buf = '';
    res.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i); buf = buf.slice(i + 2);
        const ev = /^event: (.+)$/m.exec(block)?.[1]; const data = /^data: (.+)$/m.exec(block)?.[1];
        if (ev) events.push({ event: ev, data: data ? JSON.parse(data) : null });
        for (const w of [...waiters]) if (w.pred(events)) { waiters.splice(waiters.indexOf(w), 1); w.done(events); }
      }
    });
  });
  req.end();
  return {
    events,
    until: (pred, ms = 8000) => new Promise((done, fail) => { if (pred(events)) return done(events); const w = { pred, done }; waiters.push(w); setTimeout(() => fail(new Error(`timed out; saw ${events.map((e) => e.event + (e.data?.item ? ':' + e.data.item.kind : '')).join(', ')}`)), ms); }),
    close: () => req.destroy(),
  };
}
const items = (events, name) => events.filter((e) => e.event === 'chat' && e.data.name === name).map((e) => e.data.item);

before(async () => {
  repo = mkdtempSync(join(tmpdir(), 'office-app-'));
  projects = join(repo, 'projects');
  mkdirSync(join(repo, '.claude'), { recursive: true });
  mkdirSync(join(repo, 'office'), { recursive: true });
  writeFileSync(join(repo, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: Object.fromEntries(office.REQUIRED_PLUGINS.map((p) => [p, true])), hooks: { PreToolUse: [{ matcher: 'Write|Edit|NotebookEdit|Bash', hooks: [{ type: 'command', command: office.GUARD_COMMAND }] }] } }));
  writeFileSync(join(repo, 'status.md'), 'status\n');
  process.env.OFFICE_REPO = repo;
  office.hire({ name: 'george', title: 'Project Intelligence', role: 'project-intelligence', colour: 'blue', pronouns: 'she/her' });
  office.hire({ name: 'ivy', title: 'Idea Strategist', role: 'idea-strategist', guard: 'author:product', colour: 'yellow', tools: ['mcp__plugin_context7_context7'] });
  office.hire({ name: 'finn', title: 'Full-Stack Engineer', role: 'full-stack-engineer', guard: 'builder', colour: 'green' });
  office.hire({ name: 'quinn', title: 'QA Engineer', role: 'qa-engineer', guard: 'tester', colour: 'red' });
  log = join(repo, 'fake.log');
  process.env.FAKE_CLAUDE_LOG = log;
  o = await startOffice({ port: 0, claude: FAKE, projectsDir: projects, dailyUsd: 0.03 });
});
after(async () => { await o.close(); delete process.env.OFFICE_REPO; delete process.env.FAKE_CLAUDE_LOG; rmSync(repo, { recursive: true, force: true }); });

describe('the door (Rule 1)', () => {
  test('401 without the token; the printed URL sets a cookie; a wrong token is refused', async () => {
    assert.equal((await call('GET', '/api/office', { cookie: false })).status, 401);
    assert.equal((await call('GET', '/', { cookie: false })).status, 401);
    assert.equal((await call('GET', '/?token=nope', { cookie: false })).status, 401);
    const r = await call('GET', `/?token=${o.token}`, { cookie: false });
    assert.equal(r.status, 303);
    assert.match(r.headers['set-cookie'][0], /office_token=[0-9a-f]{64}; HttpOnly; SameSite=Strict/);
  });
  test('403 for a foreign Origin, for a Host that is not 127.0.0.1, for a POST without Origin', async () => {
    assert.equal((await call('GET', '/api/office', { origin: 'http://evil.example' })).status, 403);
    assert.equal((await call('GET', '/api/office', { host: 'evil.example:80' })).status, 403);
    assert.equal((await call('POST', '/api/tasks', { origin: 'http://evil.example', body: {} })).status, 403);
    const u = new URL(o.url);
    const r = await new Promise((done) => { const q = request({ host: '127.0.0.1', port: u.port, path: '/api/tasks', method: 'POST', headers: { cookie: `office_token=${o.token}` } }, (res) => { res.resume(); done(res.statusCode); }); q.end('{}'); });
    assert.equal(r, 403);
  });
  test('the page has its own CSP; a path out of public/ is a 404', async () => {
    const r = await call('GET', '/');
    assert.equal(r.status, 200);
    assert.match(r.headers['content-security-policy'], /default-src 'self'/);
    assert.equal((await call('GET', '/public/..%2F..%2Foffice.mjs')).status, 404);
    assert.equal((await call('GET', '/public/../server.mjs')).status, 404);
  });
  test('it listens on 127.0.0.1 only', () => { assert.equal(o.server.address().address, '127.0.0.1'); });
});

describe('the office (Rules 3, 4)', () => {
  test('GET /api/office is the snapshot plus live states and spend', async () => {
    const r = await call('GET', '/api/office');
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.employees.map((e) => e.name), ['finn', 'george', 'ivy', 'quinn']);
    assert.deepEqual(r.json.sections, office.SECTIONS);
    assert.equal(r.json.cap, 0.03);
    assert.ok('george' in r.json.states);
  });
  test('404 for an unknown employee, and for a name that is a path', async () => {
    assert.equal((await call('GET', '/api/employees/nobody/sessions')).status, 404);
    assert.equal((await call('GET', '/api/employees/..%2Foffice/sessions')).status, 404);
    assert.equal((await call('POST', '/api/employees/nobody/chat', { body: { text: 'hi' } })).status, 404);
  });
  test('a task added and moved through the routes is on the board FILE; a refusal is office.mjs\'s sentence', async () => {
    const sse = listen();
    const add = await call('POST', '/api/tasks', { body: { to: 'ivy', title: 'from the page', why: 'Phase 2' } });
    assert.equal(add.status, 202);
    assert.match(add.json.id, /^T-\d+$/);
    await sse.until((ev) => ev.some((e) => e.event === 'changed'));
    const move = await call('POST', `/api/tasks/${add.json.id}/move`, { body: { to: 'done', note: 'moved by the test' } });
    assert.equal(move.status, 202);
    const board = office.parseBoard(readFileSync(join(repo, 'office', 'employees', 'ivy', 'board.md'), 'utf8')).board;
    assert.equal(board.done.find((t) => t.id === add.json.id).note, 'moved by the test');
    const bad = await call('POST', `/api/tasks/${add.json.id}/move`, { body: { to: 'done', note: 'again' } });
    assert.equal(bad.status, 400);
    assert.match(bad.json.error, /already done/);
    sse.close();
  });
  test('a file changed outside the page fires ONE changed per burst', async () => {
    const sse = listen();
    await sse.until((ev) => ev.some((e) => e.event === 'hello'));
    execSync(`node office/office.mjs msg --to ivy --from george "from a terminal; with a semicolon"`, { env: { ...process.env }, stdio: 'ignore' });
    await sse.until((ev) => ev.some((e) => e.event === 'changed'));
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(sse.events.filter((e) => e.event === 'changed').length, 1);
    const ack = await call('POST', '/api/employees/ivy/inbox/ack', { body: {} });
    assert.ok(ack.json.every((m) => m.read));
    sse.close();
  });
});

describe('a chat (Rule 2) and money (Rule 5)', () => {
  let session;
  test('a turn streams init, deltas, the text and a result in order, and records the session', async () => {
    const sse = listen();
    const r = await call('POST', '/api/employees/ivy/chat', { body: { text: 'hello office' } });
    assert.equal(r.status, 202);
    await sse.until((ev) => items(ev, 'ivy').some((i) => i.kind === 'end'));
    const kinds = items(sse.events, 'ivy').map((i) => i.kind);
    assert.deepEqual(kinds.filter((k, i) => k !== kinds[i - 1]), ['user', 'init', 'message', 'delta', 'text', 'rate', 'result', 'end']);
    assert.equal(items(sse.events, 'ivy').filter((i) => i.kind === 'delta').map((i) => i.text).join(''), 'You said: hello office');
    session = items(sse.events, 'ivy').find((i) => i.kind === 'init').session;
    const list = office.sessions('ivy');
    assert.deepEqual([list[0].id, list[0].turns, list[0].usd, list[0].title], [session, 1, 0.0125, 'hello office']);
    const argv = readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).at(-1);
    assert.deepEqual(argv.slice(0, 2), ['--agent', 'ivy']);
    assert.equal(argv[argv.indexOf('--allowedTools') + 1], 'Read,Grep,Glob,Bash,Write,Edit,mcp__plugin_context7_context7');
    assert.ok(!argv.some((a) => /bypass|dangerously/i.test(a)), 'never a permission bypass');
    sse.close();
  });
  test('a second turn resumes the session; a session that is not hers is refused', async () => {
    const sse = listen();
    await call('POST', '/api/employees/ivy/chat', { body: { text: 'tool please', session } });
    await sse.until((ev) => items(ev, 'ivy').some((i) => i.kind === 'end'));
    const argv = readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).at(-1);
    assert.equal(argv[argv.indexOf('--resume') + 1], session);
    const tool = items(sse.events, 'ivy').find((i) => i.kind === 'tool');
    assert.deepEqual([tool.name, tool.summary], ['Read', 'status.md']);
    assert.equal(office.sessions('ivy')[0].turns, 2);
    assert.equal((await call('POST', '/api/employees/george/chat', { body: { text: 'x', session } })).status, 400);
    sse.close();
  });
  test('over the daily cap a turn asks first (402), then goes with overCap', async () => {
    const r = await call('POST', '/api/employees/george/chat', { body: { text: 'refuse this' } });
    assert.equal(r.status, 402);
    assert.equal(r.json.cap, 0.03);
    const sse = listen();
    assert.equal((await call('POST', '/api/employees/george/chat', { body: { text: 'refuse this', overCap: true } })).status, 202);
    await sse.until((ev) => items(ev, 'george').some((i) => i.kind === 'end'));
    const refusal = items(sse.events, 'george').find((i) => i.kind === 'tool_result');
    assert.deepEqual([refusal.error, refusal.refused], [true, true]);
    const state = sse.events.filter((e) => e.event === 'state').at(-1).data.states.george.state;
    assert.equal(state, 'refused');
    sse.close();
  });
  test('Stop kills the turn and leaves no process; a second builder turn is queued behind the first', async () => {
    const sse = listen();
    assert.equal((await call('POST', '/api/employees/finn/chat', { body: { text: 'slow build', overCap: true } })).status, 202);
    await sse.until((ev) => items(ev, 'finn').some((i) => i.kind === 'tool'));
    const q = await call('POST', '/api/employees/quinn/chat', { body: { text: 'test it', overCap: true } });
    assert.deepEqual(q.json, { queued: true, behind: 'finn' });
    assert.equal((await call('POST', '/api/employees/finn/chat', { body: { text: 'again', overCap: true } })).status, 409);
    const pidOf = () => readFileSync(log, 'utf8').trim().split('\n').length;
    assert.ok(pidOf() > 0);
    assert.equal((await call('POST', '/api/employees/finn/stop', { body: {} })).status, 202);
    await sse.until((ev) => items(ev, 'finn').some((i) => i.kind === 'stopped'));
    // The queued tester runs once the builder is gone.
    await sse.until((ev) => items(ev, 'quinn').some((i) => i.kind === 'end'));
    assert.equal(items(sse.events, 'quinn').filter((i) => i.kind === 'delta').map((i) => i.text).join(''), 'You said: test it');
    // Windows 11 has no wmic; PowerShell's CIM query lists every command line.
    const procs = execSync(process.platform === 'win32' ? 'powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name=\'node.exe\'\\" | ForEach-Object { $_.CommandLine }"' : 'ps -eo args', { encoding: 'utf8' });
    assert.ok(!/fake-claude\.mjs.*slow build/.test(procs), 'the slow fake is gone');
    sse.close();
  });
  test('a turn that ends on the session limit says so', async () => {
    const sse = listen();
    await call('POST', '/api/employees/ivy/chat', { body: { text: 'limit', session, overCap: true } });
    await sse.until((ev) => items(ev, 'ivy').some((i) => i.kind === 'end'));
    assert.equal(items(sse.events, 'ivy').find((i) => i.kind === 'result').limit, true);
    assert.equal(sse.events.filter((e) => e.event === 'state').at(-1).data.states.ivy.state, 'limit');
    sse.close();
  });
  test('a past chat reads back from the Claude Code transcript; an unknown id is a 404', async () => {
    mkdirSync(join(projects, 'C--repo'), { recursive: true });
    writeFileSync(join(projects, 'C--repo', `${session}.jsonl`), [
      { type: 'user', message: { content: 'hello office' } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Hi.' }, { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: join(repo, 'status.md') } }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'status' }] } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Done.' }] } },
    ].map((e) => JSON.stringify(e)).join('\n'));
    const r = await call('GET', `/api/employees/ivy/sessions/${session}`);
    assert.deepEqual(r.json.map((m) => [m.role, m.text, m.tools.length]), [['user', 'hello office', 0], ['assistant', 'Hi.\n\nDone.', 1]]);
    assert.equal(r.json[1].tools[0].summary, 'status.md');
    assert.equal((await call('GET', '/api/employees/ivy/sessions/00000000-0000-4000-8000-000000000000')).status, 404);
  });
});

describe('pure parts', () => {
  test('slim drops what the page does not draw; toolSummary is repo-relative', () => {
    assert.deepEqual(slim({ type: 'system', subtype: 'hook_started' }, '/r'), []);
    assert.deepEqual(slim({ type: 'result', total_cost_usd: 0.5, is_error: false, result: 'ok', duration_ms: 2100 }, '/r'), [{ kind: 'result', usd: 0.5, error: false, text: 'ok', limit: false, seconds: 2 }]);
    assert.equal(toolSummary('Bash', { command: 'git   log\n-1' }), 'git log -1');
    assert.equal(toolSummary('Read', { file_path: join('/r', 'a', 'b.md') }, '/r'), 'a/b.md');
    assert.deepEqual(readTranscript('not json\n{"type":"user","message":{"content":"<command-name>x</command-name>"}}', '/r'), []);
  });
});
