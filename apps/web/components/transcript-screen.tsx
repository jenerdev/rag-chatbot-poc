'use client';

// S-16a · one conversation's transcript (plan/conversations.md, D-115):
// every message as it was STORED, oldest first, read-only. Nothing on this
// page writes (plan Rule 1).
//
// What it can show is what `messages` holds: the text. A refusal is stored
// as the NO_ANSWER marker, so it is drawn as a "Not answered" badge with the
// words the visitor saw beside it (the tenant's English fallback: the reply
// language is not stored). A failed or interrupted turn says so. Sources and
// tool results were never stored, so there is no sources panel (§ 7 q3).
//
// The assistant's text goes through ReplyText, so a table and **bold** are
// drawn as elements and nothing as HTML (D-091).
//
// `?m=<message id>` scrolls to that message and marks it: Unanswered's
// "View conversation" lands on the refusal it came from.

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import type { Transcript, TranscriptMessage } from '@rag/pipeline';
import { LoginForm, describeFailure } from '@/components/admin-login';
import { fetchRole } from '@/components/tenant-nav';
import { StaffFrame } from '@/components/staff-frame';
import { Icon } from '@/components/icons';
import { EmptyState, LOADING, LoadState, failed, type Load } from '@/components/load-state';
import { ReplyText } from '@/components/reply-text';
import { questionsLabel, refusalsLabel, timeLabel, whenLabel } from '@/lib/conversation-words';
import type { NavFeatures } from '@/lib/nav-items';
import { isRole, type Role } from '@/lib/permissions';

export interface TranscriptScreenProps {
  slug: string;
  id: string;
  businessName: string;
  assistantName: string;
  logoUrl: string | null;
  nav: NavFeatures;
  /** The list's filters as a query string, for Back ('' for none). */
  backQuery: string;
  /** The message to scroll to and mark, or null. */
  focus: number | null;
}

type Auth = 'checking' | 'out' | 'in';

/** What a turn's badge says, beside its time. */
function Badge({ message }: { message: TranscriptMessage }) {
  switch (message.kind) {
    case 'refusal':
      return <span className="badge danger">Not answered</span>;
    case 'failed':
      return <span className="badge warn">Request failed</span>;
    case 'interrupted':
      return <span className="badge warn">Interrupted</span>;
    default:
      return null;
  }
}

export function TranscriptScreen({ slug, id, businessName, assistantName, logoUrl, nav, backQuery, focus }: TranscriptScreenProps) {
  const api = `/api/t/${slug}`;
  const [auth, setAuth] = useState<Auth>('checking');
  const [role, setRole] = useState<Role | null>(null);
  const [transcript, setTranscript] = useState<Transcript | 'missing' | null>(null);
  const [loadState, setLoadState] = useState<Load>(LOADING);

  const unauthorized = useCallback(() => {
    setAuth('out');
    setTranscript(null);
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
      response = await fetch(`${api}/admin/conversations/${encodeURIComponent(id)}`);
      if (response.status === 401) return unauthorized();
      if (response.status === 404) return setTranscript('missing');
      if (!response.ok) throw new Error('failed');
      setTranscript(await response.json());
    } catch (error) {
      setTranscript(null);
      setLoadState(failed(await describeFailure(error as Error, response)));
    }
  }, [api, id, unauthorized]);

  useEffect(() => {
    if (auth === 'in') void load();
  }, [auth, load]);

  // Once the messages are drawn, bring the focused one into view.
  useEffect(() => {
    if (focus === null || transcript === null || transcript === 'missing') return;
    document.getElementById(`message-${focus}`)?.scrollIntoView({ block: 'center' });
  }, [focus, transcript]);

  const logout = useCallback(async () => {
    await fetch(`${api}/admin/session`, { method: 'DELETE' }).catch(() => undefined);
    unauthorized();
  }, [api, unauthorized]);

  const frame = { slug, businessName, logoUrl, features: nav, current: 'conversations' as const, title: 'Conversation', session: { auth, role, onLogout: logout } };
  const back = (
    <Link className="button" href={`/t/${slug}/admin/conversations${backQuery}`}>
      <Icon name="chevron-left" size={16} /> Conversations
    </Link>
  );

  if (auth !== 'in') {
    return (
      <StaffFrame {...frame}>
        {auth === 'checking' ? (
          <div className="small muted">Checking your session…</div>
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

  if (transcript === 'missing') {
    return (
      <StaffFrame {...frame} actions={back}>
        <section className="card">
          <EmptyState icon="search" title="No such conversation">
            It may have been removed, or the link is incomplete. Find it in the list.
          </EmptyState>
        </section>
      </StaffFrame>
    );
  }

  if (transcript === null) {
    return (
      <StaffFrame {...frame} actions={back}>
        <LoadState load={loadState} what="conversation" onRetry={() => { setLoadState(LOADING); void load(); }} />
      </StaffFrame>
    );
  }

  const { messages, timezone, fallback } = transcript;
  const turns = messages.filter((m) => m.kind === 'question').length;
  const refusals = messages.filter((m) => m.kind === 'refusal').length;
  const firstAt = messages[0]?.createdAt;
  const lastAt = messages.at(-1)?.createdAt;

  return (
    <StaffFrame {...frame} actions={back}>
      <section className="card">
        <div className="transcript-head">
          {firstAt ? (
            <span>
              Started <strong>{whenLabel(firstAt, timezone)}</strong>
              {lastAt && lastAt !== firstAt ? <> · last message {whenLabel(lastAt, timezone)}</> : null}
            </span>
          ) : (
            <span>No messages</span>
          )}
          <span className="transcript-counts">
            {questionsLabel(turns)}
            {refusals > 0 && <span className="badge danger">{refusalsLabel(refusals)}</span>}
          </span>
        </div>

        {messages.length === 0 ? (
          <EmptyState icon="messages" title="Nothing was said" compact>
            The chat was opened, but no message was saved.
          </EmptyState>
        ) : (
          <ol className="transcript" aria-label="Messages, oldest first">
            {messages.map((m) => (
              <li key={m.id} id={`message-${m.id}`} className={`turn ${m.role}${m.id === focus ? ' focused' : ''}`}>
                {m.role === 'user' ? (
                  <div className="transcript-user">
                    <span className="transcript-meta">
                      Visitor · <time dateTime={m.createdAt}>{timeLabel(m.createdAt, timezone)}</time>
                    </span>
                    {/* A visitor's words, as a React child: escaped. */}
                    <div className="bubble">{m.content}</div>
                  </div>
                ) : (
                  <div className="assistant-body">
                    <span className="transcript-meta">
                      {assistantName} · <time dateTime={m.createdAt}>{timeLabel(m.createdAt, timezone)}</time> <Badge message={m} />
                    </span>
                    {m.kind === 'refusal' ? (
                      <div className="transcript-refusal">
                        <span className="muted">The visitor saw: “{fallback}”</span>
                        {m.resolved ? (
                          <span className="badge ok">Resolved</span>
                        ) : (
                          <Link href={`/t/${slug}/admin/unanswered`}>Open in Unanswered</Link>
                        )}
                      </div>
                    ) : m.kind === 'failed' ? (
                      <p className="muted transcript-note">The assistant could not answer: the request failed before any text arrived.</p>
                    ) : (
                      <div className="bubble">
                        <ReplyText text={m.content} />
                      </div>
                    )}
                  </div>
                )}
              </li>
            ))}
          </ol>
        )}
      </section>
    </StaffFrame>
  );
}
