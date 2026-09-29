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

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { describeFailure } from './admin-login';

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
      <section className="card">
        <h2>Set a password</h2>
        <div className="notice error">{link.problem}</div>
        <Link href={loginHref}>Back to the login form</Link>
      </section>
    );
  }

  if (done) {
    return (
      <section className="card">
        <h2>Set a password</h2>
        <div className="notice ok">{done}</div>
        <Link className="button" href={loginHref}>
          Log in
        </Link>
      </section>
    );
  }

  return (
    <section className="card">
      <h2>Set a password</h2>
      <form onSubmit={submit}>
        <div className="field">
          <label htmlFor="new-password">New password</label>
          <input
            type="password"
            id="new-password"
            autoComplete="new-password"
            autoFocus
            required
            minLength={8}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="new-password-again">The same again</label>
          <input
            type="password"
            id="new-password-again"
            autoComplete="new-password"
            required
            value={again}
            onChange={(event) => setAgain(event.target.value)}
          />
        </div>
        {error && <div className="notice error">{error}</div>}
        <div className="form-footer">
          <span className="small muted">At least 8 characters.</span>
          <button type="submit" className="primary" disabled={busy || password === '' || again === ''}>
            {busy ? 'Saving…' : 'Set password'}
          </button>
        </div>
      </form>
    </section>
  );
}
