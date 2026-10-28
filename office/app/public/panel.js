// panel.js — one employee's panel (plan/office-app.md § 3.6): Chat, Board,
// Inbox. Every write goes to the server, which goes to office.mjs; the
// panel redraws from the snapshot the watcher brings back (Rule 4).

import { blocks } from './text.js';

const h = (tag, props = {}, kids = []) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k === 'style') { for (const d of v.split(';')) { const i = d.indexOf(':'); if (i > 0) e.style.setProperty(d.slice(0, i).trim(), d.slice(i + 1).trim()); } }
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v === true) e.setAttribute(k, '');
    else if (v !== false && v != null) e.setAttribute(k, v);
  }
  for (const c of [].concat(kids)) if (c != null) e.append(c);
  return e;
};
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const usd = (n) => `${(n ?? 0).toFixed(2)} USD`;
const GUARD_WORDS = (g) => !g ? 'no guard' : g.kind === 'read-only' ? 'read-only: writes under office/ only'
  : g.kind.startsWith('author:') ? `writes under ${(g.writes ?? []).filter((w) => w !== 'office/').join(', ') || 'its folder'} only`
  : g.kind === 'tester' ? 'tester: writes tests and docs/qa/ only' : g.kind === 'builder' ? 'builder: writes the code; never commits or deploys' : g.kind;

// Spans and blocks (text.js) → elements, every string as textContent.
const renderSpans = (spans) => spans.map((s) => s.code ? h('code', { text: s.text }) : s.bold ? h('strong', { text: s.text }) : document.createTextNode(s.text));
export function renderText(text) {
  const frag = document.createDocumentFragment();
  for (const b of blocks(text)) {
    if (b.type === 'p') frag.append(h('p', {}, renderSpans(b.spans)));
    else if (b.type === 'h') frag.append(h('p', { class: 'msg-h' }, renderSpans(b.spans)));
    else if (b.type === 'ul' || b.type === 'ol') frag.append(h(b.type, {}, b.items.map((i) => h('li', {}, renderSpans(i)))));
    else if (b.type === 'code') frag.append(h('pre', {}, h('code', { text: b.text })));
    else if (b.type === 'table') frag.append(h('div', { class: 'table-wrap' }, h('table', {}, [h('thead', {}, h('tr', {}, b.head.map((c) => h('th', { scope: 'col' }, renderSpans(c))))), h('tbody', {}, b.rows.map((r) => h('tr', {}, r.map((c) => h('td', {}, renderSpans(c))))))])));
  }
  return frag;
}

export class Panel {
  constructor(root, { api, ask, notice, getSnap, getLive }) {
    Object.assign(this, { root, api, ask, notice, getSnap, getLive });
    this.name = null;
    this.tab = 'chat';
    this.session = null; // the open chat's id; null = a new chat
    this.live = new Map(); // name → { turn, items[] } of the running turn
    root.addEventListener('keydown', (e) => { if (e.key === 'Escape') this.close(); });
  }

  emp() { return this.getSnap().employees.find((e) => e.name === this.name); }

  open(name, tab) {
    const changed = this.name !== name;
    this.name = name;
    if (tab) this.tab = tab;
    if (changed) { const s = this.emp()?.sessions ?? []; this.session = s.length ? s[s.length - 1].id : null; }
    this.root.hidden = false;
    document.body.classList.add('panel-open');
    this.draw();
    if (changed) this.loadSession();
    this.root.querySelector('.panel-close')?.focus();
  }

  close() {
    if (this.root.hidden) return;
    const was = this.name;
    this.root.hidden = true; this.name = null;
    document.body.classList.remove('panel-open');
    document.querySelector(`.desk[data-name="${was}"]`)?.focus();
  }

  // ------------------------------------------------------------ the frame

