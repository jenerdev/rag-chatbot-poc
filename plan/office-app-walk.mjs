// office-app-walk.mjs — plan/office-app.md Phases 3 and 4, in a browser.
//
//   node plan/office-app-walk.mjs
//   (AXE=<path to axe.min.js>, default plan/ui-refresh/axe/axe.min.js, git-ignored:
//    (cd plan/ui-refresh && npm pack axe-core && tar -xzf axe-core-*.tgz && mv package axe))
//
// The server runs in-process on a temporary COPY of this repo's office (so
// the walk's chats and tasks never touch the real boards) and on the fake
// claude (so nothing is spent). Checks print one line each; shots go to
// plan/office-app/walk/.

import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openBrowser } from './ui-refresh-cdp.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const SHOTS = join(HERE, 'office-app', 'walk');
const AXE_FILE = process.env.AXE ?? join(HERE, 'ui-refresh', 'axe', 'axe.min.js');
const AXE = existsSync(AXE_FILE) ? readFileSync(AXE_FILE, 'utf8') : null;

// A copy of the office, the agents, the skills and the settings: what check() reads.
const tmp = mkdtempSync(join(tmpdir(), 'office-walk-'));
for (const p of ['office/employees', 'office/pipeline.md', 'office/sequence.json', '.claude/settings.json', '.claude/agents', '.claude/skills', 'plan/ai-employees/organization.md', 'status.md', 'whats-done.md', 'decisions.md', 'risks.md', 'docs', 'plan/analytics.md', 'plan/free-guests.md', 'plan/office-app.md']) {
  if (existsSync(join(REPO, p))) cpSync(join(REPO, p), join(tmp, p), { recursive: true });
}
process.env.OFFICE_REPO = tmp;
const office = await import('../office/office.mjs');
const { startOffice } = await import('../office/app/server.mjs');
for (const n of office.roster()) rmSync(join(tmp, 'office', 'employees', n, 'sessions.json'), { force: true });
const o = await startOffice({ port: 0, claude: join(REPO, 'office', 'app', 'test', 'fake-claude.mjs'), projectsDir: join(tmp, 'projects'), dailyUsd: 10 });

const results = [];
const check = async (label, fn) => {
  try { await fn(); results.push([true, label]); console.log(`✔ ${label}`); }
  catch (e) { results.push([false, label]); console.log(`✘ ${label}: ${e.message.replace(/\s+/g, ' ').slice(0, 500)}`); }
};

const browser = await openBrowser({ scheme: 'light' });
const page = browser.page;
const problems = [];
await page.send('Runtime.enable');
await page.send('Log.enable');
page.on('Runtime.exceptionThrown', (p) => problems.push(`exception: ${p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text}`));
page.on('Log.entryAdded', (p) => { if (p.entry.level === 'error') problems.push(`${p.entry.source}: ${p.entry.text}`); });
page.on('Runtime.consoleAPICalled', (p) => { if (p.type === 'error') problems.push(`console: ${p.args.map((a) => a.value ?? a.description).join(' ')}`); });

const axe = async (label) => {
  if (!AXE) throw new Error(`axe not found at ${AXE_FILE}`);
  await page.eval(AXE);
  const v = JSON.parse(await page.eval(`axe.run(document, { runOnly: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'] }).then(r => JSON.stringify(r.violations.map(v => ({ id: v.id, impact: v.impact, nodes: v.nodes.length, sample: v.nodes[0]?.target?.join(' ') }))))`));
  assert.deepEqual(v, [], `${label}: ${JSON.stringify(v)}`);
};
const idle = (name) => page.until(`document.querySelector('.desk[data-name="${name}"]')?.dataset.state !== 'working'`, 10000);

await page.viewport(1280);
await page.goto(`${o.url}/?token=${o.token}`);
await page.until("document.querySelectorAll('.desk').length > 0");

await check('the floor: ten employees, each a button named with title and state, in five rooms', async () => {
  const desks = await page.eval("[...document.querySelectorAll('.desk')].map(d => [d.dataset.name, d.tagName, d.getAttribute('aria-label')])");
  assert.equal(desks.length, 10);
  for (const [name, tag, label] of desks) { assert.equal(tag, 'BUTTON'); assert.match(label, new RegExp(`^${name[0].toUpperCase()}${name.slice(1)}, .+, .+: `)); }
  assert.deepEqual(await page.eval("[...document.querySelectorAll('.room')].map(r => r.dataset.room)"), ['product', 'design', 'engineering', 'front', 'review']);
  assert.deepEqual(await page.eval("[...document.querySelectorAll('.room-review .desk')].map(d => d.dataset.name)"), ['quinn', 'sage', 'lex']);
});
await page.shot(join(SHOTS, 'floor-1280-light.png'));

