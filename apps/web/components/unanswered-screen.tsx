'use client';

// S-4 · Unanswered questions. What visitors asked that the documents could not
// answer, newest first: the list of what to add to the knowledge base.
//
// Rendered by app/t/[tenant]/admin/unanswered/page.tsx. Its one route is
// admin-only, so it starts the way the other staff screens do: is there a
// session for THIS tenant? Read-only: nothing here changes a row.

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import type { UnansweredQuestion } from '@rag/pipeline';
import { BrandHeader } from '@/components/brand-header';
import { LoginForm, describeFailure } from '@/components/admin-login';

export interface UnansweredScreenProps {
  slug: string;
  businessName: string;
  logoUrl: string | null;
  bannerUrl: string | null;
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

export function UnansweredScreen({ slug, businessName, logoUrl, bannerUrl }: UnansweredScreenProps) {
  const api = `/api/t/${slug}`;
  const [auth, setAuth] = useState<Auth>('checking');
  const [questions, setQuestions] = useState<UnansweredQuestion[] | null>(null);
  const [loadMessage, setLoadMessage] = useState('Loading…');

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
      } catch {
        setAuth('out');
      }
    })();
  }, [api]);

  const load = useCallback(async () => {
    let response: Response | null = null;
    try {
      response = await fetch(`${api}/unanswered`);
      if (response.status === 401) return unauthorized();
      if (!response.ok) throw new Error('failed');
      setQuestions(await response.json());
    } catch (error) {
      setQuestions(null);
      setLoadMessage(await describeFailure(error as Error, response));
    }
  }, [api, unauthorized]);

  useEffect(() => {
    if (auth === 'in') void load();
  }, [auth, load]);

  const logout = useCallback(async () => {
    await fetch(`${api}/admin/session`, { method: 'DELETE' }).catch(() => undefined);
    unauthorized();
  }, [api, unauthorized]);

  const header = (
    <BrandHeader businessName={businessName} logoUrl={logoUrl} bannerUrl={bannerUrl} subtitle="Unanswered questions">
      {auth === 'in' && (
        <button type="button" className="link" onClick={logout}>
          Log out
        </button>
      )}
      <Link className="button" href={`/t/${slug}/admin`}>
        Knowledge base
      </Link>
      <Link className="button" href={`/t/${slug}`}>
        ← Chat
      </Link>
    </BrandHeader>
  );

  if (auth !== 'in') {
    return (
      <>
        {header}
        <main>
          {auth === 'checking' ? (
            <div className="small muted">Checking your session…</div>
          ) : (
            <LoginForm api={api} slug={slug} onLoggedIn={() => setAuth('in')} />
          )}
        </main>
      </>
    );
  }

  return (
    <>
      {header}
      <main>
        <section className="card">
          <div className="range-head">
            <h2>{questions === null ? 'Unanswered questions' : `${questions.length} unanswered`}</h2>
            <button type="button" onClick={() => void load()}>
              Refresh
            </button>
          </div>
          <p className="small muted">
            Questions the assistant answered with “I don&apos;t know based on the documents I have.” Each is a gap
            to fill in the knowledge base. Partly answered questions are not listed.
          </p>

          {questions === null ? (
            <div className="small">{loadMessage}</div>
          ) : questions.length === 0 ? (
            <div className="empty-state">
              <strong>Nothing unanswered</strong>
              Every question so far was answered from the documents.
            </div>
          ) : (
            questions.map((q) => (
              // The question is a React child, so a visitor's text is escaped (CLAUDE.md § Conventions).
              <div key={q.id} className="unanswered">
                <span className="unanswered-question">{q.question}</span>
                <span className="unanswered-when">{askedLabel(q.askedAt)}</span>
              </div>
            ))
          )}
        </section>
      </main>
    </>
  );
}
