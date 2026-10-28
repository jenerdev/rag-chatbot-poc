// office.js — the page's store: one snapshot from the server, kept fresh by
// its event stream (plan/office-app.md Rule 4), drawn by floor.js and
// panel.js. It holds nothing the files do not.

import { flyPlane, pulse, renderFloor, updateFloor } from './floor.js';
import { Panel } from './panel.js';

const $ = (s) => document.querySelector(s);
let snap = null;
let live = {};
let roster = '';

async function api(method, path, body) {
  const r = await fetch(path, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined, credentials: 'same-origin' });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(j.error ?? r.statusText); e.status = r.status; e.body = j; throw e; }
  return j;
}

// ONE toast at a time, read by screen readers; a refusal stays until closed.
function notice(text, bad = false) {
  const t = $('#toast');
  t.replaceChildren(Object.assign(document.createElement('span'), { textContent: text }));
  t.className = `toast show${bad ? ' bad' : ''}`;
  clearTimeout(notice.timer);
  if (!bad) notice.timer = setTimeout(() => { t.className = 'toast'; }, 4000);
  else { const x = Object.assign(document.createElement('button'), { type: 'button', className: 'toast-close', textContent: 'Dismiss' }); x.addEventListener('click', () => { t.className = 'toast'; }); t.append(x); }
}

// A question in the native <dialog> (focus kept inside, Escape cancels).
function ask({ title, message, input, confirm = 'OK' }) {
  const d = $('#ask');
  $('#ask-title').textContent = title;
  $('#ask-message').textContent = message;
  const field = $('#ask-input'); const label = $('#ask-label');
  label.hidden = field.hidden = !input;
  label.textContent = input ?? ''; field.value = ''; field.required = !!input;
  $('#ask-ok').textContent = confirm;
  d.showModal();
  if (input) field.focus();
  return new Promise((done) => {
    d.addEventListener('close', () => done(d.returnValue === 'ok' ? (input ? field.value.trim() || null : true) : null), { once: true });
  });
}

const panel = new Panel($('#panel'), { api, ask, notice, getSnap: () => snap, getLive: () => live });

function drawTop() {
  $('#spent').textContent = `Today ${(snap.spent ?? 0).toFixed(2)} of ${snap.cap} USD`;
  $('#spent').classList.toggle('over', snap.spent >= snap.cap);
  const p = $('#problems');
  p.hidden = !snap.problems.length;
  p.textContent = snap.problems.length ? `office:check: ${snap.problems.length} problem${snap.problems.length === 1 ? '' : 's'} — ${snap.problems[0]}` : '';
  const working = Object.values(live).filter((s) => s.state === 'working').length;
  $('#busy').textContent = working ? `${working} working` : 'Nobody working';
}

function drawPipeline() {
  const root = $('#pipeline-rungs');
  root.replaceChildren();
  for (const rung of snap.ladder) {
    const ideas = snap.ideas.filter((i) => i.status === rung);
    const col = document.createElement('li');
    col.className = 'rung';
    const head = Object.assign(document.createElement('h3'), { textContent: `${rung} (${ideas.length})` });
    const list = document.createElement('ul');
    for (const i of ideas) {
      const li = document.createElement('li');
      const d = document.createElement('details'); d.className = `idea idea-${i.lane}`;
      const s = document.createElement('summary'); s.textContent = i.slug;
      const t = Object.assign(document.createElement('p'), { textContent: `${i.title} · ${i.lane} lane` });
      const g = document.createElement('ol');
      for (const gate of i.gates) g.append(Object.assign(document.createElement('li'), { textContent: `${gate.gate} · ${gate.verdict} · ${gate.by} · ${gate.date}` }));
      d.append(s, t, g); li.append(d); list.append(li);
    }
    col.append(head, list);
    root.append(col);
  }
}

// Loads run one at a time: two overlapping ones would diff against the same
// old snapshot and fly the same handoff's plane twice (found by the walk).
let loading = Promise.resolve();
function load() { loading = loading.then(loadOnce, loadOnce); return loading; }
async function loadOnce() {
  const prev = snap;
  snap = await api('GET', '/api/office');
  live = snap.states ?? {};
  const names = snap.employees.map((e) => e.name).join(',');
  if (names !== roster) { renderFloor($('#floor'), snap, (n) => panel.open(n)); roster = names; }
  updateFloor($('#floor'), snap, live);
  drawTop();
  drawPipeline();
  if (!$('#panel').hidden) panel.draw();
  // A task that appeared on one board, sent by another employee: the plane.
  if (prev) {
    const had = new Set(prev.employees.flatMap((e) => Object.values(e.board).flat().map((t) => t.id)));
    for (const e of snap.employees) for (const t of [...e.board.inbox, ...e.board.doing]) if (!had.has(t.id) && t.from !== 'user' && t.from !== e.name) flyPlane($('#floor'), t.from, e.name);
    for (const e of snap.employees) { const before = prev.employees.find((x) => x.name === e.name); if (before && e.unread > before.unread) pulse($('#floor'), e.name, 'lookup', 1000); }
  }
}

function connect() {
  const es = new EventSource('/api/events');
  es.addEventListener('changed', () => load().catch((e) => notice(e.message, true)));
  es.addEventListener('state', (e) => {
    const d = JSON.parse(e.data);
    const before = live;
    live = d.states; snap.spent = d.spent; snap.cap = d.cap;
    for (const [n, s] of Object.entries(live)) if (s.state === 'refused' && before[n]?.state !== 'refused') pulse($('#floor'), n, 'flash', 2000);
    updateFloor($('#floor'), snap, live);
    drawTop();
    if (!$('#panel').hidden) panel.draw();
  });
  es.addEventListener('chat', (e) => panel.onChat(JSON.parse(e.data)));
  es.onerror = () => { $('#busy').textContent = 'Reconnecting…'; };
  es.addEventListener('hello', () => load().catch((e) => notice(e.message, true)));
}

$('#pipeline-toggle').addEventListener('click', () => {
  const p = $('#pipeline'); const open = p.hidden;
  p.hidden = !open; $('#pipeline-toggle').setAttribute('aria-expanded', String(open));
});
$('#ask-form').addEventListener('submit', (e) => { if (e.submitter?.value === 'ok' && !$('#ask-input').hidden && !$('#ask-input').value.trim()) e.preventDefault(); });

load().then(connect).catch((e) => notice(`The office could not load: ${e.message}`, true));
window.office = { get snap() { return snap; }, get live() { return live; }, panel };
