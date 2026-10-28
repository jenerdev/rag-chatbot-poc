// server.mjs — the office as a page (plan/office-app.md). Zero dependencies.
//
//   pnpm office            → prints http://127.0.0.1:4600/?token=…  (open it)
//
// What it is, in the plan's words:
//   Rule 1  local only: 127.0.0.1, a random token, Origin and Host checked.
//   Rule 2  a chat IS `claude --agent <name> -p … --resume <id>`: the
//           charter, the tools and the guard hook apply unchanged; no API key
//           here, no permission bypass.
//   Rule 3  office.mjs is the ONE writer: boards, inboxes and sessions are
//           changed through its functions, never written here.
//   Rule 4  the files are the truth: a watcher tells the page when they move.
//   Rule 5  money shown: each turn's cost, today's total, a daily cap.
//   Rule 6  one builder-or-tester turn at a time; the others queue.

import { spawn, execFile } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, watch } from 'node:fs';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as office from '../office.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(here, 'public');

export const BODY_LIMIT = 32 * 1024;
export const TEXT_LIMIT = 8000;
export const DEBOUNCE_MS = 150;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NAME = /^[a-z][a-z0-9-]*$/;
// The tools a turn may use without a prompt nobody can answer in print mode
// (Phase 6-7's runners used the same list); the profile adds its MCP tools.
const BASE_ALLOWED = ['Read', 'Grep', 'Glob', 'Bash', 'Write', 'Edit'];
// Rule 6: these kinds change the working tree, run builds and dev servers.
const TREE_KINDS = new Set(['builder', 'tester']);

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json' };
const CSP = "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

class HttpError extends Error { constructor(status, message, extra = {}) { super(message); this.status = status; this.extra = extra; } }

const todayKey = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// What a tool call is about, in one short line for the page.
export function toolSummary(name, input = {}, repo = '') {
  const rel = (p) => { if (typeof p !== 'string') return ''; const r = relative(repo, p); return r && !r.startsWith('..') ? r.split(sep).join('/') : p; };
  switch (name) {
    case 'Read': case 'Write': case 'Edit': case 'NotebookEdit': return rel(input.file_path ?? input.notebook_path);
    case 'Bash': return String(input.command ?? '').replace(/\s+/g, ' ').slice(0, 160);
    case 'Grep': return `${input.pattern ?? ''}${input.path ? ` in ${rel(input.path)}` : ''}`;
    case 'Glob': return String(input.pattern ?? '');
    default: return '';
  }
}
const resultText = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((x) => x.text ?? '').join('') : JSON.stringify(c ?? ''));

// Tools whose calls never reach a chat, live or in a past one: the user,
// 2026-10-28, "please dont include the bash commands on the bot response".
// A hidden call still sets the desk's state ("running a command", never the
// command) and still counts as a refusal when the guard refuses it.
export const HIDDEN_TOOLS = new Set(['Bash']);

// One stream-json event (plan/office-app/phase0.md) → the few kinds the
// page draws. Everything else is dropped: the page never sees raw events.
export function slim(e, repo) {
  if (e.type === 'system' && e.subtype === 'init') return [{ kind: 'init', session: e.session_id }];
  if (e.type === 'stream_event' && e.event?.type === 'content_block_delta' && e.event.delta?.type === 'text_delta') return [{ kind: 'delta', text: e.event.delta.text }];
  if (e.type === 'stream_event' && e.event?.type === 'message_start') return [{ kind: 'message' }];
  if (e.type === 'assistant' && Array.isArray(e.message?.content)) {
    return e.message.content.flatMap((c) => c.type === 'text' ? [{ kind: 'text', text: c.text }]
      : c.type === 'tool_use' ? [HIDDEN_TOOLS.has(c.name) ? { kind: 'tool', id: c.id, name: c.name, summary: '', hidden: true } : { kind: 'tool', id: c.id, name: c.name, summary: toolSummary(c.name, c.input, repo) }] : []);
  }
  if (e.type === 'user' && Array.isArray(e.message?.content)) {
    return e.message.content.filter((c) => c.type === 'tool_result').map((c) => {
      const text = resultText(c.content);
      return { kind: 'tool_result', id: c.tool_use_id, error: !!c.is_error, refused: !!c.is_error && /^PreToolUse:/.test(text), text: text.slice(0, 600) };
    });
  }
  if (e.type === 'result') return [{ kind: 'result', usd: e.total_cost_usd ?? 0, error: !!e.is_error, text: e.result ?? '', limit: !!e.is_error && /session limit/i.test(e.result ?? ''), seconds: Math.round((e.duration_ms ?? 0) / 1000) }];
  if (e.type === 'rate_limit_event') return [{ kind: 'rate' }];
  return [];
}