  draw() {
    const emp = this.emp();
    if (!emp) return this.close();
    const live = this.getLive()[emp.name] ?? {};
    const tabs = [['chat', 'Chat'], ['board', `Board (${(emp.board.doing?.length ?? 0) + (emp.board.inbox?.length ?? 0)})`], ['inbox', `Inbox${emp.unread ? ` (${emp.unread})` : ''}`]];
    const tablist = h('div', { class: 'tabs', role: 'tablist', 'aria-label': `${cap(emp.name)}'s panel` }, tabs.map(([id, label]) => h('button', {
      type: 'button', role: 'tab', id: `tab-${id}`, 'aria-controls': `pane-${id}`, 'aria-selected': String(this.tab === id), tabindex: this.tab === id ? '0' : '-1', text: label,
      onclick: () => { this.tab = id; this.draw(); this.root.querySelector(`#tab-${id}`).focus(); },
      onkeydown: (e) => { const i = tabs.findIndex(([t]) => t === id); const n = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0; if (n) { this.tab = tabs[(i + n + tabs.length) % tabs.length][0]; this.draw(); this.root.querySelector(`#tab-${this.tab}`).focus(); } },
    })));
    const keepLog = this.root.querySelector('.chat-log');
    const keepDraft = this.root.querySelector('#composer-text')?.value ?? '';
    // The watcher redraws on every file change, often while you type: keep
    // the focused control and its cursor across the redraw.
    const active = this.root.contains(document.activeElement) ? document.activeElement : null;
    const focusId = active?.id || null;
    const caret = active && 'selectionStart' in active ? [active.selectionStart, active.selectionEnd] : null;
    queueMicrotask(() => {
      // Only when the redraw LOST focus: a handler that focused something itself wins.
      if (this.root.contains(document.activeElement) && document.activeElement !== document.body) return;
      const again = focusId && this.root.querySelector(`#${CSS.escape(focusId)}`);
      if (again) { again.focus(); if (caret && 'setSelectionRange' in again) again.setSelectionRange(...caret); }
    });
    this.root.replaceChildren(
      h('header', { class: 'panel-head', style: `--colour:${emp.colourHex}` }, [
        h('div', { class: 'panel-avatar', 'aria-hidden': 'true', text: emp.name.slice(0, 2).toUpperCase() }),
        h('div', { class: 'panel-who' }, [
          h('h2', { id: 'panel-title', text: cap(emp.name) }),
          h('p', { text: `${emp.title} · ${emp.pronouns}` }),
          h('p', { class: 'panel-guard', text: GUARD_WORDS(emp.guard) }),
        ]),
        h('button', { type: 'button', class: 'panel-close', 'aria-label': `Close ${cap(emp.name)}'s panel`, text: '×', onclick: () => this.close() }),
      ]),
      tablist,
      h('div', { class: 'pane', role: 'tabpanel', id: `pane-${this.tab}`, 'aria-labelledby': `tab-${this.tab}` },
        this.tab === 'chat' ? this.chatPane(emp, live, keepLog, keepDraft) : this.tab === 'board' ? this.boardPane(emp) : this.inboxPane(emp)),
    );
    this.root.setAttribute('aria-labelledby', 'panel-title');
  }

  // ------------------------------------------------------------ Chat

