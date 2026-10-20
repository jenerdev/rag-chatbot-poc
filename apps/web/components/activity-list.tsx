'use client';

// The activity list (plan/audit-log.md, D-138): ONE component, three
// callers. S-18 /t/<slug>/admin/activity draws it inside the staff frame
// for an owner (activity:read); the platform's tenant form draws it on its
// Activity tab for a super user; /platform/activity draws the platform's
// own rows (no tenant). Each hands it the route to read from and whether
// the reader is the platform.
//
// A row is who (actorWords), what (activityWords), when (the tenant's
// zone), and a link to the subject's screen where one exists. The filters
// (window, area, one actor, a search over the label) live in the URL on
// S-18, so the page can be shared and Back finds it as it was left; the
// platform panels keep them in state. Keyset "Show more", as S-16.
//
// Nothing here writes: the log has no insert policy for any token.

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import type { ActivityPage, ActivityRow } from '@rag/pipeline';
import { describeFailure } from '@/components/admin-login';
import { Icon } from '@/components/icons';
import { Bone, EmptyState, LOADING, LoadState, failed, type Load } from '@/components/load-state';
import { ListSearch } from '@/components/list-search';
import { notify } from '@/components/toast';
import { Tip } from '@/components/tooltip';
import { ACTIVITY_WINDOWS, AREA_LABELS, activityHref, activityQuery, activityWords, actorWords, type ActivityFilters } from '@/lib/activity-words';
import { whenLabel } from '@/lib/conversation-words';

/** How long the search waits after the last keystroke before asking. */
const SEARCH_DEBOUNCE_MS = 300;
const SKELETON_WIDTHS = ['58%', '42%', '70%', '36%', '64%', '48%'];

function ActivitySkeleton() {
  return (
    <>
      <p className="list-count">
        <Bone w="20ch" h="small" />
      </p>
      <ul className="activity-list">
        {SKELETON_WIDTHS.map((w, i) => (
          <li key={i} className="activity-row">
            <span className="activity-who">
              <Bone w="14ch" h="small" />
            </span>
            <span className="activity-what">
              <Bone w={w} />
            </span>
            <span className="activity-when">
              <Bone w="11ch" h="small" />
            </span>
          </li>
        ))}
      </ul>
    </>
  );
}