// A Claude Code transcript (~/.claude/projects/<dir>/<id>.jsonl) → the
// messages the panel shows when a past chat is opened.
export function readTranscript(text, repo) {
  const out = [];
  const tools = new Map();
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let e; try { e = JSON.parse(line); } catch { continue; }
    if (e.isSidechain) continue;
    const content = e.message?.content;
    if (e.type === 'user') {
      if (typeof content === 'string') { if (!content.startsWith('<')) out.push({ role: 'user', text: content, tools: [] }); continue; }
      if (!Array.isArray(content)) continue;
      const words = content.filter((c) => c.type === 'text' && !c.text.startsWith('<')).map((c) => c.text).join('\n');
      if (words) out.push({ role: 'user', text: words, tools: [] });
      for (const c of content.filter((c) => c.type === 'tool_result')) {
        const t = tools.get(c.tool_use_id); if (!t) continue;
        const r = resultText(c.content); t.error = !!c.is_error; t.refused = t.error && /^PreToolUse:/.test(r); t.result = r.slice(0, 600);
      }
    } else if (e.type === 'assistant' && Array.isArray(content)) {
      let last = out[out.length - 1];
      if (!last || last.role !== 'assistant') { last = { role: 'assistant', text: '', tools: [] }; out.push(last); }
      for (const c of content) {
        if (c.type === 'text') last.text += (last.text ? '\n\n' : '') + c.text;
        if (c.type === 'tool_use' && !HIDDEN_TOOLS.has(c.name)) { const t = { id: c.id, name: c.name, summary: toolSummary(c.name, c.input, repo) }; tools.set(c.id, t); last.tools.push(t); }
      }
    }
  }
  return out;
}

