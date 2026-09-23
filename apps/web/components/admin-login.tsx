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
 * Exchange the tenant's admin key for a session cookie.
 *
 * The key goes up once, in a POST body, and is never kept in state after that.
 * The cookie that comes back is httpOnly: this code cannot read it, and does
 * not need to.
 */
export function LoginForm({ api, slug, onLoggedIn }: { api: string; slug: string; onLoggedIn: () => void }) {
  const [key, setKey] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();
      setBusy(true);
      setError(null);
      let response: Response | null = null;
      try {
        response = await fetch(`${api}/admin/session`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ key }),
        });
        if (!response.ok) throw new Error('failed');
        setKey('');
        onLoggedIn();
      } catch (caught) {
        setError(await describeFailure(caught as Error, response));
      } finally {
        setBusy(false);
      }
    },
    [api, key, onLoggedIn],
  );

  return (
    <section className="card">
      <h2>Admin login</h2>
      <p className="small muted">
        The admin pages need the admin key for <strong>{slug}</strong>. It was printed
        once, when the key was issued with <code>pnpm --filter @rag/db tenant:key</code>.
      </p>
      <form onSubmit={submit}>
        <div className="field">
          <label htmlFor="admin-key">Admin key</label>
          <input
            type="password"
            id="admin-key"
            autoComplete="off"
            autoFocus
            required
            value={key}
            onChange={(event) => setKey(event.target.value)}
          />
        </div>
        {error && <div className="notice error">{error}</div>}
        <div className="form-footer">
          <span />
          <button type="submit" className="primary" disabled={busy || key === ''}>
            {busy ? 'Checking…' : 'Log in'}
          </button>
        </div>
      </form>
    </section>
  );
}