  chatPane(emp, live, keepLog, keepDraft) {
    const sessions = emp.sessions ?? [];
    const working = live.state === 'working' || live.state === 'queued';
    const select = h('select', { id: 'session-select', 'aria-label': 'Chat', onchange: (e) => { this.session = e.target.value || null; this.loadSession(); } }, [
      h('option', { value: '', text: 'New chat' }),
      ...[...sessions].reverse().map((s) => h('option', { value: s.id, text: `${s.title} · ${s.turns} turn${s.turns === 1 ? '' : 's'} · ${usd(s.usd)}`, selected: s.id === this.session })),
    ]);
    const log = keepLog ?? h('div', { class: 'chat-log', role: 'log', 'aria-live': 'polite', 'aria-label': 'Messages' });
    const text = h('textarea', { id: 'composer-text', rows: '3', placeholder: `Message ${cap(emp.name)}…`, 'aria-label': `Message ${cap(emp.name)}`, onkeydown: (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); this.send(text.value); } } });
    text.value = keepDraft;
    return [
      h('div', { class: 'chat-bar' }, [select, h('button', { type: 'button', class: 'btn', text: 'New chat', onclick: () => { this.session = null; select.value = ''; this.loadSession(); } })]),
      log,
      h('form', { class: 'composer', onsubmit: (e) => { e.preventDefault(); this.send(text.value); } }, [
        text,
        h('div', { class: 'composer-row' }, [
          h('span', { class: 'composer-hint', text: working ? (live.state === 'queued' ? `Queued behind ${cap(live.behind ?? 'another turn')}` : 'Working…') : 'Enter sends · Shift+Enter is a new line' }),
          working ? h('button', { type: 'button', class: 'btn btn-danger', text: 'Stop', onclick: () => this.stop() }) : h('button', { type: 'submit', class: 'btn btn-primary', text: 'Send' }),
        ]),
      ]),
    ];
  }

  async loadSession() {
    const log = this.root.querySelector('.chat-log');
    if (!log || !this.name) return;
    log.replaceChildren();
    const name = this.name;
    const live = this.live.get(name);
    if (this.session) {
      try {
        const msgs = await this.api('GET', `/api/employees/${name}/sessions/${this.session}`);
        if (this.name !== name) return;
        if (!msgs.length) log.append(h('p', { class: 'chat-note', text: 'The transcript of this chat is not on this machine (Claude Code keeps it under ~/.claude/projects). New turns still continue it.' }));
        for (const m of msgs) this.addMessage(log, m.role, m.text, m.tools);
      } catch (e) { log.append(h('p', { class: 'chat-note', text: `This chat's transcript could not be read (${e.message}). New turns still continue it.` })); }
    } else if (!live) {
      log.append(h('p', { class: 'chat-note', text: `A new chat with ${cap(name)}. It runs as claude --agent ${name}, under ${name === 'george' ? 'her' : 'their'} charter and guard; each turn's cost shows under it.` }));
    }
    if (live && (live.session === this.session || (!this.session && !live.session) || live.session === null)) for (const item of live.items) this.drawItem(log, item);
    log.scrollTop = log.scrollHeight;
  }

  addMessage(log, role, text, tools = []) {
    const m = h('div', { class: `msg msg-${role}` }, [h('p', { class: 'msg-who', text: role === 'user' ? 'You' : cap(this.name) })]);
    const body = h('div', { class: 'msg-body' });
    if (role === 'assistant') body.append(renderText(text)); else body.textContent = text;
    for (const t of tools) m.append(this.toolLine(t));
    m.append(body);
    log.append(m);
    return m;
  }

  toolLine(t) {
    const d = h('details', { class: `tool${t.refused ? ' tool-refused' : t.error ? ' tool-error' : ''}`, 'data-tool': t.id }, [
      h('summary', {}, [h('span', { class: 'tool-name', text: t.refused ? `${t.name} refused` : t.name }), h('span', { class: 'tool-sum', text: t.summary ?? '' })]),
      h('pre', { class: 'tool-result', text: t.result ?? '…' }),
    ]);
    return d;
  }

  // One streamed item (server.mjs slim()) drawn into the open log.
  drawItem(log, item) {
    const last = () => log.querySelector('.msg-assistant:last-of-type');
    if (item.kind === 'user') { this.addMessage(log, 'user', item.text); this.cur = null; }
    else if (item.kind === 'message') { this.cur = null; }
    else if (item.kind === 'delta') {
      if (!this.cur) { this.cur = this.addMessage(log, 'assistant', ''); this.cur.raw = ''; this.cur.final = ''; }
      this.cur.raw += item.text;
      this.cur.querySelector('.msg-body').textContent = this.cur.final + this.cur.raw;
    } else if (item.kind === 'text') {
      if (!this.cur) { this.cur = this.addMessage(log, 'assistant', ''); this.cur.raw = ''; this.cur.final = ''; }
      this.cur.final += (this.cur.final ? '\n\n' : '') + item.text;
      this.cur.raw = '';
      const body = this.cur.querySelector('.msg-body'); body.replaceChildren(renderText(this.cur.final));
    } else if (item.kind === 'tool') {
      const host = this.cur ?? last() ?? this.addMessage(log, 'assistant', '');
      host.insertBefore(this.toolLine(item), host.querySelector('.msg-body'));
    } else if (item.kind === 'tool_result') {
      const d = log.querySelector(`details[data-tool="${CSS.escape(item.id)}"]`);
      if (d) { d.querySelector('.tool-result').textContent = item.text; if (item.refused) { d.classList.add('tool-refused'); d.querySelector('.tool-name').textContent += ' refused'; d.open = true; } else if (item.error) d.classList.add('tool-error'); }
    } else if (item.kind === 'result') {
      log.append(h('p', { class: `chat-cost${item.error ? ' chat-cost-error' : ''}`, text: item.limit ? `Session limit: ${item.text}` : item.error ? `Ended with an error: ${item.text}` : `${usd(item.usd)} · ${item.seconds} s` }));
    } else if (item.kind === 'stopped') {
      log.append(h('p', { class: 'chat-cost chat-cost-error', text: `Stopped${item.text ? `: ${item.text}` : ''}. No cost was reported for this turn.` }));
    } else if (item.kind === 'error') {
      log.append(h('p', { class: 'chat-cost chat-cost-error', text: item.text }));
    }
    log.scrollTop = log.scrollHeight;
  }

  // Every chat event from the server, for any employee.
  onChat({ name, turn, item }) {
    let live = this.live.get(name);
    if (item.kind === 'user') { live = { turn, session: null, items: [] }; this.live.set(name, live); }
    if (!live) return;
    if (item.kind === 'init') live.session = item.session;
    live.items.push(item);
    if (this.name === name && this.tab === 'chat') {
      if (item.kind === 'init' && !this.session) this.session = item.session;
      const log = this.root.querySelector('.chat-log');
      if (log && (live.session === this.session || item.kind === 'user')) this.drawItem(log, item);
    }
    if (item.kind === 'end') { this.live.delete(name); }
  }

  async send(raw, overCap = false) {
    const text = raw.trim();
    if (!text || !this.name) return;
    const name = this.name;
    try {
      const r = await this.api('POST', `/api/employees/${name}/chat`, { text, session: this.session, overCap });
      const box = this.root.querySelector('#composer-text'); if (box) box.value = '';
      if (r.queued) this.notice(`${cap(name)} is queued behind ${cap(r.behind)}: one builder or tester works on the tree at a time.`);
    } catch (e) {
      if (e.status === 402) {
        const ok = await this.ask({ title: 'Over the daily cap', message: `${e.message}.`, confirm: 'Send anyway' });
        if (ok) return this.send(raw, true);
        return;
      }
      this.notice(e.message, true);
    }
  }

  async stop() {
    try { await this.api('POST', `/api/employees/${this.name}/stop`, {}); } catch (e) { this.notice(e.message, true); }
  }

  // ------------------------------------------------------------ Board

  boardPane(emp) {
    const COLS = [['doing', 'Doing'], ['inbox', 'Inbox'], ['done', 'Done'], ['dropped', 'Dropped']];
    const ideas = this.getSnap().ideas ?? [];
    const board = h('div', { class: 'board' }, COLS.map(([key, title]) => {
      const list = emp.board[key] ?? [];
      const col = h('section', { class: `col col-${key}`, 'aria-labelledby': `col-${key}`, 'data-col': key }, [
        h('h3', { id: `col-${key}`, text: `${title} (${list.length})` }),
        h('ol', { class: 'cards' }, (key === 'done' || key === 'dropped' ? [...list].reverse() : list).map((t) => this.card(t, key))),
      ]);
      if (key !== 'inbox') {
        col.addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes('text/task')) { e.preventDefault(); col.classList.add('drop'); } });
        col.addEventListener('dragleave', () => col.classList.remove('drop'));
        col.addEventListener('drop', (e) => { e.preventDefault(); col.classList.remove('drop'); this.move(e.dataTransfer.getData('text/task'), key); });
      }
      return col;
    }));
    const add = h('form', { class: 'add-task', onsubmit: async (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      try { const t = await this.api('POST', '/api/tasks', { to: emp.name, title: f.get('title'), why: f.get('why'), idea: f.get('idea') || undefined }); this.notice(`${t.id} added to ${cap(emp.name)}'s inbox.`); e.target.reset(); } catch (err) { this.notice(err.message, true); }
    } }, [
      h('h3', { text: 'Add a task' }),
      h('label', { for: 'task-title', text: 'Title' }), h('input', { id: 'task-title', name: 'title', required: true, maxlength: '200' }),
      h('label', { for: 'task-why', text: 'Why' }), h('input', { id: 'task-why', name: 'why', required: true, maxlength: '600' }),
      h('label', { for: 'task-idea', text: 'Idea (optional)' }), h('select', { id: 'task-idea', name: 'idea' }, [h('option', { value: '', text: 'None' }), ...ideas.map((i) => h('option', { value: i.slug, text: `${i.slug} · ${i.status}` }))]),
      h('button', { type: 'submit', class: 'btn btn-primary', text: `Add to ${cap(emp.name)}'s inbox` }),
    ]);
    return [board, add];
  }

  card(t, key) {
    const open = key === 'doing' || key === 'inbox';
    const li = h('li', { class: 'card', draggable: open ? 'true' : 'false', 'data-task': t.id }, [
      h('details', {}, [
        h('summary', {}, [h('span', { class: 'card-id', text: t.id }), h('span', { class: 'card-title', text: t.title })]),
        h('p', { class: 'card-meta', text: `from ${t.from} · ${t.date}${t.idea ? ` · idea ${t.idea}` : ''}` }),
        h('p', { class: 'card-why', text: t.why }),
        t.note ? h('p', { class: 'card-note', text: `${t.closedAs} ${t.closedOn}: ${t.note}` }) : null,
        open ? h('div', { class: 'card-actions' }, [
          key === 'inbox' ? h('button', { type: 'button', class: 'btn', text: 'Start (Doing)', onclick: () => this.move(t.id, 'doing') }) : null,
          h('button', { type: 'button', class: 'btn', text: 'Done…', onclick: () => this.move(t.id, 'done') }),
          h('button', { type: 'button', class: 'btn', text: 'Drop…', onclick: () => this.move(t.id, 'dropped') }),
        ]) : null,
      ]),
    ]);
    if (open) li.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/task', t.id); e.dataTransfer.effectAllowed = 'move'; });
    return li;
  }

  async move(id, to) {
    let note;
    if (to === 'done' || to === 'dropped') {
      note = await this.ask({ title: `${to === 'done' ? 'Done' : 'Drop'} ${id}`, message: 'A task closes with a note (D-096\'s rule for the office).', input: 'Note', confirm: to === 'done' ? 'Mark done' : 'Drop it' });
      if (!note) return;
    }
    try { await this.api('POST', `/api/tasks/${id}/move`, { to, note }); this.notice(`${id} moved to ${to}.`); } catch (e) { this.notice(e.message, true); }
  }

  // ------------------------------------------------------------ Inbox

  inboxPane(emp) {
    const msgs = [...emp.inbox].reverse().sort((a, b) => Number(a.read) - Number(b.read));
    return [
      h('div', { class: 'inbox-bar' }, [
        h('p', { text: `${emp.unread} unread of ${emp.inbox.length}` }),
        h('button', { type: 'button', class: 'btn', disabled: !emp.unread, text: 'Mark all read', onclick: async () => { try { await this.api('POST', `/api/employees/${emp.name}/inbox/ack`, {}); this.notice('Marked read.'); } catch (e) { this.notice(e.message, true); } } }),
      ]),
      msgs.length ? h('ol', { class: 'messages' }, msgs.map((m) => h('li', { class: `message${m.read ? '' : ' unread'}` }, [
        h('p', { class: 'message-meta', text: `${m.id} · ${m.at} · from ${m.from}${m.read ? '' : ' · unread'}` }),
        h('p', { class: 'message-text' }, this.linked(m.text)),
        m.read ? null : h('button', { type: 'button', class: 'btn btn-small', text: 'Mark read', onclick: async () => { try { await this.api('POST', `/api/employees/${emp.name}/inbox/ack`, { id: m.id }); } catch (e) { this.notice(e.message, true); } } }),
      ]))) : h('p', { class: 'empty', text: `${cap(emp.name)}'s inbox is empty.` }),
    ];
  }

  // T-### opens the board on that card; everything else stays text.
  linked(text) {
    return text.split(/\b(T-\d{3,})\b/).map((part, i) => i % 2 ? h('button', { type: 'button', class: 'link', text: part, onclick: () => this.openTask(part) }) : document.createTextNode(part));
  }

  openTask(id) {
    const owner = this.getSnap().employees.find((e) => Object.values(e.board).some((l) => l.some((t) => t.id === id)));
    if (!owner) return this.notice(`${id} is on no board.`, true);
    this.open(owner.name, 'board');
    const card = this.root.querySelector(`.card[data-task="${id}"]`);
    if (card) { card.querySelector('details').open = true; card.scrollIntoView({ block: 'nearest' }); card.querySelector('summary').focus(); }
  }
}
