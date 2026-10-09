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
// Checkboxes (2026-10-09): tick several rows, or "Select all shown", and
// resolve (or reopen) them in ONE request to unanswered/resolutions. The
// selection is of the rows on screen, so it is cleared whenever they change:
// a new tab, a reload, a new search.
//
// The look (plan/ui-refresh.md Phase 8): the two tabs are a segmented
// control; each question is a row with when it was asked under it; an empty
// Open tab reads as the good news it is.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { UnansweredQuestion } from '@rag/pipeline';
import { LoginForm, describeFailure } from '@/components/admin-login';
import { fetchRole } from '@/components/tenant-nav';
import { StaffFrame } from '@/components/staff-frame';
import { Icon } from '@/components/icons';
import { EmptyState, LOADING, LoadState, failed, type Load } from '@/components/load-state';
import { ListSearch } from '@/components/list-search';
import { notify } from '@/components/toast';
import { PAGE_SIZE, matches } from '@/lib/search';
import type { NavFeatures } from '@/lib/nav-items';
import { isRole, type Role } from '@/lib/permissions';

export interface UnansweredScreenProps {
  slug: string;
  businessName: string;
  logoUrl: string | null;
  bannerUrl: string | null;
  /** What the tenant has, for the header's links (lib/nav.ts). */
  nav: NavFeatures;
  /** The list route's cap (UNANSWERED_LIMIT), from the server page: at the cap, a search says "of N loaded". */
  limit: number;
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

export function UnansweredScreen({ slug, businessName, logoUrl, bannerUrl, nav, limit }: UnansweredScreenProps) {
  const api = `/api/t/${slug}`;
  const [auth, setAuth] = useState<Auth>('checking');
  // What this member is, for the header's links only; the routes decide for themselves.
  const [role, setRole] = useState<Role | null>(null);
  const [questions, setQuestions] = useState<UnansweredQuestion[] | null>(null);
  const [loadState, setLoadState] = useState<Load>(LOADING);
  const [tab, setTab] = useState<'open' | 'resolved'>('open');
  const [busyId, setBusyId] = useState<number | null>(null);
  // Phase 4: a search over the loaded questions, and the first PAGE_SIZE of them.
  const [query, setQuery] = useState('');
  const [shown, setShown] = useState(PAGE_SIZE);
  useEffect(() => setShown(PAGE_SIZE), [query, tab]);
  const matching = useMemo(() => questions?.filter((q) => matches(q.question, query)) ?? [], [questions, query]);
  // The ticked rows, by id. Only ever ids of rows on screen (see the top).
  const [selected, setSelected] = useState<ReadonlySet<number>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  useEffect(() => setSelected(new Set()), [query, tab, questions]);
  const visible = useMemo(() => matching.slice(0, shown), [matching, shown]);
  const allVisibleSelected = visible.length > 0 && visible.every((q) => selected.has(q.id));
  const someSelected = selected.size > 0 && !allVisibleSelected;
  const selectAll = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (selectAll.current) selectAll.current.indeterminate = someSelected;
  }, [someSelected]);
  const toggleOne = useCallback((id: number, on: boolean) => {
    setSelected((current) => {
      const next = new Set(current);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

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
      let response: Response | null = null;
      try {
        response = await fetch(`${api}/unanswered/${q.id}/resolution`, { method: tab === 'open' ? 'PUT' : 'DELETE' });
        if (response.status === 401) return unauthorized();
        if (!response.ok) throw new Error('failed');
        setQuestions((current) => current?.filter((x) => x.id !== q.id) ?? null);
        // Before, the row just went; now it says where (plan/ui-components.md Phase 4, found).
        notify(tab === 'open' ? 'Marked resolved. It is under Resolved now.' : 'Reopened. It is under Open now.', 'ok');
      } catch (failure) {
        notify(await describeFailure(failure as Error, response), 'error');
      } finally {
        setBusyId(null);
      }
    },
    [api, tab, unauthorized],
  );

  // The ticked rows, resolved (Open) or reopened (Resolved) in one request.
  // The rows the server names leave this tab; the toast says how many, and
  // how many it could not change.
  const bulkToggle = useCallback(async () => {
    const ids = [...selected];
    if (ids.length === 0) return;
    setBulkBusy(true);
    let response: Response | null = null;
    try {
      response = await fetch(`${api}/unanswered/resolutions`, {
        method: tab === 'open' ? 'PUT' : 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ids }),
      });
      if (response.status === 401) return unauthorized();
      if (!response.ok) throw new Error('failed');
      const body = await response.json();
      const done = new Set<number>(tab === 'open' ? body.resolved : body.reopened);
      setQuestions((current) => current?.filter((x) => !done.has(x.id)) ?? null);
      const what = `${done.size} question${done.size === 1 ? '' : 's'}`;
      const skipped = ids.length - done.size;
      notify(
        (tab === 'open' ? `Marked ${what} resolved. They are under Resolved now.` : `Reopened ${what}. They are under Open now.`) +
          (skipped > 0 ? ` ${skipped} could not be changed; refresh the list.` : ''),
        skipped > 0 ? 'error' : 'ok',
      );
    } catch (failure) {
      notify(await describeFailure(failure as Error, response), 'error');
    } finally {
      setBulkBusy(false);
    }
  }, [api, selected, tab, unauthorized]);

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
            <>
              <ListSearch value={query} onChange={setQuery} label="Search the questions" />
              <p className="list-count" aria-live="polite">
                {query.trim() === ''
                  ? `${questions.length} question${questions.length === 1 ? '' : 's'}${questions.length >= limit ? `, the most recent ${limit}` : ''}`
                  : `${matching.length} of ${questions.length}${questions.length >= limit ? ' loaded' : ''} match`}
              </p>
              {visible.length > 0 && (
                <div className="unanswered-bulk">
                  <label>
                    <input
                      ref={selectAll}
                      type="checkbox"
                      checked={allVisibleSelected}
                      disabled={bulkBusy}
                      onChange={(e) => setSelected(e.target.checked ? new Set(visible.map((q) => q.id)) : new Set())}
                    />
                    Select all shown
                  </label>
                  {selected.size > 0 && (
                    <>
                      <span className="small muted" aria-live="polite">
                        {selected.size} selected
                      </span>
                      <button type="button" className="sm primary" aria-busy={bulkBusy || undefined} disabled={bulkBusy || busyId !== null} onClick={() => void bulkToggle()}>
                        {tab === 'open' ? (
                          <>
                            <Icon name="check" size={14} /> Mark {selected.size} resolved
                          </>
                        ) : (
                          `Reopen ${selected.size}`
                        )}
                      </button>
                      <button type="button" className="sm ghost" disabled={bulkBusy} onClick={() => setSelected(new Set())}>
                        Clear selection
                      </button>
                    </>
                  )}
                </div>
              )}
              {matching.length === 0 && (
                <EmptyState
                  icon="search"
                  title={`No question matches “${query.trim()}”`}
                  action={
                    <button type="button" onClick={() => setQuery('')}>
                      Clear search
                    </button>
                  }
                  compact
                />
              )}
              {visible.map((q) => (
                // The question is a React child, so a visitor's text is escaped (CLAUDE.md § Conventions).
                <div key={q.id} className={selected.has(q.id) ? 'unanswered selected' : 'unanswered'}>
                  <input
                    type="checkbox"
                    aria-labelledby={`unanswered-${q.id}`}
                    checked={selected.has(q.id)}
                    disabled={bulkBusy}
                    onChange={(e) => toggleOne(q.id, e.target.checked)}
                  />
                  <div className="unanswered-text">
                    <span className="unanswered-question" id={`unanswered-${q.id}`}>
                      {q.question}
                    </span>
                    <span className="unanswered-when">
                      Asked {askedLabel(q.askedAt)}
                      {q.resolvedAt && ` · resolved ${askedLabel(q.resolvedAt)}`}
                    </span>
                  </div>
                  <button type="button" className="sm" aria-busy={busyId === q.id || undefined} disabled={busyId !== null || bulkBusy} onClick={() => void toggleResolved(q)}>
                    {tab === 'open' ? (
                      <>
                        <Icon name="check" size={14} /> Mark resolved
                      </>
                    ) : (
                      'Reopen'
                    )}
                  </button>
                </div>
              ))}
              {matching.length > shown && (
                <div className="list-more">
                  <span>
                    Showing {shown} of {matching.length}
                  </span>
                  <button type="button" className="sm" onClick={() => setShown((n) => n + PAGE_SIZE)}>
                    Show {Math.min(PAGE_SIZE, matching.length - shown)} more
                  </button>
                </div>
              )}
            </>
          )}
        </section>
      </StaffFrame>
    </>
  );
}
