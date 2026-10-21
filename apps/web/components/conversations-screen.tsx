'use client';

// S-16 · Conversations (plan/conversations.md, D-115). Every chat visitors
// had with this tenant's assistant, newest activity first; a row opens its
// transcript (S-16a, transcript-screen.tsx).
//
// Rendered by app/t/[tenant]/admin/conversations/page.tsx, which holds no
// data. Its one route is admin-only, so it starts the way the other staff
// screens do: is there a session for THIS tenant?
//
// Unlike Unanswered's search, this one asks the SERVER: the list is paged
// (25 a page, keyset) and the match is over every message of a chat, not
// only the rows loaded. So the field is debounced, and the filters (window,
// search, only refused) live in the URL, where a transcript's Back link
// finds them again.

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import type { ConversationPage, ConversationSummary } from '@rag/pipeline';
import { LoginForm, describeFailure } from '@/components/admin-login';
import { fetchRole } from '@/components/tenant-nav';
import { StaffFrame } from '@/components/staff-frame';
import { Icon } from '@/components/icons';
import { Bone, EmptyState, LOADING, LoadState, failed, type Load } from '@/components/load-state';
import { ListSearch } from '@/components/list-search';
import { notify } from '@/components/toast';
import { Tip } from '@/components/tooltip';
import { LIST_DAYS, listQuery, questionsLabel, refusalsLabel, whenLabel, type ListFilters } from '@/lib/conversation-words';
import type { NavFeatures } from '@/lib/nav-items';
import { isRole, type Role } from '@/lib/permissions';

export interface ConversationsScreenProps {
  slug: string;
  businessName: string;
  logoUrl: string | null;
  nav: NavFeatures;
  /** The filters the URL arrived with (lib/conversation-words.ts). */
  initial: ListFilters;
}

type Auth = 'checking' | 'out' | 'in';

/** How long the search waits after the last keystroke before asking. */
const SEARCH_DEBOUNCE_MS = 300;

/** Widths of the skeleton's first questions, so the rows do not look stamped. */
const SKELETON_QUESTIONS = ['62%', '45%', '74%', '38%', '55%'];

/**
 * The list before its first page: the count line, then rows in the real
 * `.conversation-row` grid (question, when · questions, a refusal badge on
 * one, the chevron).
 */
function ConversationsSkeleton() {
  return (
    <>
      <p className="list-count">
        <Bone w="22ch" h="small" />
      </p>
      <ul className="conversation-list">
        {SKELETON_QUESTIONS.map((w, i) => (
          <li key={i} className={i === 1 ? 'conversation-row has-refusal' : 'conversation-row'}>
            <div className="conversation-row-body">
              <span className="conversation-row-link">
                <Bone w={w} />
              </span>
              <span className="conversation-row-meta">
                <Bone w="12ch" h="small" />
                <Bone w="9ch" h="small" />
              </span>
            </div>
            {/* `badge` too: the phone layout places a row's badge by that class. */}
            {i === 1 && <Bone w="10ch" h="chip" className="badge" />}
            <Bone w="16px" h="16px" />
          </li>
        ))}
      </ul>
    </>
  );
}