export function startOffice({ port = Number(process.env.OFFICE_PORT ?? 4600), token = randomBytes(32).toString('hex'), claude = process.env.OFFICE_CLAUDE ?? 'claude', projectsDir = process.env.OFFICE_CLAUDE_PROJECTS ?? join(homedir(), '.claude', 'projects'), dailyUsd = Number(process.env.OFFICE_DAILY_USD ?? 10) } = {}) {
  const repo = office.repo();
  const clients = new Set();
  const running = new Map(); // name → { child, turn, session, tool, title, kind, refused }
  const queue = []; // Rule 6: [{ name, body }]
  const outcome = new Map(); // name → 'refused' | 'limit' | 'stopped' after the last turn
  let turnSeq = 0;

  const send = (event, data) => { const line = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`; for (const res of clients) res.write(line); };
  const kindOf = (name) => office.profile(name).guard?.kind ?? 'read-only';
  const spentToday = () => {
    const key = todayKey();
    let usd = 0;
    for (const name of office.roster()) for (const s of office.sessions(name)) for (const t of s.log ?? []) if (todayKey(new Date(t.at)) === key) usd += t.usd;
    return Math.round(usd * 100) / 100;
  };
  const states = () => Object.fromEntries(office.roster().map((name) => {
    const r = running.get(name);
    const q = queue.findIndex((x) => x.name === name);
    return [name, r ? { state: 'working', tool: r.tool, turn: r.turn } : q >= 0 ? { state: 'queued', behind: [...running.values()].find((x) => TREE_KINDS.has(x.kind))?.name ?? null } : { state: outcome.get(name) ?? null }];
  }));
  const pushState = () => send('state', { states: states(), spent: spentToday(), cap: dailyUsd });

  // ---------------------------------------------------------------- a turn (Rule 2)

  function allowedTools(name) {
    const p = office.profile(name);
    return [...BASE_ALLOWED, ...(p.tools ?? []).filter((t) => /^mcp__[a-zA-Z0-9_]+$/.test(t))].join(',');
  }

  function runTurn(name, { session, text }) {
    const turn = ++turnSeq;
    const args = ['--agent', name, '-p', text, '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--allowedTools', allowedTools(name)];
    if (session) args.push('--resume', session);
    // Trap 2.4: a nested claude must not think it runs inside another session.
    const env = { ...process.env };
    delete env.CLAUDECODE; delete env.CLAUDE_CODE_ENTRYPOINT;
    // A script path runs under this node (the tests' fake claude).
    const [cmd, cmdArgs] = /\.m?js$/.test(claude) ? [process.execPath, [claude, ...args]] : [claude, args];
    // Trap 2.3: stdin ignored. `detached` off Windows so Stop can kill the group.
    const child = spawn(cmd, cmdArgs, { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32', windowsHide: true });
    const r = { child, turn, session: session ?? null, tool: null, title: text, kind: kindOf(name), refused: false, result: null };
    running.set(name, r);
    outcome.delete(name);
    send('chat', { name, turn, item: { kind: 'user', text } });
    pushState();
    let buffer = '';
    const hidden = new Set(); // this turn's HIDDEN_TOOLS calls: their results stay off the page too
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      let i;
      while ((i = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, i).trim(); buffer = buffer.slice(i + 1);
        if (!line) continue;
        let e; try { e = JSON.parse(line); } catch { continue; }
        for (const item of slim(e, repo)) {
          if (item.kind === 'init') r.session = item.session;
          if (item.kind === 'tool') { r.tool = item.hidden ? 'running a command' : `${item.name}${item.summary ? ` ${item.summary}` : ''}`.slice(0, 80); pushState(); }
          if (item.kind === 'tool_result' && item.refused) r.refused = true;
          if (item.kind === 'result') r.result = item;
          if (item.hidden) { hidden.add(item.id); continue; }
          if (item.kind === 'tool_result' && hidden.has(item.id)) continue;
          send('chat', { name, turn, item });
        }
      }
    });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d; if (stderr.length > 4000) stderr = stderr.slice(-4000); });
    child.on('close', (code) => {
      running.delete(name);
      if (r.result && r.session && UUID.test(r.session)) {
        try { office.sessionTurn(name, { id: r.session, title: r.title, usd: r.result.usd }); } catch (e) { send('chat', { name, turn, item: { kind: 'error', text: e.message } }); }
        outcome.set(name, r.result.limit ? 'limit' : r.refused ? 'refused' : null);
      } else {
        outcome.set(name, 'stopped');
        send('chat', { name, turn, item: { kind: 'stopped', code, text: stderr.trim().slice(-400) } });
      }
      if (!outcome.get(name)) outcome.delete(name);
      send('chat', { name, turn, item: { kind: 'end', session: r.session } });
      pushState();
      drain();
    });
    return { turn };
  }

  // Rule 6: a builder-or-tester turn waits while another runs.
  function drain() {
    const busy = [...running.values()].some((x) => TREE_KINDS.has(x.kind));
    const i = queue.findIndex((q) => !running.has(q.name) && !(busy && TREE_KINDS.has(kindOf(q.name))));
    if (i < 0) return;
    const [next] = queue.splice(i, 1);
    runTurn(next.name, next.body);
    drain();
  }

  function stopTurn(name) {
    const qi = queue.findIndex((q) => q.name === name);
    if (qi >= 0) { queue.splice(qi, 1); pushState(); return { stopped: 'queued' }; }
    const r = running.get(name);
    if (!r) throw new HttpError(409, `${name} has no turn running`);
    // Trap 2.2: the pid alone leaves its children (a pnpm, a dev server).
    if (process.platform === 'win32') execFile('taskkill', ['/PID', String(r.child.pid), '/T', '/F'], () => {});
    else { try { process.kill(-r.child.pid, 'SIGTERM'); } catch { r.child.kill('SIGTERM'); } }
    return { stopped: 'running' };
  }

  // ---------------------------------------------------------------- the routes

  const employee = (name) => {
    if (!NAME.test(name ?? '') || !office.roster().includes(name)) throw new HttpError(404, `no employee "${name}"`);
    return name;
  };

  function transcript(id) {
    if (!UUID.test(id)) throw new HttpError(404, 'no such session');
    if (!existsSync(projectsDir)) return [];
    for (const d of readdirSync(projectsDir)) {
      const f = join(projectsDir, d, `${id}.jsonl`);
      if (existsSync(f)) return readTranscript(readFileSync(f, 'utf8'), repo);
    }
    // In the index but not on disk (~/.claude cleaned, another machine):
    // an empty history, not an error; new turns still --resume it.
    return [];
  }

  const routes = [
    ['GET', /^\/api\/office$/, () => ({ ...office.snapshot(), states: states(), spent: spentToday(), cap: dailyUsd })],
    ['GET', /^\/api\/employees\/([^/]+)\/sessions$/, (m) => office.sessions(employee(m[1]))],
    ['GET', /^\/api\/employees\/([^/]+)\/sessions\/([^/]+)$/, (m) => { const name = employee(m[1]); if (!office.sessions(name).some((s) => s.id === m[2])) throw new HttpError(404, 'no such session'); return transcript(m[2]); }],
    ['POST', /^\/api\/employees\/([^/]+)\/chat$/, (m, body) => {
      const name = employee(m[1]);
      const text = typeof body.text === 'string' ? body.text.trim() : '';
      if (!text) throw new HttpError(400, 'a message is required');
      if (text.length > TEXT_LIMIT) throw new HttpError(400, `a message is at most ${TEXT_LIMIT} characters`);
      const session = body.session ?? null;
      if (session !== null && (!UUID.test(session) || !office.sessions(name).some((s) => s.id === session))) throw new HttpError(400, `"${session}" is not one of ${name}'s chats`);
      if (running.has(name) || queue.some((q) => q.name === name)) throw new HttpError(409, `${name} is already working on a turn: wait, or Stop it`);
      const spent = spentToday();
      if (spent >= dailyUsd && body.overCap !== true) throw new HttpError(402, `today's spend is ${spent.toFixed(2)} USD, at or over the ${dailyUsd} USD cap: send again to go over it`, { spent, cap: dailyUsd });
      const busy = [...running.values()].find((x) => TREE_KINDS.has(x.kind));
      if (busy && TREE_KINDS.has(kindOf(name))) { queue.push({ name, body: { session, text } }); pushState(); return { queued: true, behind: [...running.entries()].find(([, x]) => x === busy)[0] }; }
      return runTurn(name, { session, text });
    }],
    ['POST', /^\/api\/employees\/([^/]+)\/stop$/, (m) => stopTurn(employee(m[1]))],
    ['POST', /^\/api\/employees\/([^/]+)\/inbox\/ack$/, (m, body) => office.inbox(employee(m[1]), typeof body.id === 'string' ? { ack: body.id } : { ackAll: true })],
    ['POST', /^\/api\/tasks$/, (m, body) => office.taskAdd({ to: employee(body.to), from: 'user', title: body.title, why: body.why, idea: body.idea || undefined })],
    ['POST', /^\/api\/tasks\/(T-\d+)\/move$/, (m, body) => office.taskMove(m[1], body.to, { note: body.note })],
  ];

  // ---------------------------------------------------------------- the door (Rule 1)

  const tokenOk = (given) => { const a = Buffer.from(String(given ?? '')); const b = Buffer.from(token); return a.length === b.length && timingSafeEqual(a, b); };
  const cookieToken = (req) => /(?:^|;\s*)office_token=([0-9a-f]+)/.exec(req.headers.cookie ?? '')?.[1];
  const origins = () => [`http://127.0.0.1:${server.address().port}`, `http://localhost:${server.address().port}`];
  const json = (res, status, value) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); res.end(JSON.stringify(value)); };

  const readBody = (req) => new Promise((done, fail) => {
    let size = 0; const parts = [];
    req.on('data', (c) => { size += c.length; if (size > BODY_LIMIT) { fail(new HttpError(413, `a body is at most ${BODY_LIMIT} bytes`)); req.destroy(); } else parts.push(c); });
    req.on('end', () => { if (!parts.length) return done({}); try { const v = JSON.parse(Buffer.concat(parts).toString('utf8')); done(v && typeof v === 'object' && !Array.isArray(v) ? v : {}); } catch { fail(new HttpError(400, 'the body is not JSON')); } });
  });

  async function handle(req, res) {
    const url = new URL(req.url, 'http://127.0.0.1');
    // Host first: a DNS-rebound name pointing here still carries its own Host.
    const host = `http://${req.headers.host ?? ''}`;
    if (!origins().includes(host)) return json(res, 403, { error: 'this office answers on 127.0.0.1 only' });
    if (req.headers.origin && !origins().includes(req.headers.origin)) return json(res, 403, { error: 'a request from another origin' });

    if (req.method === 'GET' && url.pathname === '/') {
      if (url.searchParams.has('token')) {
        if (!tokenOk(url.searchParams.get('token'))) return json(res, 401, { error: 'wrong token: use the URL the server printed' });
        res.writeHead(303, { location: '/', 'set-cookie': `office_token=${token}; HttpOnly; SameSite=Strict; Path=/` });
        return res.end();
      }
      if (!tokenOk(cookieToken(req))) return json(res, 401, { error: 'open the URL the server printed (it carries the token)' });
      return serveFile(res, 'index.html');
    }
    if (!tokenOk(cookieToken(req))) return json(res, 401, { error: 'no token' });
    if (req.method === 'GET' && url.pathname.startsWith('/public/')) return serveFile(res, url.pathname.slice('/public/'.length));
    if (req.method === 'GET' && url.pathname === '/api/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      res.write(`event: hello\ndata: {}\n\n`);
      clients.add(res);
      const ping = setInterval(() => res.write(': ping\n\n'), 25000);
      req.on('close', () => { clearInterval(ping); clients.delete(res); });
      return;
    }
    // A POST must come from the page: browsers send Origin on every fetch POST.
    if (req.method === 'POST' && !req.headers.origin) return json(res, 403, { error: 'a POST without an Origin' });
    for (const [method, re, fn] of routes) {
      const m = re.exec(url.pathname);
      if (!m || method !== req.method) continue;
      const body = method === 'POST' ? await readBody(req) : {};
      return json(res, method === 'POST' ? 202 : 200, await fn(m, body));
    }
    return json(res, 404, { error: 'no such route' });
  }

  function serveFile(res, name) {
    const file = resolve(PUBLIC, name);
    if (!file.startsWith(PUBLIC + sep) || !existsSync(file) || !TYPES[extname(file)]) return json(res, 404, { error: 'no such file' });
    res.writeHead(200, { 'content-type': TYPES[extname(file)], 'content-security-policy': CSP, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' });
    res.end(readFileSync(file));
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((e) => {
      // ONE map from an error to a status: office.mjs refuses in words (400),
      // its lock is a 409, an HttpError carries its own.
      if (res.headersSent) return res.end();
      if (e instanceof HttpError) return json(res, e.status, { error: e.message, ...e.extra });
      if (/the office is busy/.test(e.message)) return json(res, 409, { error: e.message });
      return json(res, 400, { error: e.message });
    });
  });

  // ---------------------------------------------------------------- the watcher (Rule 4)

  let timer = null;
  const watcher = watch(join(repo, 'office'), { recursive: true }, (_type, file) => {
    if (file && /(^|[\\/])\.lock([\\/]|$)/.test(file)) return;
    // Trap 2.5: one write is several events; one `changed` per burst.
    clearTimeout(timer);
    timer = setTimeout(() => { send('changed', {}); pushState(); }, DEBOUNCE_MS);
  });

  return new Promise((done) => {
    server.listen(port, '127.0.0.1', () => {
      const url = `http://127.0.0.1:${server.address().port}`;
      done({
        url, token, server,
        close: () => new Promise((ok) => { watcher.close(); for (const r of running.values()) { try { stopTurn([...running.entries()].find(([, x]) => x === r)[0]); } catch {} } for (const c of clients) c.end(); server.close(() => ok()); }),
      });
    });
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const o = await startOffice();
  console.log(`The office is open (local only): ${o.url}/?token=${o.token}`);
  console.log(`Daily cap ${process.env.OFFICE_DAILY_USD ?? 10} USD (OFFICE_DAILY_USD). Ctrl+C closes it.`);
}
