// floor.js — the office floor (plan/office-app.md § 3.4, § 3.5): five rooms
// behind glass, each employee a seated figure at a desk with a laptop.
// Inline SVG built with createElementNS, animated by office.css only
// (Rule 7); every state is also the text line under the desk.

const SVG = 'http://www.w3.org/2000/svg';

// § 3.4, the user's default (2026-10-28): rooms by the gates they own.
export const ROOMS = [
  { id: 'product', name: 'Product', gates: 'Gates 1–2 · idea, requirements', members: ['ivy', 'rhea'] },
  { id: 'design', name: 'Design studio', gates: 'Gates 3–4 · UX, visual design', members: ['uma', 'vera'] },
  { id: 'engineering', name: 'Engineering', gates: 'Gates 5–6 · architecture, build', members: ['theo', 'finn'] },
  { id: 'front', name: 'Front office', gates: 'Intake · the record', members: ['george'] },
  { id: 'review', name: 'Review', gates: 'Gate 7 · QA, security, legal', members: ['quinn', 'sage', 'lex'] },
];

// A stable look per name: the same person every time the page loads.
const SKIN = ['#f3cfa6', '#e0ac69', '#c68642', '#8d5524', '#f8dcc0'];
const HAIR = ['#2b1d14', '#5a3a22', '#161616', '#8a5a2b', '#c99a4a', '#6b2f2f'];
const hash = (s) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
export const lookOf = (name) => { const h = hash(name); return { skin: SKIN[h % SKIN.length], hair: HAIR[(h >> 3) % HAIR.length], style: (h >> 6) % 3, sip: 18 + ((h >> 9) % 23) }; };

const el = (tag, attrs = {}, kids = []) => {
  const e = document.createElementNS(SVG, tag);
  // `style` through the CSSOM: the page's CSP (style-src 'self') refuses style attributes.
  for (const [k, v] of Object.entries(attrs)) { if (k === 'style') { for (const d of v.split(';')) { const i = d.indexOf(':'); if (i > 0) e.style.setProperty(d.slice(0, i).trim(), d.slice(i + 1).trim()); } } else e.setAttribute(k, v); }
  for (const k of kids) e.append(k);
  return e;
};

// The seated figure, the desk and the laptop, in a 200 × 180 box.
export function deskSvg(name, colour) {
  const { skin, hair, style, sip } = lookOf(name);
  const hairShapes = [
    [el('path', { d: 'M79 57 C78 36 91 29 100 29 C112 29 122 37 121 55 C114 46 103 42 90 46 C85 48 81 52 79 57 Z', fill: hair })],
    [el('path', { d: 'M78 76 L78 52 C78 35 90 28 100 28 C112 28 122 35 122 52 L122 76 L114 76 L114 52 C108 44 92 44 86 52 L86 76 Z', fill: hair })],
    [el('circle', { cx: 100, cy: 30, r: 9, fill: hair }), el('path', { d: 'M80 55 C80 38 91 33 100 33 C111 33 121 39 120 54 C112 45 90 44 80 55 Z', fill: hair })],
  ][style];
  const svg = el('svg', { viewBox: '0 0 200 180', class: 'desk-svg', 'aria-hidden': 'true', focusable: 'false', style: `--shirt:${colour};--sip-delay:${sip}s` }, [
    el('rect', { x: 60, y: 38, width: 80, height: 92, rx: 20, class: 'chair' }),
    el('g', { class: 'body' }, [
      el('path', { d: 'M56 130 C56 97 75 84 100 84 C125 84 144 97 144 130 Z', class: 'shirt' }),
      el('rect', { x: 92, y: 70, width: 16, height: 16, rx: 4, fill: skin }),
      el('g', { class: 'head' }, [
        el('circle', { cx: 100, cy: 56, r: 21, fill: skin }),
        ...hairShapes,
        el('g', { class: 'eyes' }, [el('circle', { cx: 92.5, cy: 58, r: 2.2, class: 'eye' }), el('circle', { cx: 107.5, cy: 58, r: 2.2, class: 'eye' })]),
        el('path', { d: 'M94 66 Q100 70 106 66', class: 'mouth' }),
        el('ellipse', { cx: 100, cy: 64, rx: 26, ry: 22, class: 'glow' }),
      ]),
      el('path', { d: 'M68 98 C60 108 62 120 72 126', class: 'arm arm-l' }),
      el('path', { d: 'M132 98 C140 108 138 120 128 126', class: 'arm arm-r' }),
      el('circle', { cx: 72, cy: 126, r: 6, fill: skin, class: 'hand hand-l' }),
      el('circle', { cx: 128, cy: 126, r: 6, fill: skin, class: 'hand hand-r' }),
    ]),
    el('rect', { x: 8, y: 128, width: 184, height: 10, rx: 3, class: 'desk-top' }),
    el('rect', { x: 18, y: 138, width: 164, height: 36, rx: 2, class: 'desk-front' }),
    el('g', { class: 'laptop-open' }, [
      el('path', { d: 'M74 128 L78 98 L122 98 L126 128 Z', class: 'lid' }),
      el('circle', { cx: 100, cy: 113, r: 4, class: 'logo' }),
    ]),
    el('rect', { x: 74, y: 123, width: 52, height: 5, rx: 2, class: 'laptop-closed lid' }),
    el('g', { class: 'mug' }, [
      el('rect', { x: 150, y: 110, width: 15, height: 18, rx: 3, class: 'mug-body' }),
      el('path', { d: 'M165 114 C172 114 172 124 165 124', class: 'mug-handle' }),
      el('path', { d: 'M155 106 C152 100 158 98 155 92', class: 'steam' }),
    ]),
    el('g', { class: 'plant' }, [
      el('rect', { x: 22, y: 114, width: 16, height: 14, rx: 2, class: 'pot' }),
      el('path', { d: 'M30 114 C22 104 22 96 28 92 C30 100 30 106 30 114 Z M30 114 C38 104 40 98 36 90 C32 98 31 106 30 114 Z', class: 'leaf' }),
    ]),
  ]);
  return svg;
}