await check('a chat: the reply streams in, the tool line and the cost under it; the session lands in sessions.json', async () => {
  await page.click('.desk[data-name="george"]');
  await page.until("!document.querySelector('#panel').hidden && document.querySelector('#composer-text')");
  await page.type('#composer-text', 'tool please');
  await page.click('.composer button[type="submit"]');
  assert.ok(await page.until("[...document.querySelectorAll('.msg-assistant .msg-body')].some(b => b.textContent.includes('You said: tool please'))"), 'no reply');
  assert.ok(await page.until("document.querySelector('.chat-cost')?.textContent.includes('0.01 USD')"), 'no cost line');
  assert.equal(await page.eval("document.querySelector('.tool .tool-sum').textContent"), 'status.md');
  await idle('george');
  assert.equal(office.sessions('george').length, 1);
  assert.ok(await page.until("document.querySelector('#session-select')?.selectedOptions[0]?.textContent.startsWith('tool please')"), 'the chat is not selected');
});
await page.shot(join(SHOTS, 'chat-1280-light.png'));
await check('axe: the chat tab', () => axe('chat'));

await check('a second turn continues the same chat (--resume)', async () => {
  await page.type('#composer-text', 'and again');
  await page.key('Enter', 'Enter', 13);
  assert.ok(await page.until("[...document.querySelectorAll('.msg-assistant .msg-body')].some(b => b.textContent.includes('You said: and again'))"));
  await idle('george');
  assert.equal(office.sessions('george')[0].turns, 2);
});

await check('a refusal: the tool line is red with the guard\'s sentence, the desk flashes and says so', async () => {
  await page.click('.panel-close');
  await page.click('.desk[data-name="ivy"]');
  await page.until("document.querySelector('#composer-text')");
  await page.type('#composer-text', 'refuse this');
  await page.click('.composer button[type="submit"]');
  assert.ok(await page.until("document.querySelector('.tool-refused .tool-result')?.textContent.startsWith('PreToolUse:Write hook error')"));
  assert.ok(await page.until("document.querySelector('.desk[data-name=\"ivy\"]').dataset.state === 'refused'"));
  assert.match(await page.eval("document.querySelector('.desk[data-name=\"ivy\"] .desk-status').textContent"), /guard refused/);
});

await check('working: the hands type while a turn runs; Stop ends it and the desk says Stopped', async () => {
  await page.click('.panel-close');
  await page.click('.desk[data-name="finn"]');
  await page.until("document.querySelector('#composer-text')");
  await page.type('#composer-text', 'slow build');
  await page.click('.composer button[type="submit"]');
  assert.ok(await page.until("document.querySelector('.desk[data-name=\"finn\"]').dataset.state === 'working'"));
  // "Working…" first, the tool's name once its event arrives.
  assert.ok(await page.until("document.querySelector('.desk[data-name=\"finn\"] .desk-status').textContent === 'Working: Bash pnpm test'"), 'the tool is not on the desk');
  assert.ok(await page.eval("document.querySelector('.desk[data-name=\"finn\"] .hand-l').getAnimations().length > 0"), 'the hands do not move');
  await page.shot(join(SHOTS, 'working-1280-light.png'));
  assert.ok(await page.until("[...document.querySelectorAll('.composer .btn-danger')].length === 1"));
  await page.click('.composer .btn-danger');
  assert.ok(await page.until("document.querySelector('.desk[data-name=\"finn\"]').dataset.state === 'stopped'"));
  assert.ok(await page.until("[...document.querySelectorAll('.chat-cost-error')].some(p => p.textContent.startsWith('Stopped'))"));
});

await check('the board: a task added in the page is on the board FILE; started, then done with a note from the dialog', async () => {
  await page.click('.panel-close');
  await page.click('.desk[data-name="rhea"]');
  await page.until("document.querySelector('#tab-board')");
  await page.click('#tab-board');
  await page.type('#task-title', 'Walk task');
  await page.type('#task-why', 'Phase 4 of plan/office-app.md');
  await page.click('.add-task button[type="submit"]');
  assert.ok(await page.until("[...document.querySelectorAll('.col-inbox .card-title')].some(c => c.textContent === 'Walk task')"));
  const id = await page.eval("[...document.querySelectorAll('.col-inbox .card')].find(c => c.querySelector('.card-title').textContent === 'Walk task').dataset.task");
  await page.eval(`document.querySelector('.card[data-task="${id}"] details').open = true`);
  await page.eval(`[...document.querySelectorAll('.card[data-task="${id}"] button')].find(b => b.textContent.startsWith('Start')).click()`);
  assert.ok(await page.until(`!!document.querySelector('.col-doing .card[data-task="${id}"]')`));
  await page.eval(`document.querySelector('.card[data-task="${id}"] details').open = true`);
  await page.eval(`[...document.querySelectorAll('.card[data-task="${id}"] button')].find(b => b.textContent.startsWith('Done')).click()`);
  assert.ok(await page.until("document.querySelector('#ask').open"));
  await page.shot(join(SHOTS, 'note-dialog-1280-light.png'));
  await axe('the note dialog');
  await page.type('#ask-input', 'closed by the walk');
  await page.click('#ask-ok');
  assert.ok(await page.until(`!!document.querySelector('.col-done .card[data-task="${id}"]')`));
  const board = office.parseBoard(readFileSync(join(tmp, 'office', 'employees', 'rhea', 'board.md'), 'utf8')).board;
  assert.equal(board.done.find((t) => t.id === id)?.note, 'closed by the walk');
});
await page.shot(join(SHOTS, 'board-1280-light.png'));
await check('axe: the board tab', () => axe('board'));