export function ConversationsScreen({ slug, businessName, logoUrl, nav, initial }: ConversationsScreenProps) {
  const api = `/api/t/${slug}`;
  const [auth, setAuth] = useState<Auth>('checking');
  const [role, setRole] = useState<Role | null>(null);
  const [days, setDays] = useState(initial.days);
  const [refused, setRefused] = useState(initial.refused);
  // What is typed, and what was last asked: the second trails the first.
  const [typed, setTyped] = useState(initial.q);
  const [q, setQ] = useState(initial.q);
  const [page, setPage] = useState<{ timezone: string; total: number; more: boolean; rows: ConversationSummary[] } | null>(null);
  const [loadState, setLoadState] = useState<Load>(LOADING);
  const [moreBusy, setMoreBusy] = useState(false);
  const filters: ListFilters = { days, q, refused };
  const query = listQuery(filters);

  useEffect(() => {
    const t = setTimeout(() => setQ(typed.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [typed]);

  // The URL follows the filters (replace, not push: Back leaves the page).
  useEffect(() => {
    window.history.replaceState(null, '', `${window.location.pathname}${query}`);
  }, [query]);

  const unauthorized = useCallback(() => {
    setAuth('out');
    setPage(null);
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

  /** The route's URL for the current filters, from a row on (the keyset) or from the top. */
  const routeUrl = useCallback(
    (after: ConversationSummary | null) => {
      const p = new URLSearchParams({ days: String(days) });
      if (q) p.set('q', q);
      if (refused) p.set('refused', '1');
      if (after) {
        p.set('before', after.lastAt);
        p.set('beforeId', after.id);
      }
      return `${api}/admin/conversations?${p}`;
    },
    [api, days, q, refused],
  );

  // A newer request wins: a slow answer to an older search is dropped.
  const latest = useRef(0);
  const load = useCallback(async () => {
    const ticket = ++latest.current;
    setPage(null);
    setLoadState(LOADING);
    let response: Response | null = null;
    try {
      response = await fetch(routeUrl(null));
      if (response.status === 401) return unauthorized();
      if (!response.ok) throw new Error('failed');
      const body = (await response.json()) as ConversationPage;
      if (ticket === latest.current) setPage({ timezone: body.timezone, total: body.total, more: body.more, rows: body.rows });
    } catch (error) {
      if (ticket === latest.current) setLoadState(failed(await describeFailure(error as Error, response)));
    }
  }, [routeUrl, unauthorized]);

  useEffect(() => {
    if (auth === 'in') void load();
  }, [auth, load]);

  const loadMore = useCallback(async () => {
    const last = page?.rows.at(-1);
    if (!page || !last) return;
    setMoreBusy(true);
    let response: Response | null = null;
    try {
      response = await fetch(routeUrl(last));
      if (response.status === 401) return unauthorized();
      if (!response.ok) throw new Error('failed');
      const body = (await response.json()) as ConversationPage;
      // The first page's total stays: a later page counts nothing new (the function's note).
      setPage((current) => (current ? { ...current, more: body.more, rows: [...current.rows, ...body.rows] } : current));
    } catch (failure) {
      notify(await describeFailure(failure as Error, response), 'error');
    } finally {
      setMoreBusy(false);
    }
  }, [page, routeUrl, unauthorized]);

  const logout = useCallback(async () => {
    await fetch(`${api}/admin/session`, { method: 'DELETE' }).catch(() => undefined);
    unauthorized();
  }, [api, unauthorized]);

  const frame = { slug, businessName, logoUrl, features: nav, current: 'conversations' as const, title: 'Conversations', session: { auth, role, onLogout: logout } };

  if (auth !== 'in') {
    return (
      <StaffFrame {...frame}>
        {auth === 'checking' ? (
          null
        ) : (
          <LoginForm
            api={api}
            slug={slug}
            onLoggedIn={() => {
              setAuth('in');
              void fetchRole(api).then(setRole);
            }}
          />
        )}
      </StaffFrame>
    );
  }

  const filtered = q !== '' || refused;
  const windowWords = `the last ${days} days`;

  return (
    <StaffFrame {...frame}>
      <section className="card">
        <p className="small muted conversations-intro">
          What visitors asked the assistant, and what it answered. Times are the business&apos;s local time.
        </p>
        <div className="conversations-toolbar">
          <ListSearch value={typed} onChange={setTyped} label="Search every message" />
          <div className="segmented" role="group" aria-label="Window">
            {LIST_DAYS.map((d) => (
              <button key={d} type="button" aria-pressed={d === days} onClick={() => setDays(d)}>
                {d} days
              </button>
            ))}
          </div>
          <label className="conversations-refused">
            <input type="checkbox" checked={refused} onChange={(e) => setRefused(e.target.checked)} />
            Only with an unanswered question
          </label>
          <Tip label="Refresh">
            <button type="button" className="ghost sm" aria-label="Refresh the list" onClick={() => void load()}>
              <Icon name="refresh" size={16} />
            </button>
          </Tip>
        </div>

        {page === null ? (
          <LoadState load={loadState} what="conversations" onRetry={() => void load()} skeleton={<ConversationsSkeleton />} />
        ) : page.rows.length === 0 ? (
          filtered ? (
            <EmptyState
              icon="search"
              title={q ? `No conversation mentions “${q}”` : 'No conversation with an unanswered question'}
              action={
                <button
                  type="button"
                  onClick={() => {
                    setTyped('');
                    setQ('');
                    setRefused(false);
                  }}
                >
                  Clear filters
                </button>
              }
              compact
            >
              Nothing in {windowWords} matches. Try a longer window.
            </EmptyState>
          ) : (
            <EmptyState icon="messages" title={`No conversations in ${windowWords}`}>
              Chats appear here as visitors ask the assistant questions.
            </EmptyState>
          )
        ) : (
          <>
            <p className="list-count" aria-live="polite">
              {page.total} conversation{page.total === 1 ? '' : 's'} in {windowWords}
              {filtered ? ' match' : ''}
              {page.rows.length < page.total ? `, showing ${page.rows.length}` : ''}
            </p>
            <ul className="conversation-list">
              {page.rows.map((c) => (
                <li key={c.id} className={c.refusals > 0 ? 'conversation-row has-refusal' : 'conversation-row'}>
                  <div className="conversation-row-body">
                    {/* The visitor's words are a React child, so they are escaped (CLAUDE.md § Conventions). */}
                    <Link className="conversation-row-link" href={`/t/${slug}/admin/conversations/${c.id}${query}`}>
                      {c.firstQuestion || <span className="muted">(no question)</span>}
                    </Link>
                    <span className="conversation-row-meta">
                      <span>{whenLabel(c.lastAt, page.timezone)}</span>
                      <span>{questionsLabel(c.turns)}</span>
                    </span>
                  </div>
                  {c.refusals > 0 && <span className="badge danger">{refusalsLabel(c.refusals)}</span>}
                  <Icon name="chevron-right" size={16} />
                </li>
              ))}
            </ul>
            {page.more && (
              <div className="list-more">
                <span>
                  Showing {page.rows.length} of {page.total}
                </span>
                <button type="button" className="sm" aria-busy={moreBusy || undefined} disabled={moreBusy} onClick={() => void loadMore()}>
                  Show more
                </button>
              </div>
            )}
          </>
        )}
      </section>
    </StaffFrame>
  );
}