// What the desk shows, from the snapshot and the server's live state
// (§ 3.3). Derived here, never stored.
export function deriveState(emp, live = {}) {
  if (live.state === 'working') return { state: 'working', line: `Working${live.tool ? `: ${live.tool}` : '…'}` };
  if (live.state === 'queued') return { state: 'queued', line: `Waits for ${live.behind ?? 'the tree'}` };
  if (live.state === 'refused') return { state: 'refused', line: 'The guard refused a call' };
  if (live.state === 'limit') return { state: 'limit', line: 'Session limit reached' };
  if (live.state === 'stopped') return { state: 'stopped', line: 'Stopped' };
  const doing = emp.board?.doing ?? [];
  const inbox = emp.board?.inbox ?? [];
  if (emp.unread || inbox.length) return { state: 'ready', line: [emp.unread ? `${emp.unread} unread` : '', inbox.length ? `${inbox.length} in inbox` : ''].filter(Boolean).join(' · ') };
  if (doing.length) return { state: 'doing', line: `Doing: ${doing[0].title}` };
  return { state: 'away', line: 'Free' };
}

const STATE_WORD = { working: 'working', queued: 'queued', refused: 'refused', limit: 'at the session limit', stopped: 'stopped', ready: 'has work waiting', doing: 'doing a task', away: 'free' };
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

export function renderFloor(root, snap, onOpen) {
  root.replaceChildren();
  const known = new Set(ROOMS.flatMap((r) => r.members));
  const extra = snap.employees.map((e) => e.name).filter((n) => !known.has(n));
  const rooms = extra.length ? [...ROOMS, { id: 'annex', name: 'Annex', gates: 'New hires', members: extra }] : ROOMS;
  for (const room of rooms) {
    const members = room.members.map((n) => snap.employees.find((e) => e.name === n)).filter(Boolean);
    if (!members.length) continue;
    const section = document.createElement('section');
    section.className = `room room-${room.id}`;
    section.dataset.room = room.id;
    section.style.setProperty('--desks', members.length);
    section.setAttribute('aria-labelledby', `room-${room.id}`);
    const sign = document.createElement('header');
    sign.className = 'room-sign';
    const h = document.createElement('h2'); h.id = `room-${room.id}`; h.textContent = room.name;
    const g = document.createElement('p'); g.textContent = room.gates;
    sign.append(h, g);
    const desks = document.createElement('div');
    desks.className = 'desks';
    for (const emp of members) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'desk';
      b.dataset.name = emp.name;
      b.style.setProperty('--colour', emp.colourHex);
      b.addEventListener('click', () => onOpen(emp.name));
      const badges = document.createElement('span'); badges.className = 'badges'; badges.setAttribute('aria-hidden', 'true');
      const label = document.createElement('span'); label.className = 'desk-label';
      const nm = document.createElement('span'); nm.className = 'desk-name'; nm.textContent = cap(emp.name);
      const tt = document.createElement('span'); tt.className = 'desk-title'; tt.textContent = emp.title;
      const st = document.createElement('span'); st.className = 'desk-status';
      label.append(nm, tt, st);
      b.append(badges, deskSvg(emp.name, emp.colourHex), label);
      desks.append(b);
    }
    section.append(sign, desks, Object.assign(document.createElement('div'), { className: 'room-floor', ariaHidden: 'true' }));
    root.append(section);
  }
}

