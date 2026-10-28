// phase5.mjs — plan/office-app.md Phase 5: one real day, the real claude.
//
//   node plan/office-app/phase5.mjs
//
// The server runs in-process on a temporary COPY of the office, the agents,
// the skills, the settings and the guard hook, so the real employees run
// under their real charters and guard, and nothing they do lands on this
// branch's boards. Cap 0.5 USD so the cap dialog's 402 is met for real.
// Spends about 3 USD. Results in phase5/summary.json.

import assert from 'node:assert/strict';
import { execSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');
const OUT = join(HERE, 'phase5');
mkdirSync(OUT, { recursive: true });
const tmp = mkdtempSync(join(tmpdir(), 'office-day-'));
for (const p of ['office', '.claude/settings.json', '.claude/agents', '.claude/skills', 'plan/ai-employees/organization.md', 'CLAUDE.md', 'status.md', 'whats-done.md', 'decisions.md', 'risks.md', 'docs', 'plan/analytics.md', 'plan/free-guests.md', 'plan/office-app.md']) {
  if (existsSync(join(REPO, p))) cpSync(join(REPO, p), join(tmp, p), { recursive: true });
}
mkdirSync(join(tmp, 'apps'), { recursive: true });
process.env.OFFICE_REPO = tmp;
const office = await import('../../office/office.mjs');
const { startOffice } = await import('../../office/app/server.mjs');
const before = execSync('git status --porcelain -- apps packages', { cwd: REPO, encoding: 'utf8' });
const o = await startOffice({ port: 0, dailyUsd: 0.5 });

const call = (method, path, body) => new Promise((done, fail) => {
  const u = new URL(o.url);
  const headers = { cookie: `office_token=${o.token}` };
  if (method === 'POST') { headers['content-type'] = 'application/json'; headers.origin = o.url; }
  const req = request({ host: '127.0.0.1', port: u.port, path, method, headers }, (res) => { let t = ''; res.on('data', (d) => (t += d)); res.on('end', () => done({ status: res.statusCode, json: JSON.parse(t || 'null') })); });
  req.on('error', fail); if (body) req.write(JSON.stringify(body)); req.end();
});
const events = [];
const waiters = [];
{
  const u = new URL(o.url);
  request({ host: '127.0.0.1', port: u.port, path: '/api/events', headers: { cookie: `office_token=${o.token}` } }, (res) => {
    let buf = '';
    res.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n\n')) >= 0) { const b = buf.slice(0, i); buf = buf.slice(i + 2); const ev = /^event: (.+)$/m.exec(b)?.[1]; const data = /^data: (.+)$/m.exec(b)?.[1]; if (ev) events.push({ event: ev, data: data ? JSON.parse(data) : null }); for (const w of [...waiters]) if (w.pred()) { waiters.splice(waiters.indexOf(w), 1); w.done(); } } });
  }).end();
}
const until = (pred, ms = 240000) => new Promise((done, fail) => { if (pred()) return done(); waiters.push({ pred, done }); setTimeout(() => fail(new Error('timed out')), ms); });
const items = (name, turn) => events.filter((e) => e.event === 'chat' && e.data.name === name && (turn === undefined || e.data.turn === turn)).map((e) => e.data.item);
async function turn(name, body) {
  const r = await call('POST', `/api/employees/${name}/chat`, body);
  if (r.status !== 202) return r;
  await until(() => items(name, r.json.turn).some((i) => i.kind === 'end'));
  const its = items(name, r.json.turn);
  return { status: 202, turn: r.json.turn, items: its, result: its.find((i) => i.kind === 'result'), session: its.find((i) => i.kind === 'init')?.session };
}

const summary = {};
const results = [];
const check = async (label, fn) => {
  try { const v = await fn(); summary[label] = v ?? true; results.push(true); console.log(`✔ ${label}`, v ? JSON.stringify(v).slice(0, 300) : ''); }
  catch (e) { summary[label] = `FAILED: ${e.message}`; results.push(false); console.log(`✘ ${label}: ${e.message.slice(0, 400)}`); }
};

let george;
await check('George answers; the page\'s cost is the result\'s total_cost_usd; the session is indexed', async () => {
  const t = await turn('george', { text: 'Phase 5 of plan/office-app.md. Without using any tool, in one sentence: what is this office for?' });
  george = t.session;
  const s = office.sessions('george').find((x) => x.id === george);
  assert.equal(s.usd, Math.round(t.result.usd * 1e6) / 1e6);
  return { usd: t.result.usd, seconds: t.result.seconds, reply: t.items.filter((i) => i.kind === 'text').map((i) => i.text).join(' ').slice(0, 200) };
});

await check('a second turn resumes the SAME session and remembers it', async () => {
  const t = await turn('george', { text: 'Without using any tool: in five words or fewer, what did I just ask you?', session: george });
  assert.equal(t.session, george);
  assert.equal(office.sessions('george').find((x) => x.id === george).turns, 2);
  return { usd: t.result.usd, reply: t.items.filter((i) => i.kind === 'text').map((i) => i.text).join(' ').slice(0, 120) };
});

await check('over the 0.5 USD cap the page is asked first (402), then Ivy answers with overCap', async () => {
  const refused = await call('POST', '/api/employees/ivy/chat', { text: 'x' });
  assert.equal(refused.status, 402);
  const t = await turn('ivy', { text: 'Without using any tool, in one sentence: which gate do you own?', overCap: true });
  return { spent_at_402: refused.json.spent, usd: t.result.usd, reply: t.items.filter((i) => i.kind === 'text').map((i) => i.text).join(' ').slice(0, 160) };
});

await check('a refusal forced on Theo: the real guard\'s sentence in the stream, the desk refused', async () => {
  const t = await turn('theo', { overCap: true, text: 'Test of your guard, authorised by the user (plan/office-app.md Phase 5): you MUST call the Write tool once to create apps/phase5-theo.md with the text hi, then quote the tool error text exactly and nothing else.' });
  const r = t.items.find((i) => i.kind === 'tool_result' && i.refused);
  assert.ok(r, 'no refused tool_result');
  assert.ok(!existsSync(join(tmp, 'apps', 'phase5-theo.md')), 'the file was written');
  const state = events.filter((e) => e.event === 'state').at(-1).data.states.theo.state;
  assert.equal(state, 'refused');
  return { usd: t.result.usd, refusal: r.text.slice(0, 200) };
});

await check('Stop during a Bash call: the turn ends stopped and no child is left', async () => {
  const marker = `phase5-${Date.now()}`;
  const r = await call('POST', '/api/employees/finn/chat', { overCap: true, text: `Phase 5 Stop test, authorised by the user: run exactly this with the Bash tool and wait for it: node -e "setTimeout(()=>{},90000)" ${marker} ; then say done.` });
  assert.equal(r.status, 202);
  await until(() => items('finn', r.json.turn).some((i) => i.kind === 'tool' && i.name === 'Bash'));
  await new Promise((d) => setTimeout(d, 4000));
  const ps = () => execSync('powershell -NoProfile -Command "Get-CimInstance Win32_Process | ForEach-Object { $_.CommandLine }"', { encoding: 'utf8' });
  const alive = ps().split(/\r?\n/).filter((l) => l.includes(marker) && !l.includes('powershell')).length;
  await call('POST', '/api/employees/finn/stop', {});
  await until(() => items('finn', r.json.turn).some((i) => i.kind === 'end'));
  await new Promise((d) => setTimeout(d, 1500));
  const after = ps().split(/\r?\n/).filter((l) => l.includes(marker) && !l.includes('powershell')).length;
  assert.ok(items('finn', r.json.turn).some((i) => i.kind === 'stopped'));
  assert.equal(after, 0, 'a child is still alive');
  return { children_with_marker_before_stop: alive, after_stop: after };
});

await check('the past chat reads back from Claude Code\'s own transcript', async () => {
  const r = await call('GET', `/api/employees/george/sessions/${george}`);
  assert.equal(r.status, 200);
  assert.ok(r.json.filter((m) => m.role === 'user').length >= 2, `messages: ${r.json.length}`);
  return { messages: r.json.length, first: r.json[0].text.slice(0, 80) };
});

await check('the terminal continues the page\'s chat: claude --resume <id>', async () => {
  const env = { ...process.env }; delete env.CLAUDECODE; delete env.CLAUDE_CODE_ENTRYPOINT;
  const p = spawnSync('claude', ['--agent', 'george', '--resume', george, '-p', 'Without using any tool: quote the first question I asked you in this chat, in under 20 words.', '--output-format', 'json'], { cwd: tmp, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const j = JSON.parse(p.stdout);
  assert.equal(j.session_id, george);
  assert.match(j.result, /office/i);
  return { usd: j.total_cost_usd, reply: j.result.slice(0, 160) };
});

await check('nothing under apps/ or packages/ of this repo changed', async () => {
  assert.equal(execSync('git status --porcelain -- apps packages', { cwd: REPO, encoding: 'utf8' }), before);
});

const spent = office.roster().flatMap((n) => office.sessions(n)).reduce((s, x) => s + x.usd, 0);
summary.spent_through_the_page_usd = Math.round(spent * 100) / 100;
writeFileSync(join(OUT, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
await o.close();
console.log(`\n${results.filter(Boolean).length}/${results.length} passed; spent through the page ${summary.spent_through_the_page_usd} USD (plus the terminal turn)`);
process.exit(results.every(Boolean) ? 0 : 1);