await check('a handoff from a terminal: the plane flies, the envelope counts, Mark all read clears it', async () => {
  await page.click('#tab-inbox');
  const before = await page.eval("document.querySelector('.desk[data-name=\"rhea\"]').getAttribute('aria-label')");
  await page.eval('window.__planes = 0; new MutationObserver(m => m.forEach(r => r.addedNodes.forEach(n => { if (n.classList?.contains("plane")) window.__planes++; }))).observe(document.body, { childList: true })');
  office.taskAdd({ to: 'rhea', from: 'ivy', title: 'A handoff', why: 'the plane' });
  office.msg({ to: 'rhea', from: 'ivy', text: 'T-999 is not real; this is the walk; a semicolon too' });
  assert.ok(await page.until('window.__planes >= 1'), 'no plane');
  assert.ok(await page.until("/✉ \\d/.test(document.querySelector('.desk[data-name=\"rhea\"] .badges').textContent)"));
  assert.notEqual(await page.eval("document.querySelector('.desk[data-name=\"rhea\"]').getAttribute('aria-label')"), before);
  assert.ok(await page.until("document.querySelectorAll('.message.unread').length > 0"));
  await page.shot(join(SHOTS, 'inbox-1280-light.png'));
  await axe('inbox');
  await page.eval("[...document.querySelectorAll('.inbox-bar button')][0].click()");
  assert.ok(await page.until("document.querySelectorAll('.message.unread').length === 0"));
  assert.equal(office.inbox('rhea').filter((m) => !m.read).length, 0);
});

await check('keyboard: Escape closes the panel and focus returns to the desk; tabs move with the arrows', async () => {
  await page.click('#tab-chat');
  await page.key('ArrowRight', 'ArrowRight', 39);
  assert.equal(await page.eval("document.activeElement.id"), 'tab-board');
  await page.key('Escape', 'Escape', 27);
  assert.ok(await page.until("document.querySelector('#panel').hidden"));
  assert.equal(await page.eval("document.activeElement.dataset.name"), 'rhea');
});
await check('axe: the floor, light', () => axe('floor light'));

await check('the pipeline strip: each idea on its rung, from the pipeline file', async () => {
  const rungs = await page.eval("[...document.querySelectorAll('.rung h3')].map(h => h.textContent)");
  assert.equal(rungs.length, 7);
  const ideas = office.pipeline();
  for (const i of ideas) assert.ok(await page.eval(`[...document.querySelectorAll('.rung')].some(r => r.querySelector('h3').textContent.startsWith(${JSON.stringify(i.status)}) && r.textContent.includes(${JSON.stringify(i.slug)}))`), i.slug);
});

await check('reduced motion stops every loop and keeps the stills', async () => {
  await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await new Promise((r) => setTimeout(r, 300));
  const running = await page.eval("JSON.stringify(document.getAnimations().filter(a => a.playState === 'running').map(a => (a.animationName ?? 'waapi') + ' on ' + (a.effect?.target?.getAttribute?.('class') ?? a.effect?.target?.tagName)))");
  assert.equal(running, '[]');
  assert.equal(await page.eval("document.querySelectorAll('.desk-svg').length"), 10);
  await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
});

await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
await new Promise((r) => setTimeout(r, 300));
await page.shot(join(SHOTS, 'floor-1280-dark.png'));
await check('axe: the floor, dark', () => axe('floor dark'));

await check('a phone (375): rooms stack one per row, no sideways scroll, the panel is a full-width sheet', async () => {
  await page.viewport(375);
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(await page.eval('document.documentElement.scrollWidth <= 375'), true, 'sideways scroll');
  const lefts = await page.eval("[...document.querySelectorAll('.room')].map(r => Math.round(r.getBoundingClientRect().left))");
  assert.equal(new Set(lefts).size, 1, `rooms not stacked: ${lefts}`);
  await page.shot(join(SHOTS, 'floor-375-dark.png'));
  await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
  await page.shot(join(SHOTS, 'floor-375-light.png'));
  await page.click('.desk[data-name="george"]');
  await page.until("!document.querySelector('#panel').hidden");
  assert.equal(await page.eval("Math.round(document.querySelector('#panel').getBoundingClientRect().width)"), 375);
  await page.shot(join(SHOTS, 'chat-375-light.png'));
  await axe('the phone sheet');
});

await check('no CSP violation, no script error, the whole walk', async () => {
  assert.deepEqual(problems.filter((p) => !/favicon/.test(p)), []);
});

browser.close();
await o.close();
try { rmSync(tmp, { recursive: true, force: true }); } catch {}
const passed = results.filter(([ok]) => ok).length;
console.log(`\n${passed}/${results.length} checks passed; shots in plan/office-app/walk/`);
process.exit(passed === results.length ? 0 : 1);
