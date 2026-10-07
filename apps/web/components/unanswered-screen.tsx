'use client';

// S-4 · Unanswered questions. What visitors asked that the documents could not
// answer, newest first: the list of what to add to the knowledge base.
//
// Rendered by app/t/[tenant]/admin/unanswered/page.tsx. Its one route is
// admin-only, so it starts the way the other staff screens do: is there a
// session for THIS tenant?
//
// Two tabs, Open and Resolved (D-045). "Mark resolved" is what staff click once
// the answer is in the knowledge base. It adds a resolution row; the visitor's
// transcript is never touched, and Reopen undoes it.
//
// The look (plan/ui-refresh.md Phase 8): the two tabs are a segmented
// control; each question is a row with when it was asked under it; an empty
// Open tab reads as the good news it is.

import { useCallback, useEffect, useState } from 'react';
import type { UnansweredQuestion } from '@rag/pipeline';
import { LoginForm, describeFailure } from '@/components/admin-login';
import { fetchRole } from '@/components/tenant-nav';
import { StaffFrame } from '@/components/staff-frame';
import { Icon } from '@/components/icons';
import { LOADING, LoadState, failed, type Load } from '@/components/load-state';
import type { NavFeatures } from '@/lib/nav-items';
import { isRole, type Role } from '@/lib/permissions';

export interface UnansweredScreenProps {
  slug: string;
  businessName: string;
  logoUrl: string | null;
  bannerUrl: string | null;
  /** What the tenant has, for the header's links (lib/nav.ts). */
  nav: NavFeatures;
}

type Auth = 'checking' | 'out' | 'in';

/** "27 Sep 2026, 14:05" in this browser's zone: an instant, unlike the bookings screen's calendar dates. */
function askedLabel(askedAt: string): string {
  return new Date(askedAt).toLocaleString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function UnansweredScreen({ slug, businessName, logoUrl, bannerUrl, nav }: UnansweredScreenProps) {
  const api = `/api/t/${slug}`;
  const [auth, setAuth] = useState<Auth>('checking');
  // What this member is, for the header's links only; the routes decide for themselves.
  const [role, setRole] = useState<Role | null>(null);
  const [questions, setQuestions] = useState<UnansweredQuestion[] | null>(null);
  const [loadState, setLoadState] = useState<Load>(LOADING);
  const [tab, setTab] = useState<'open' | 'resolved'>('open');
  const [busyId, setBusyId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const unauthorized = useCallback(() => {
    setAuth('out');
    setQuestions(null);
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const response = await fetch(`${api}/admin/session`);
        const body = await response.json();
        setAuth(body.admin === true ? 'in' : 'out');
        setRole(isRole(body.role) ? body.role : null);
      } catch {
        setAuth('out');
      }
    })();
  }, [api]);

  const load = useCallback(async () => {
    let response: Response | null = null;
    try {
      response = await fetch(`${api}/unanswered${tab === 'resolved' ? '?resolved=1' : ''}`);
      if (response.status === 401) return unauthorized();
      if (!response.ok) throw new Error('failed');
      setQuestions(await response.json());
    } catch (error) {
      setQuestions(null);
      setLoadState(failed(await describeFailure(error as Error, response)));
    }
  }, [api, tab, unauthorized]);

  useEffect(() => {
    if (auth === 'in') void load();
  }, [auth, load]);

  // Resolve (PUT) or reopen (DELETE). On success the row leaves this tab; it
  // is on the other one now.
  const toggleResolved = useCallback(
    async (q: UnansweredQuestion) => {
      setBusyId(q.id);
      setError(null);
      let response: Response | null = null;
      try {
        response = await fetch(`${api}/unanswered/${q.id}/resolution`, { method: tab === 'open' ? 'PUT' : 'DELETE' });
        if (response.status === 401) return unauthorized();
        if (!response.ok) throw new Error('failed');
        setQuestions((current) => current?.filter((x) => x.id !== q.id) ?? null);
      } catch (failure) {
        setError(await describeFailure(failure as Error, response));
      } finally {
        setBusyId(null);
      }
    },
    [api, tab, unauthorized],
  );

  const logout = useCallback(async () => {
    await fetch(`${api}/admin/session`, { method: 'DELETE' }).catch(() => undefined);
    unauthorized();
  }, [api, unauthorized]);

  const frame = { slug, businessName, logoUrl, bannerUrl, features: nav, current: 'unanswered' as const, title: 'Unanswered questions', session: { auth, role, onLogout: logout } };

  if (auth !== 'in') {
    return (
      <>
        <StaffFrame {...frame}>
          {auth === 'checking' ? (
            <div className="small muted">Checking your session…</div>
          ) : (
            <LoginForm api={api} slug={slug} onLoggedIn={() => {
                setAuth('in');
                void fetchRole(api).then(setRole);
              }} />
          )}
        </StaffFrame>
      </>
    );
  }

  return (
    <>
      <StaffFrame {...frame}>
        <section className="card">
          <div className="range-head">
            <div className="segmented" role="group" aria-label="Show">
              <button type="button" aria-pressed={tab === 'open'} onClick={() => setTab('open')}>
                Open
              </button>
              <button type="button" aria-pressed={tab === 'resolved'} onClick={() => setTab('resolved')}>
                Resolved
              </button>
            </div>
            <button type="button" className="ghost sm" onClick={() => void load()}>
              Refresh
            </button>
          </div>
          <p className="small muted">
            {tab === 'open'
              ? 'Questions the assistant could not answer from the documents (the visitor saw your “no answer” message). Add the answer to the knowledge base, check it in chat, then mark the question resolved. Partly answered questions are not listed.'
              : 'Questions marked resolved. Reopen one if the assistant still cannot answer it.'}
          </p>
          {error && (
            <div className="notice error" role="alert">
              {error}
            </div>
          )}

          {questions === null ? (
            <LoadState load={loadState} what="questions" onRetry={() => { setLoadState(LOADING); void load(); }} />
          ) : questions.length === 0 ? (
            <div className="empty-list">
              {tab === 'open' ? (
                <>
                  <span className="auth-done">
                    <Icon name="check" size={22} />
                  </span>
                  <strong>Nothing unanswered</strong>
                  <span>Every open question has been answered or resolved.</span>
                </>
              ) : (
                <>
                  <strong>Nothing resolved yet</strong>
                  <span>Questions you mark resolved appear here.</span>
                </>
              )}
            </div>
          ) : (
            questions.map((q) => (
              // The question is a React child, so a visitor's text is escaped (CLAUDE.md § Conventions).
              <div key={q.id} className="unanswered">
                <div className="unanswered-text">
                  <span className="unanswered-question">{q.question}</span>
                  <span className="unanswered-when">
                    Asked {askedLabel(q.askedAt)}
                    {q.resolvedAt && ` · resolved ${askedLabel(q.resolvedAt)}`}
                  </span>
                </div>
                <button type="button" className="sm" aria-busy={busyId === q.id || undefined} disabled={busyId !== null} onClick={() => void toggleResolved(q)}>
                  {tab === 'open' ? (
                    <>
                      <Icon name="check" size={14} /> Mark resolved
                    </>
                  ) : (
                    'Reopen'
                  )}
                </button>
              </div>
            ))
          )}
        </section>
      </StaffFrame>
    </>
  );
}
