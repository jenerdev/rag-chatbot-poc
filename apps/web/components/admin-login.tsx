'use client';

// The admin login form and the failure-message helper, shared by both admin
// screens: the knowledge base (admin-screen) and bookings (bookings-screen).
// Extracted from admin-screen.tsx in bookings Phase 4, unchanged, so a second
// copy could not drift from the first.
//
// One session serves both screens. The cookie is scoped to /api/t/<slug>, and
// both screens' routes live under that path.

import { useCallback, useState } from 'react';

/** The server's own error message if there is one, else the status line, else "is the server running?". */
export async function describeFailure(error: Error, response: Response | null): Promise<string> {
  if (response) {
    try {
      const body = await response.json();
      if (body.error) return body.error;
    } catch {
      // Not JSON — fall through to the status line.
    }
    return `Request failed with HTTP ${response.status}`;
  }
  return `Cannot reach the server. Is \`pnpm dev\` running? (${error.message})`;
}

/**
 * Staff login: an email and password for a member of this tenant (auth-rls
 * Phase 5).
 *
 * The password goes up once, in a POST body, and is cleared from state
 * straight after. The cookie that comes back is httpOnly: this code cannot
 * read it, and does not need to. "Forgot password?" swaps the form for a
 * one-field request for a reset email.
 */
export function LoginForm({ api, slug, onLoggedIn }: { api: string; slug: string; onLoggedIn: () => void }) {
  const [mode, setMode] = useState<'login' | 'forgot'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const post = useCallback(
    async (path: string, body: object): Promise<Response> => {
      const response = await fetch(`${api}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!response.ok) throw Object.assign(new Error('failed'), { response });
      return response;
    },
    [api],
  );

  const submit = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();
      setBusy(true);
      setError(null);
      setInfo(null);
      try {
        if (mode === 'login') {
          await post('/admin/session', { email, password });
          setPassword('');
          onLoggedIn();
        } else {
          const response = await post('/admin/password-reset', { email });
          setInfo((await response.json()).message);
        }
      } catch (caught) {
        setError(await describeFailure(caught as Error, (caught as { response?: Response }).response ?? null));
      } finally {
        setBusy(false);
      }
    },
    [mode, email, password, post, onLoggedIn],
  );

  const switchTo = (next: 'login' | 'forgot') => {
    setMode(next);
    setError(null);
    setInfo(null);
    setPassword('');
  };

  return (
    <section className="card">
      <h2>{mode === 'login' ? 'Staff login' : 'Reset your password'}</h2>
      <p className="small muted">
        {mode === 'login' ? (
          <>
            Log in with a staff account that is a member of <strong>{slug}</strong>. Members are added with{' '}
            <code>pnpm --filter @rag/db member:add</code>.
          </>
        ) : (
          <>We will email a link to set a new password. It expires in an hour.</>
        )}
      </p>
      <form onSubmit={submit}>
        <div className="field">
          <label htmlFor="admin-email">Email</label>
          <input
            type="email"
            id="admin-email"
            autoComplete="username"
            autoFocus
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </div>
        {mode === 'login' && (
          <div className="field">
            <label htmlFor="admin-password">Password</label>
            <input
              type="password"
              id="admin-password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </div>
        )}
        {error && <div className="notice error">{error}</div>}
        {info && <div className="notice ok">{info}</div>}
        <div className="form-footer">
          <button type="button" className="link" onClick={() => switchTo(mode === 'login' ? 'forgot' : 'login')}>
            {mode === 'login' ? 'Forgot password?' : '← Back to login'}
          </button>
          <button
            type="submit"
            className="primary"
            disabled={busy || email === '' || (mode === 'login' && password === '')}
          >
            {busy ? 'Checking…' : mode === 'login' ? 'Log in' : 'Send reset link'}
          </button>
        </div>
      </form>
    </section>
  );
}
