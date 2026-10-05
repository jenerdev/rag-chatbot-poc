'use client';

// The admin login form and the failure-message helper, shared by both admin
// screens: the knowledge base (admin-screen) and bookings (bookings-screen).
// Extracted from admin-screen.tsx in bookings Phase 4, unchanged, so a second
// copy could not drift from the first.
//
// One session serves both screens. The cookie is scoped to /api/t/<slug>, and
// both screens' routes live under that path.
//
// The look (plan/ui-refresh.md Phase 1): one narrow, centred card; a full-width
// button; the error under the form, announced and focused; "Forgot
// password?" under the button. PasswordInput is shared with the reset form.

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Icon } from './icons';

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
 * A password field with a show/hide toggle. The toggle is a real button with
 * aria-pressed, so a keyboard reaches it right after the field and a screen
 * reader says whether the password is shown. Showing it changes only the
 * input's type; the value never leaves the component's parent state.
 */
export function PasswordInput({
  id,
  value,
  onChange,
  autoComplete,
  autoFocus,
  minLength,
  invalid,
  describedBy,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  autoComplete: 'current-password' | 'new-password';
  autoFocus?: boolean;
  minLength?: number;
  invalid?: boolean;
  describedBy?: string;
}) {
  const [shown, setShown] = useState(false);
  return (
    <div className="input-with-action">
      <input
        type={shown ? 'text' : 'password'}
        id={id}
        autoComplete={autoComplete}
        autoFocus={autoFocus}
        required
        minLength={minLength}
        spellCheck={false}
        autoCapitalize="off"
        value={value}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        onChange={(event) => onChange(event.target.value)}
      />
      <button
        type="button"
        className="ghost sm input-action"
        aria-pressed={shown}
        aria-label={shown ? 'Hide password' : 'Show password'}
        aria-controls={id}
        onClick={() => setShown(!shown)}
      >
        <Icon name={shown ? 'eye-off' : 'eye'} size={18} />
      </button>
    </div>
  );
}

/** The error under a form: announced when it appears, and focused, so a keyboard user lands on it. */
export function FormError({ message }: { message: string | null }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (message) ref.current?.focus();
  }, [message]);
  if (!message) return null;
  return (
    <div ref={ref} className="notice error" role="alert" tabIndex={-1}>
      {message}
    </div>
  );
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
export function LoginForm({
  api,
  slug,
  onLoggedIn,
  sessionPath = '/admin/session',
  resetPath = '/admin/password-reset',
  title = 'Staff login',
  intro,
}: {
  api: string;
  slug: string;
  onLoggedIn: () => void;
  /** The platform (tenant management Phase 5) logs in at /api/platform/session with the same form. */
  sessionPath?: string;
  resetPath?: string;
  title?: string;
  /** Replaces the staff sentence under the title. */
  intro?: React.ReactNode;
}) {
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
          await post(sessionPath, { email, password });
          setPassword('');
          onLoggedIn();
        } else {
          const response = await post(resetPath, { email });
          setInfo((await response.json()).message);
        }
      } catch (caught) {
        // A refused password is cleared, the email kept: the usual retry.
        if (mode === 'login') setPassword('');
        setError(await describeFailure(caught as Error, (caught as { response?: Response }).response ?? null));
      } finally {
        setBusy(false);
      }
    },
    [mode, email, password, post, onLoggedIn, sessionPath, resetPath],
  );

  const switchTo = (next: 'login' | 'forgot') => {
    setMode(next);
    setError(null);
    setInfo(null);
    setPassword('');
  };

  const emailId = useId();
  const passwordId = useId();

  if (info) {
    // The reset email is on its way: one sentence and the way back, no form.
    return (
      <section className="card auth-card">
        <div className="auth-done">
          <Icon name="check" size={22} />
        </div>
        <h2>Check your email</h2>
        <p className="auth-intro">{info}</p>
        <button type="button" className="auth-wide" onClick={() => switchTo('login')}>
          Back to login
        </button>
      </section>
    );
  }

  return (
    <section className="card auth-card">
      <h2>{mode === 'login' ? title : 'Reset your password'}</h2>
      <p className="auth-intro">
        {mode === 'login'
          ? (intro ?? <>Log in with your staff account for this workspace. No account yet? Ask an owner of this workspace to add you.</>)
          : 'We will email you a link to set a new password. It expires in an hour.'}
      </p>
      <form onSubmit={submit}>
        <div className="field">
          <label htmlFor={emailId}>Email</label>
          <input
            type="email"
            id={emailId}
            autoComplete="username"
            autoFocus
            required
            spellCheck={false}
            autoCapitalize="off"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </div>
        {mode === 'login' && (
          <div className="field">
            <label htmlFor={passwordId}>Password</label>
            <PasswordInput id={passwordId} autoComplete="current-password" value={password} onChange={setPassword} invalid={error !== null} />
          </div>
        )}
        <FormError message={error} />
        <button
          type="submit"
          className="primary auth-wide"
          aria-busy={busy || undefined}
          disabled={busy || email === '' || (mode === 'login' && password === '')}
        >
          {busy ? (mode === 'login' ? 'Logging in…' : 'Sending…') : mode === 'login' ? 'Log in' : 'Send reset link'}
        </button>
        <div className="auth-switch">
          <button type="button" className="link" onClick={() => switchTo(mode === 'login' ? 'forgot' : 'login')}>
            {mode === 'login' ? 'Forgot password?' : 'Back to login'}
          </button>
        </div>
      </form>
    </section>
  );
}