// States change far more often than the roster: update in place, so an
// animation already running is not restarted by a redraw.
export function updateFloor(root, snap, live) {
  for (const emp of snap.employees) {
    const b = root.querySelector(`.desk[data-name="${emp.name}"]`);
    if (!b) continue;
    const { state, line } = deriveState(emp, live[emp.name]);
    b.dataset.state = state;
    b.querySelector('.desk-status').textContent = line;
    b.setAttribute('aria-label', `${cap(emp.name)}, ${emp.title}, ${STATE_WORD[state]}: ${line}. Open chat, board and inbox.`);
    const badges = b.querySelector('.badges');
    badges.replaceChildren();
    if (emp.unread) badges.append(Object.assign(document.createElement('span'), { className: 'badge badge-mail', textContent: `✉ ${emp.unread}` }));
    if (state === 'queued') badges.append(Object.assign(document.createElement('span'), { className: 'badge', textContent: '⌛' }));
    if (state === 'limit') badges.append(Object.assign(document.createElement('span'), { className: 'badge badge-danger', textContent: '◷' }));
  }
}

// A brief motion on one desk: 'lookup' when a message arrives, 'flash' on a refusal.
export function pulse(root, name, cls, ms) {
  const b = root.querySelector(`.desk[data-name="${name}"]`);
  if (!b) return;
  b.classList.remove(cls); void b.offsetWidth; b.classList.add(cls);
  setTimeout(() => b.classList.remove(cls), ms);
}

// Switching to reduced motion lands any plane still in the air (Rule 7).
matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', (e) => {
  if (e.matches) for (const p of document.querySelectorAll('.plane')) { for (const a of p.getAnimations()) a.cancel(); p.remove(); }
});

// The ONE motion that crosses rooms (§ 3.5): a paper plane from the desk
// that handed a task to the desk that received it.
export function flyPlane(root, from, to) {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const a = root.querySelector(`.desk[data-name="${from}"] .desk-svg`);
  const b = root.querySelector(`.desk[data-name="${to}"] .desk-svg`);
  if (!a || !b) return;
  const ra = a.getBoundingClientRect(); const rb = b.getBoundingClientRect();
  const plane = el('svg', { viewBox: '0 0 24 24', class: 'plane', 'aria-hidden': 'true' }, [el('path', { d: 'M2 11 L22 3 L15 21 L11 13 Z M11 13 L22 3' })]);
  document.body.append(plane);
  const x0 = ra.left + ra.width / 2; const y0 = ra.top + ra.height * 0.4;
  const x1 = rb.left + rb.width / 2; const y1 = rb.top + rb.height * 0.4;
  const mx = (x0 + x1) / 2; const my = Math.min(y0, y1) - 120;
  const at = (t) => { const u = 1 - t; return [u * u * x0 + 2 * u * t * mx + t * t * x1, u * u * y0 + 2 * u * t * my + t * t * y1]; };
  const frames = [0, 0.25, 0.5, 0.75, 1].map((t) => { const [x, y] = at(t); return { transform: `translate(${x - 12}px, ${y - 12}px) rotate(${(x1 > x0 ? 0 : 180) + (t - 0.5) * 40}deg)` }; });
  plane.animate(frames, { duration: 1200, easing: 'ease-in-out' }).finished.then(() => { plane.remove(); pulse(root, to, 'lookup', 1000); }, () => plane.remove());
}