export function ActivityList({
  api,
  slug,
  platformView = false,
  initial,
  syncUrl = false,
  onUnauthorized,
  retentionDays,
}: {
  /** the route: /api/t/<slug>/admin/activity, /api/platform/tenants/<id>/activity or /api/platform/activity */
  api: string;
  /** the tenant's slug, for links to its screens; null on the platform's own list */
  slug: string | null;
  /** a super user reading: the actor column says "Super user", not "Platform" */
  platformView?: boolean;
  initial: ActivityFilters;
  /** S-18: the filters follow the URL */
  syncUrl?: boolean;
  onUnauthorized: () => void;
  /** how long rows are kept, for the notice line; null on the platform's own list */
  retentionDays: number | null;
}) {
  const [days, setDays] = useState(initial.days);
  const [area, setArea] = useState(initial.area);
  const [actor, setActor] = useState(initial.actor);
  const [typed, setTyped] = useState(initial.q);
  const [q, setQ] = useState(initial.q);
  const [page, setPage] = useState<{ timezone: string; total: number; more: boolean; rows: ActivityRow[] } | null>(null);
  const [loadState, setLoadState] = useState<Load>(LOADING);
  const [moreBusy, setMoreBusy] = useState(false);
  const filters: ActivityFilters = { days, area, actor, q };
  const query = activityQuery(filters);

  useEffect(() => {
    const t = setTimeout(() => setQ(typed.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [typed]);

  useEffect(() => {
    if (syncUrl) window.history.replaceState(null, '', `${window.location.pathname}${query}`);
  }, [query, syncUrl]);

  const routeUrl = useCallback(
    (after: ActivityRow | null) => {
      const p = new URLSearchParams({ days: String(days) });
      if (area) p.set('area', area);
      if (actor) p.set('actor', actor);
      if (q) p.set('q', q);
      if (after) {
        p.set('before', after.at);
        p.set('beforeKey', after.key);
      }
      return `${api}?${p}`;
    },
    [api, days, area, actor, q],
  );

  const latest = useRef(0);
  const load = useCallback(async () => {
    const ticket = ++latest.current;
    setPage(null);
    setLoadState(LOADING);
    let response: Response | null = null;
    try {
      response = await fetch(routeUrl(null));
      if (response.status === 401) return onUnauthorized();
      if (!response.ok) throw new Error('failed');
      const body = (await response.json()) as ActivityPage;
      if (ticket === latest.current) setPage({ timezone: body.timezone, total: body.total, more: body.more, rows: body.rows });
    } catch (error) {
      if (ticket === latest.current) setLoadState(failed(await describeFailure(error as Error, response)));
    }
  }, [routeUrl, onUnauthorized]);

  useEffect(() => {
    void load();
  }, [load]);

  const loadMore = useCallback(async () => {
    const last = page?.rows.at(-1);
    if (!page || !last) return;
    setMoreBusy(true);
    let response: Response | null = null;
    try {
      response = await fetch(routeUrl(last));
      if (response.status === 401) return onUnauthorized();
      if (!response.ok) throw new Error('failed');
      const body = (await response.json()) as ActivityPage;
      setPage((current) => (current ? { ...current, more: body.more, rows: [...current.rows, ...body.rows] } : current));
    } catch (failure) {
      notify(await describeFailure(failure as Error, response), 'error');
    } finally {
      setMoreBusy(false);
    }
  }, [page, routeUrl, onUnauthorized]);

  const filtered = area !== '' || actor !== '' || q !== '';
  const windowWords = `the last ${days} days`;
  const areas = slug === null ? ['platform', 'session'] : Object.keys(AREA_LABELS).filter((a) => a !== 'platform');

  return (
    <>
      <p className="small muted activity-intro">
        {slug === null ? 'What super users did on the platform.' : 'Who did what in this workspace, newest first.'} Times are {slug === null ? 'Manila' : 'the business’s local'} time.
        {retentionDays !== null ? ` Kept for ${retentionDays} days.` : ''} Failed sign-ins are not listed here; Supabase keeps those.
      </p>
      <div className="conversations-toolbar">
        <ListSearch value={typed} onChange={setTyped} label="Search by name" />
        <div className="segmented" role="group" aria-label="Window">
          {ACTIVITY_WINDOWS.map((d) => (
            <button key={d} type="button" aria-pressed={d === days} onClick={() => setDays(d)}>
              {d === 365 ? '1 year' : `${d} days`}
            </button>
          ))}
        </div>
        <label className="activity-area">
          <span className="visually-hidden">Area</span>
          <select value={area} onChange={(e) => setArea(e.target.value)}>
            <option value="">Every area</option>
            {areas.map((a) => (
              <option key={a} value={a}>
                {AREA_LABELS[a]}
              </option>
            ))}
          </select>
        </label>
        {actor && (
          <button type="button" className="sm" onClick={() => setActor('')}>
            <Icon name="close" size={14} /> One person
          </button>
        )}
        <Tip label="Refresh">
          <button type="button" className="ghost sm" aria-label="Refresh the list" onClick={() => void load()}>
            <Icon name="refresh" size={16} />
          </button>
        </Tip>
      </div>

      {page === null ? (
        <LoadState load={loadState} what="activity" onRetry={() => void load()} skeleton={<ActivitySkeleton />} />
      ) : page.rows.length === 0 ? (
        filtered ? (
          <EmptyState
            icon="search"
            title="Nothing matches"
            action={
              <button
                type="button"
                onClick={() => {
                  setTyped('');
                  setQ('');
                  setArea('');
                  setActor('');
                }}
              >
                Clear filters
              </button>
            }
            compact
          >
            Nothing in {windowWords} matches these filters. Try a longer window.
          </EmptyState>
        ) : (
          <EmptyState icon="eye" title={`Nothing in ${windowWords}`}>
            Actions on this workspace appear here as they happen.
          </EmptyState>
        )
      ) : (
        <>
          <p className="list-count" aria-live="polite">
            {page.total} {page.total === 1 ? 'action' : 'actions'} in {windowWords}
            {filtered ? ' match' : ''}
            {page.rows.length < page.total ? `, showing ${page.rows.length}` : ''}
          </p>
          <ul className="activity-list">
            {page.rows.map((r) => {
              const href = slug ? activityHref(slug, r) : null;
              const who = actorWords(r, platformView);
              const canFilter = r.actorUser !== null && r.actorKind !== 'guest';
              return (
                <li key={r.key} className={`activity-row${r.source === 'bookings' ? ' is-booking' : ''}${r.actorKind === 'super' ? ' is-platform' : ''}`}>
                  <span className="activity-who">
                    {canFilter ? (
                      <button type="button" className="link" aria-pressed={actor === r.actorUser} onClick={() => setActor(actor === r.actorUser ? '' : (r.actorUser ?? ''))}>
                        {who}
                      </button>
                    ) : (
                      who
                    )}
                  </span>
                  <span className="activity-what">
                    {/* Every label is a React child, so it is escaped (CLAUDE.md § Conventions). */}
                    {activityWords(r)}
                    {href && (
                      <>
                        {' '}
                        <Link href={href} className="activity-link">
                          open
                        </Link>
                      </>
                    )}
                  </span>
                  <span className="activity-when small muted">{whenLabel(r.at, page.timezone)}</span>
                </li>
              );
            })}
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
    </>
  );
}
