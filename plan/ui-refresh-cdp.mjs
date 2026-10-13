// ui-refresh-cdp.mjs — headless Chrome over the DevTools protocol, for the UI
// refresh's screenshots and walks (plan/ui-refresh.md Rule 4). No
// dependency: Node's own WebSocket and fetch.

import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const CHROME = process.env.CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';

/** Start Chrome and open one page. `scheme` is the emulated prefers-color-scheme. */
// A fresh port per run, so a Chrome left over from a crashed run never answers
// for this one; and on Windows the WHOLE tree is killed on close, since
// killing the launcher leaves its children holding the port.
const killTree = (child) => {
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  else child.kill();
};

// `args`: extra Chrome flags for one walk (the sound walk's autoplay policy).
export async function openBrowser({ port = 9400 + Math.floor(Math.random() * 500), scheme = 'light', args = [] } = {}) {
  const profile = mkdtempSync(join(tmpdir(), 'ui-shoot-'));
  const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--hide-scrollbars', ...args, 'about:blank'], { stdio: 'ignore' });

  let target;
  for (let i = 0; i < 150 && !target; i++) {
    try {
      target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  if (!target) {
    killTree(chrome);
    throw new Error('Chrome did not start');
  }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));

  let id = 0;
  const pending = new Map();
  const waiters = [];
  const listeners = [];
  ws.addEventListener('message', (e) => {
    const msg = JSON.parse(e.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    } else if (msg.method) {
      for (const w of [...waiters]) if (w.method === msg.method) { waiters.splice(waiters.indexOf(w), 1); w.resolve(msg); }
      for (const l of listeners) if (l.method === msg.method) l.handler(msg.params);
    }
  });
  const send = (method, params = {}) => new Promise((resolve) => { const n = ++id; pending.set(n, resolve); ws.send(JSON.stringify({ id: n, method, params })); });
  // A page whose load event never comes (a stuck dev compile) is let go
  // after 20 s, and named, rather than hanging the run.
  const once = (method, what) =>
    new Promise((resolve) => {
      const timer = setTimeout(() => { console.log(`slow: ${what}`); resolve(); }, 20000);
      waiters.push({ method, resolve: (msg) => { clearTimeout(timer); resolve(msg); } });
    });

  await send('Page.enable');
  await send('Network.enable');
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] });

  const page = {
    send,
    /** Every event of `method`, for as long as the page is open. */
    on(method, handler) {
      listeners.push({ method, handler });
    },
    async viewport(width) {
      await send('Emulation.setDeviceMetricsOverride', { width, height: width < 600 ? 812 : 900, deviceScaleFactor: 1, mobile: width < 600 });
    },
    async eval(expression) {
      const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (r.result?.exceptionDetails) throw new Error(`eval: ${r.result.exceptionDetails.exception?.description ?? expression}`);
      return r.result?.result?.value;
    },
    /** Navigate, then wait until no "Loading"/"Checking"/"Reading" text is left (at most 30 s). */
    async goto(url) {
      const loaded = once('Page.loadEventFired', url);
      await send('Page.navigate', { url });
      await loaded;
      for (let t = 0; t < 60; t++) {
        await new Promise((r) => setTimeout(r, 500));
        const busy = await page.eval("/Loading|Checking|Reading the link/.test(document.body?.innerText ?? 'Loading')");
        if (t >= 2 && busy === false) break;
      }
    },
    /** Wait until `expression` is truthy (at most `ms`). */
    async until(expression, ms = 10000) {
      for (let t = 0; t < ms / 200; t++) {
        if (await page.eval(expression)) return true;
        await new Promise((r) => setTimeout(r, 200));
      }
      return false;
    },
    /** Focus the element, then type as a keyboard would (React sees real input events). */
    async type(selector, text) {
      await page.eval(`document.querySelector(${JSON.stringify(selector)}).focus()`);
      await send('Input.insertText', { text });
    },
    async click(selector) {
      await page.eval(`document.querySelector(${JSON.stringify(selector)}).click()`);
    },
    async key(key, code = key, keyCode = 0, modifiers = 0) {
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: keyCode, modifiers });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: keyCode, modifiers });
    },
    /** Tab once; returns a description of what has focus now. */
    async tab(shift = false) {
      await page.key('Tab', 'Tab', 9, shift ? 8 : 0);
      return page.eval("(() => { const a = document.activeElement; return a ? (a.getAttribute('aria-label') || a.textContent.trim() || a.id || a.tagName).slice(0, 40) + ' <' + a.tagName.toLowerCase() + '>' : 'none'; })()");
    },
    async shot(file) {
      const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, Buffer.from(r.result.data, 'base64'));
    },
  };

  return {
    page,
    close() {
      ws.close();
      killTree(chrome);
    },
  };
}
