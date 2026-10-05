// ui-refresh-phase1-walk.mjs — the login, forgot and reset screens in a real
// browser, against a running dev server (plan/ui-refresh.md Phase 1). Checks
// the behaviour the phase promised and takes a screenshot of every state, at
// 375 and 1280 px, light and dark, into plan/ui-refresh/phase1/after/.
//
// No account is needed and none is made: the wrong-password case uses an
// address that does not exist (the route answers it exactly like a wrong
// password), and the reset-email request is answered INSIDE the browser
// (Fetch.fulfillRequest), so no email is sent (R-21, the email cap). The
// reset form is driven with a fake token and never submitted.
//
//   node plan/ui-refresh-phase1-walk.mjs [base-url]

import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openBrowser } from './ui-refresh-cdp.mjs';

const BASE = process.argv[2] ?? 'http://localhost:3000';
const OUT = join(dirname(fileURLToPath(import.meta.url)), 'ui-refresh', 'phase1', 'after');
let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failures++;
};

for (const scheme of ['light', 'dark']) {
  const browser = await openBrowser({ scheme });
  const { page } = browser;
  const dir = scheme === 'dark' ? `${OUT}-dark` : OUT;
  const loud = scheme === 'light'; // the checks once; dark is screenshots only
  try {
    // The reset-email request never leaves the browser.
    await page.send('Fetch.enable', { patterns: [{ urlPattern: '*/admin/password-reset' }] });
    page.on('Fetch.requestPaused', (p) =>
      void page.send('Fetch.fulfillRequest', {
        requestId: p.requestId,
        responseCode: 200,
        responseHeaders: [{ name: 'Content-Type', value: 'application/json' }],
        body: Buffer.from(JSON.stringify({ message: 'If that address has an account here, a reset link is on its way.' })).toString('base64'),
      }),
    );

    for (const width of [375, 1280]) {
      await page.viewport(width);
      const shot = (name) => page.shot(join(dir, `${name}-${width}.png`));
      const first = loud && width === 1280;

      // 1. The login card, logged out.
      await page.goto(`${BASE}/t/villa/admin`);
      await page.until("!!document.querySelector('.auth-card input[type=email]')", 30000);
      await shot('login');
      if (first) {
        check(await page.eval("document.querySelector('.auth-card h2')?.textContent === 'Staff login'"), '1. the login card is the page', await page.eval("document.querySelector('.auth-card h2')?.textContent ?? 'no card'"));
        check(await page.eval("document.activeElement?.type === 'email'"), '1b. the email field has focus on arrival');
        check(await page.eval("!document.body.innerText.includes('pnpm')"), '1c. no command line in the staff intro');
      }

      // 2. Typed in; the keyboard order; show/hide.
      await page.type('.auth-card input[type=email]', 'nobody-ui-walk@example.com');
      await page.type('.auth-card input[type=password]', 'not-the-password');
      if (first) {
        await page.eval("document.querySelector('.auth-card input[type=email]').focus()");
        const order = [await page.tab(), await page.tab(), await page.tab(), await page.tab()];
        check(
          /<input>/.test(order[0]) && /Show password/.test(order[1]) && /Log in/.test(order[2]) && /Forgot password/.test(order[3]),
          '2. Tab: email → password → Show password → Log in → Forgot password?',
          order.join(' → '),
        );
        await page.click('.input-action');
        check(
          await page.eval("document.querySelector('.auth-card .input-with-action input').type === 'text' && document.querySelector('.input-action').getAttribute('aria-pressed') === 'true'"),
          '2b. Show password shows it and says so (aria-pressed)',
        );
        await page.click('.input-action');
        check(await page.eval("document.querySelector('.auth-card .input-with-action input').type === 'password'"), '2c. pressed again, hidden again');
      }
      await shot('login-filled');

      // 3. A refused login: the error announced and focused, the password cleared, the email kept.
      await page.click('.auth-card button[type=submit]');
      await page.until("!!document.querySelector('.auth-card .notice.error')");
      await shot('login-error');
      if (first) {
        check(await page.eval("document.querySelector('.notice.error')?.getAttribute('role') === 'alert'"), '3. the error is role=alert', await page.eval("document.querySelector('.notice.error')?.textContent ?? 'no error'"));
        check(await page.eval("document.activeElement?.classList.contains('notice')"), '3b. focus moved to the error');
        check(
          await page.eval("document.querySelector('.auth-card input[type=password]').value === '' && document.querySelector('.auth-card input[type=email]').value === 'nobody-ui-walk@example.com'"),
          '3c. the password cleared, the email kept',
        );
      }

      // 4. Forgot password, then the "check your email" state.
      await page.click('.auth-switch button');
      await page.until("document.querySelector('.auth-card h2')?.textContent === 'Reset your password'");
      await shot('forgot');
      if (first) check(await page.eval("!document.querySelector('.auth-card input[type=password]')"), '4. the forgot form has no password field');
      await page.click('.auth-card button[type=submit]');
      await page.until("document.querySelector('.auth-card h2')?.textContent === 'Check your email'");
      await shot('forgot-sent');
      if (first) {
        check(await page.eval("!!document.querySelector('.auth-done') && document.body.innerText.includes('a reset link is on its way')"), '4b. sent: a check, one sentence, no form');
        await page.click('.auth-card .auth-wide');
        check(await page.until("document.querySelector('.auth-card h2')?.textContent === 'Staff login'"), '4c. Back to login returns to the login card');
      }

      // 5. The reset page with no link: the problem and the way back.
      await page.goto(`${BASE}/t/villa/admin/reset`);
      await shot('reset-nolink');
      if (first) check(await page.eval("!!document.querySelector('.auth-card .notice.error') && document.querySelector('.auth-card a.button')?.textContent === 'Back to login'"), '5. no link: the problem and "Back to login"');

      // 6. The reset form (a fake token, never submitted): the rules as you type.
      // Via about:blank: from /reset itself, a #fragment is an in-page jump, not a load.
      await page.send('Page.navigate', { url: 'about:blank' });
      await page.goto(`${BASE}/t/villa/admin/reset#access_token=fake-token-ui-walk&type=recovery`);
      await page.until("!!document.querySelector('#new-password')", 30000);
      if (first) check(await page.eval("location.hash === ''"), '6. the token is wiped from the address bar');
      await page.type('#new-password', 'short');
      await shot('reset-short');
      if (first) {
        check(await page.eval("!document.querySelector('#new-password-rule').classList.contains('met') && document.querySelector('.auth-card button[type=submit]').disabled"), '6b. 5 characters: the rule unmet, the button off');
      }
      await page.type('#new-password', '-enough');
      await page.type('#new-password-again', 'short-enough');
      await shot('reset-ready');
      if (first) {
        check(
          await page.eval("document.querySelector('#new-password-rule').classList.contains('met') && document.querySelector('#new-password-match').classList.contains('met') && !document.querySelector('.auth-card button[type=submit]').disabled"),
          '6c. 12 characters, typed twice: both rules met, the button on',
        );
        check(await page.eval("document.querySelector('#new-password').getAttribute('aria-describedby') === 'new-password-rule'"), '6d. the rule is the field\'s description');
      }

      // 7. The platform's login: the same card, its own title.
      await page.goto(`${BASE}/platform`);
      await page.until("!!document.querySelector('.auth-card')", 30000);
      await shot('platform-login');
      if (first) check(await page.eval("document.querySelector('.auth-card h2')?.textContent === 'Platform login'"), '7. the platform login is the same card');
    }
  } finally {
    browser.close();
  }
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
