'use client';

// The reset page's form (auth-rls Phase 5).
//
// Supabase's recovery and invite links arrive as
//
//     /t/<slug>/admin/reset#access_token=…&type=recovery&…
//
// The #fragment is never sent to any server, which is why this is a Client
// Component. It is the ONLY component that ever holds a Supabase Auth token
// (plan/auth-rls.md § 3 Phase 5), and it holds it for one call: the token is
// read once, wiped from the address bar so it does not sit in history or get
// shared by copy-paste, kept in memory, and sent with the new password to our
// own route. No supabase-js in the browser. The route does the one HTTP call.
//
// The look (plan/ui-refresh.md Phase 1): the login's card, and the two rules
// a password must pass shown as it is typed, not after the submit.

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { FormError, PasswordInput, describeFailure } from './admin-login';
import { Icon } from './icons';

/** The server's rule too (the password route refuses fewer). */
const MIN_PASSWORD = 8;

type LinkState = { token: string } | { problem: string } | null;

function readLink(): LinkState {
  const fragment = new URLSearchParams(window.location.hash.slice(1));
  // Supabase reports an expired or used link in the fragment itself.
  const problem = fragment.get('error_description');
  if (problem) return { problem: problem.replace(/\+/g, ' ') };
  const token = fragment.get('access_token');
  const type = fragment.get('type');
  if (!token || (type !== 'recovery' && type !== 'invite')) {
    return { problem: 'This page needs the link from a password-reset or invite email. Open that link again, or request a new one from the login form.' };
  }
  return { token };
}

export function ResetPassword({ api, loginHref }: { api: string; loginHref: string }) {
  const [link, setLink] = useState<LinkState>(null);
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setLink(readLink());
    // Wipe the token from the address bar and history, keeping the path.
    window.history.replaceState(null, '', window.location.pathname);
  }, []);

  const submit = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();
      if (!link || !('token' in link)) return;
      if (password !== again) return setError('The two passwords are not the same.');
      setBusy(true);
      setError(null);
      let response: Response | null = null;
      try {
        response = await fetch(api, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ accessToken: link.token, password }),
        });
        if (!response.ok) throw new Error('failed');
        setDone((await response.json()).message);
        setPassword('');
        setAgain('');
      } catch (caught) {
        setError(await describeFailure(caught as Error, response));
      } finally {
        setBusy(false);
      }
    },
    [link, password, again, api],
  );

  if (link === null) return <div className="small muted">Reading the link…</div>;

  if ('problem' in link) {
    return (
      <section className="card auth-card">
        <h2>Set a password</h2>
        <div className="notice error">{link.problem}</div>
        <Link className="button auth-wide" href={loginHref}>
          Back to login
        </Link>
      </section>
    );
  }

  if (done) {
    return (
      <section className="card auth-card">
        <div className="auth-done">
          <Icon name="check" size={22} />
        </div>
        <h2>Password set</h2>
        <p className="auth-intro">{done}</p>
        <Link className="button primary auth-wide" href={loginHref}>
          Log in
        </Link>
      </section>
    );
  }

  const longEnough = password.length >= MIN_PASSWORD;
  const matches = again !== '' && again === password;
  return (
    <section className="card auth-card">
      <h2>Set a password</h2>
      <p className="auth-intro">Choose the password you will log in with.</p>
      <form onSubmit={submit}>
        <div className="field">
          <label htmlFor="new-password">New password</label>
          <PasswordInput
            id="new-password"
            autoComplete="new-password"
            autoFocus
            minLength={MIN_PASSWORD}
            value={password}
            onChange={setPassword}
            describedBy="new-password-rule"
          />
          <p id="new-password-rule" className={longEnough ? 'hint met' : 'hint'} aria-live="polite">
            <Icon name={longEnough ? 'check' : 'info'} size={14} /> At least {MIN_PASSWORD} characters
          </p>
        </div>
        <div className="field">
          <label htmlFor="new-password-again">The same again</label>
          <PasswordInput
            id="new-password-again"
            autoComplete="new-password"
            value={again}
            onChange={setAgain}
            invalid={again !== '' && !password.startsWith(again)}
            describedBy="new-password-match"
          />
          <p id="new-password-match" className={matches ? 'hint met' : 'hint'} aria-live="polite">
            <Icon name={matches ? 'check' : 'info'} size={14} /> {matches ? 'The passwords match' : 'Type it again to confirm'}
          </p>
        </div>
        <FormError message={error} />
        <button
          type="submit"
          className="primary auth-wide"
          aria-busy={busy || undefined}
          disabled={busy || !longEnough || !matches}
        >
          {busy ? 'Saving…' : 'Set password'}
        </button>
      </form>
    </section>
  );
}
