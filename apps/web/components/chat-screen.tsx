'use client';

// S-1 · Chat. Ask questions, see answers grounded in the knowledge base.
//
// TENANCY (Phase 7): rendered by app/t/[tenant]/page.tsx, a Server Component
// that resolves the tenant and passes everything in as props. The slug is
// NEVER parsed out of window.location. It arrives from the server, which has
// already checked that it names a real tenant. Every fetch is prefixed with it.
//
// Ported from public/index.html + public/app.js. The two rules that ran through
// that file still hold, one of them for free:
//
//   1. Never inject server or model output as markup. In the POC that meant
//      `textContent, NEVER innerHTML`, written out at every call site. React
//      escapes children by default, so the rule now costs nothing — and comes
//      back the moment anyone reaches for dangerouslySetInnerHTML.
//   2. No markdown rendering, with ONE exception since plan/tables.md (D-091):
//      a pipe table in the reply is drawn as a <table> by <ReplyText>, from
//      lib/tables.ts, a hand-written parser that knows that one block shape
//      and hands React strings, never markup. Everything else is still text:
//      newlines are handled by CSS (white-space: pre-wrap), not by parsing.
//
// The look (plan/ui-refresh.md Phase 3): the visitor's turns are filled
// bubbles on the right; the assistant's are text on the page beside a small
// mark (the tenant's logo, else its initial), the way a reply reads in a
// document. The composer is one rounded field with the send arrow inside it;
// the visitor may type the next question while an answer streams, and only
// sending waits. Scrolled up during an answer, a "New messages" button
// offers the way back instead of yanking the view.

import Link from 'next/link';
import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import type { RoomCard, Source, ToolCallRecord } from '@rag/pipeline';
import { SourcesPanel } from '@/components/sources-panel';
import { ReplyText } from '@/components/reply-text';
import { describeFailure, readEventStream } from '@/lib/chat-stream';
import { Icon } from '@/components/icons';
import { MicButton, ReadAloudToggle, useVoice, VoiceStatus } from '@/components/voice';
import type { NavFeatures } from '@/lib/nav-items';
import { welcomeTextOf } from '@/lib/welcome-text';

/** Everything the server resolved about the tenant. No ids, no admin hash. */
export interface ChatScreenProps {
  slug: string;
  businessName: string;
  assistantName: string;
  logoUrl: string | null;
  bannerUrl: string | null;
  /** The assistant's own picture (D-124), set on the platform page; null: the logo, else its initial. */
  assistantAvatarUrl?: string | null;
  /** The welcome card's line under the assistant's name (D-139); null = the default words (lib/welcome-text.ts). */
  welcomeText?: string | null;
  /** Counted on the server: the document list itself is admin-only (Phase 6). */
  documentCount: number;
  /**
   * What the tenant has (lib/nav.ts); the chat reads `book`, the customer
   * booking page (plan/customer-booking.md § 8 q5), and `manage` (D-136):
   * buttons on the welcome and links under the field, never a link in the
   * model's reply: the chat renders no links, and the model never books
   * (D-037).
   */
  nav: NavFeatures;
  /**
   * The tenant's suggested questions (D-089), set on the platform form and
   * read through tenant_public(). Buttons on a new, empty chat; a click sends
   * the question as if typed. [] = none, the empty state as it was.
   */
  suggestedQuestions: string[];
}

type Turn =
  | { id: number; kind: 'user'; text: string }
  | { id: number; kind: 'pending' }
  // `error` is set when a failure arrives AFTER the answer started: the partial
  // answer is kept and the error shown underneath it, rather than discarding
  // text the model already produced.
  | {
      id: number;
      kind: 'answer';
      text: string;
      /** The chunks, for a member who may see them (D-140); null when the route left them out: nothing is drawn, not even "no sources". */
      sources: Source[] | null;
      /** Filled in by `tool` events, one per call, before the answer that uses them (plan/bookings.md Phase 7). */
      toolCalls: ToolCallRecord[];
      /** From `meta` at a per_room tenant (D-094): the rooms' photos, drawn as cards or, grouped by room with the photo button under the name, on the reply's table. */
      roomCards?: RoomCard[];
      roomCardsView?: 'cards' | 'column';
      searchQuery: string;
      question: string;
      error?: string;
    }
  | { id: number; kind: 'failed'; message: string; question: string };

let nextId = 0;

/**
 * The wait, shown as three pulsing dots rather than words. Used twice: before
 * the sources arrive (`pending`), and after, while the answer bubble is still
 * empty (a tool answer is held, not streamed, so that gap can be seconds).
 * The label is for screen readers; the dots are decoration.
 */
/** The assistant's mark beside each of its turns: the tenant's logo, else its initial. */
function AssistantMark({ name, logoUrl }: { name: string; logoUrl: string | null }) {
  return logoUrl ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img className="assistant-mark" src={logoUrl} alt="" />
  ) : (
    <span className="assistant-mark" aria-hidden="true">
      {name.trim().charAt(0).toUpperCase() || '?'}
    </span>
  );
}

function Thinking() {
  return (
    <div className="bubble thinking" role="status" aria-label="Thinking">
      <span />
      <span />
      <span />
    </div>
  );
}

export function ChatScreen({
  slug,
  businessName,
  assistantName,
  logoUrl,
  bannerUrl,
  assistantAvatarUrl = null,
  welcomeText = null,
  documentCount,
  nav,
  suggestedQuestions,
}: ChatScreenProps) {
  // Who speaks: the assistant's own picture, else the business's logo, else its initial (AssistantMark).
  const markUrl = assistantAvatarUrl ?? logoUrl;
  const api = `/api/t/${slug}`;
  const [turns, setTurns] = useState<Turn[]>([]);
  const [busy, setBusy] = useState(false);
  const [input, setInput] = useState('');
  // An empty knowledge base makes every question return the refusal, which
  // looks broken if you do not know why. Better to say so up front. The count
  // comes from the server, so there is no request to wait for.
  const emptyKb = documentCount === 0;
  // Voice (plan/voice.md, D-134): drawn only where a super user switched it on.
  const voiceOn = nav.flags.voice;
  const voice = useVoice(api);

  const messagesRef = useRef<HTMLElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // The conversation lives in the database; the browser only has to remember
  // its id — the server re-sends the last few messages to the model on every
  // turn. Refreshing the page starts a new conversation, which is deliberate:
  // listing past conversations is out of scope (mvp.md).
  const conversationId = useRef<string | null>(null);
  // True while the reader is at the bottom. Set false the moment they scroll up
  // to re-read something: yanking the viewport while someone is reading is
  // worse than making them scroll.
  const stick = useRef(true);
  // Something arrived while the reader was scrolled up: offer the way down.
  const [unseen, setUnseen] = useState(false);

  const scrollToBottom = useCallback(() => {
    const el = messagesRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);

  // useLayoutEffect, not useEffect: scrolling after the browser has painted the
  // new text produces a visible jump on every delta.
  // The welcome is read from its top (its cover, the assistant's face), so
  // nothing scrolls until there is a conversation: on a phone the welcome is
  // taller than the screen, and scrolling it to the bottom hid the cover.
  useLayoutEffect(() => {
    if (turns.length === 0) return;
    if (stick.current) scrollToBottom();
    else setUnseen(true);
  }, [turns, scrollToBottom]);

  const onScroll = useCallback(() => {
    const el = messagesRef.current;
    if (!el) return;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (stick.current) setUnseen(false);
  }, []);

  const jumpDown = useCallback(() => {
    stick.current = true;
    setUnseen(false);
    scrollToBottom();
  }, [scrollToBottom]);

  const send = useCallback(
    async (text: string, spoken = false) => {
      setBusy(true);
      stick.current = true;
      // A new question silences the last answer.
      voice.stopSpeaking();

      const userId = nextId++;
      const replyId = nextId++;
      setTurns((prev) => [
        ...prev,
        { id: userId, kind: 'user', text },
        { id: replyId, kind: 'pending' },
      ]);

      let response: Response | null = null;
      // Mirrors the POC's `bubble` variable: non-null once `meta` has arrived,
      // which is how we know whether a failure should replace the turn or sit
      // underneath a partial answer.
      let started = false;
      let answered = '';

      try {
        response = await fetch(`${api}/chat`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            // Asking for the streamed form. Drop this header and the same
            // route returns one JSON body instead (D-019).
            Accept: 'text/event-stream',
          },
          body: JSON.stringify({ conversationId: conversationId.current, message: text }),
        });
        // Validation errors still arrive as a normal status, because they
        // happen before any streaming starts.
        if (!response.ok) throw new Error('request failed');

        let streamError: string | null = null;
        // The server ends every successful answer with `done`. Without checking
        // for it, ANY end of stream looks like success — including the server
        // dying or the socket dropping mid-sentence, which would leave a
        // truncated answer on screen indistinguishable from a complete one.
        let sawDone = false;

        await readEventStream(response, (event, data) => {
          if (event === 'meta') {
            conversationId.current = data.conversationId;
            started = true;
            // Swapped in the moment retrieval finishes, before a single token
            // of the answer exists — so the sources panel appears first and you
            // can read what the model was given while it is still deciding what
            // to make of it (D-019).
            setTurns((prev) =>
              prev.map((turn) =>
                turn.id === replyId
                  ? {
                      id: replyId,
                      kind: 'answer',
                      text: '',
                      // Absent for a guest (D-140): the route removed the keys, so a missing list means "not shown", never "none".
                      sources: Array.isArray(data.sources) ? data.sources : null,
                      toolCalls: [],
                      roomCards: data.roomCards,
                      roomCardsView: data.roomCardsView,
                      searchQuery: typeof data.searchQuery === 'string' ? data.searchQuery : '',
                      question: text,
                    }
                  : turn,
              ),
            );
          } else if (event === 'delta') {
            answered += data.text;
            setTurns((prev) =>
              prev.map((turn) =>
                turn.id === replyId && turn.kind === 'answer'
                  ? { ...turn, text: turn.text + data.text }
                  : turn,
              ),
            );
          } else if (event === 'tool') {
            // A tool call finished. It arrives after `meta` and before the
            // answer written from it, so the reader can see what was checked
            // while the answer is still being written, the same way sources
            // arrive first (D-019, D-037).
            setTurns((prev) =>
              prev.map((turn) =>
                turn.id === replyId && turn.kind === 'answer'
                  ? { ...turn, toolCalls: [...turn.toolCalls, data as ToolCallRecord] }
                  : turn,
              ),
            );
          } else if (event === 'done') {
            sawDone = true;
          } else if (event === 'error') {
            // A failure that happened after the response started. The status
            // code was already committed to 200, so this is the only way it can
            // reach us — and it has to be treated as seriously as a bad status.
            streamError = data.error;
          }
        });

        if (streamError) throw new Error(streamError);
        if (!sawDone) throw new Error('The connection closed before the answer finished.');
        // Read aloud once the reply is whole and stored (Rule 2): always after
        // a spoken question, after a typed one when the guest asked for it.
        if (voiceOn && (spoken || voice.readAloud) && conversationId.current && answered !== '') {
          void voice.speak(conversationId.current, answered);
        }
      } catch (caught) {
        const message = await describeFailure(caught as Error, response);
        // If the answer had already started, keep what arrived and put the
        // error underneath it rather than discarding a partial answer.
        if (started && answered !== '') {
          setTurns((prev) =>
            prev.map((turn) =>
              turn.id === replyId && turn.kind === 'answer' ? { ...turn, error: message } : turn,
            ),
          );
        } else {
          setTurns((prev) =>
            prev.map((turn) =>
              turn.id === replyId ? { id: replyId, kind: 'failed', message, question: text } : turn,
            ),
          );
        }
      } finally {
        setBusy(false);
        inputRef.current?.focus();
      }
    },
    [api, voice, voiceOn],
  );

  /**
   * Retry: drop the failed answer AND the question above it, then resend.
   *
   * Removing only the error would leave the original question in place while
   * send() adds it again — the same question twice after one retry.
   */
  const retry = useCallback(
    (failedId: number, question: string) => {
      setTurns((prev) => {
        const index = prev.findIndex((turn) => turn.id === failedId);
        if (index === -1) return prev;
        const previous = prev[index - 1];
        const from = previous && previous.kind === 'user' ? index - 1 : index;
        return prev.slice(0, from);
      });
      void send(question);
    },
    [send],
  );

  const submit = useCallback(() => {
    const text = input.trim();
    if (text === '' || busy) return;
    setInput('');
    if (inputRef.current) inputRef.current.style.height = 'auto';
    void send(text);
  }, [busy, input, send]);

  const newChat = useCallback(() => {
    // Clearing the id is all it takes: the server creates a new conversation
    // row on the next message. The old conversation stays in the database.
    conversationId.current = null;
    voice.cancel();
    voice.stopSpeaking();
    setTurns([]);
    setUnseen(false);
    inputRef.current?.focus();
  }, [voice]);

  // The microphone: the first press records, the second sends what was
  // heard, as the question, exactly as if it had been typed (§ 6 q1).
  const startListening = useCallback(async () => {
    const heard = await voice.listen();
    if (heard) void send(heard, true);
    else inputRef.current?.focus();
  }, [send, voice]);

  return (
    <div className="chat-layout">

      {/* <main>: the page's main landmark (Phase 10's audit found none on the chat). */}
      <main id="messages" ref={messagesRef} onScroll={onScroll}>
        {/* No header (the user's call, 2026-10-20): the welcome carries the
            brand, and the page's one h1 is the business, for screen readers.
            Both sit inside <main> (axe's region rule); the button is
            positioned on .chat-layout, so it does not scroll. */}
        <h1 className="visually-hidden">{businessName}</h1>
        {/* New chat floats over the conversation's corner, only once there is
            one: on the welcome it would do nothing. */}
        {turns.length > 0 && (
          <button className="chat-new" type="button" onClick={newChat}>
            <Icon name="plus" size={16} />
            <span className="narrow-hidden">New chat</span>
          </button>
        )}
        <div className="messages-inner">
          {/* The welcome (plan/public-brand.md): the tenant's banner, or a
              gradient of its accent, as a cover; its mark; the assistant
              introducing itself in a guest's words; the suggested questions;
              and, where the tenant takes bookings, the way to the booking
              page. It gives way to the conversation at the first message. */}
          {turns.length === 0 && (
            <section className="welcome" aria-labelledby="welcome-title">
              <div className={bannerUrl ? 'welcome-cover has-image' : 'welcome-cover'}>
                {bannerUrl && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={bannerUrl} alt="" />
                )}
              </div>
              <div className="welcome-body">
                <AssistantMark name={assistantName} logoUrl={markUrl} />
                <h2 id="welcome-title">Hi, I&rsquo;m {assistantName}</h2>
                <p className="welcome-role">{businessName}&rsquo;s assistant</p>
                <p className="welcome-text">
                  {emptyKb
                    ? 'I am still being set up, so I cannot answer questions yet. Please check back soon.'
                    : welcomeTextOf(welcomeText)}
                </p>
                {!emptyKb && suggestedQuestions.length > 0 && (
                  <div className="suggestions" role="group" aria-label="Suggested questions">
                    {suggestedQuestions.map((question) => (
                      <button key={question} type="button" disabled={busy} onClick={() => void send(question)}>
                        <span>{question}</span>
                        <Icon name="chevron-right" size={16} />
                      </button>
                    ))}
                  </div>
                )}
                {(nav.book || nav.manage) && (
                  <div className="welcome-book">
                    {nav.book && (
                      <span className="welcome-go">
                        <span>Know your dates?</span>
                        {/* "Book your stay" (D-125): an invitation, not "Book now" or "Reserve now",
                            which promise an instant confirmation the page does not give: a
                            request waits for staff (D-070), as the booking page says. */}
                        <Link className="button primary" href={`/t/${slug}/book`}>
                          <Icon name="calendar" size={16} /> Book your stay
                        </Link>
                      </span>
                    )}
                    {/* D-136: the chat links to Manage booking too, so every guest page reaches the other two. */}
                    {nav.manage && (
                      <span className="welcome-go">
                        <span>Already booked?</span>
                        <Link className="button" href={`/t/${slug}/manage`}>
                          <Icon name="search" size={16} /> Manage your booking
                        </Link>
                      </span>
                    )}
                  </div>
                )}
              </div>
            </section>
          )}

          <div id="turns">
            {turns.map((turn) => {
              if (turn.kind === 'user') {
                return (
                  <div className="turn user" key={turn.id}>
                    <div className="bubble">{turn.text}</div>
                  </div>
                );
              }

              if (turn.kind === 'pending') {
                return (
                  <div className="turn assistant" key={turn.id}>
                    <AssistantMark name={assistantName} logoUrl={markUrl} />
                    <div className="assistant-body">
                      <div className="speaker">{assistantName}</div>
                      <Thinking />
                    </div>
                  </div>
                );
              }

              if (turn.kind === 'failed') {
                return (
                  <div className="turn assistant" key={turn.id}>
                    <AssistantMark name={assistantName} logoUrl={markUrl} />
                    <div className="assistant-body">
                      <div className="speaker">{assistantName}</div>
                      <div className="turn-error" role="alert">
                        <Icon name="alert" size={16} />
                        <span>{turn.message}</span>
                        <button type="button" className="sm" onClick={() => retry(turn.id, turn.question)}>
                          Retry
                        </button>
                      </div>
                    </div>
                  </div>
                );
              }

              return (
                <div className="turn assistant" key={turn.id}>
                  <AssistantMark name={assistantName} logoUrl={markUrl} />
                  <div className="assistant-body">
                    <div className="speaker">{assistantName}</div>
                    {turn.text === '' && !turn.error ? (
                      <Thinking />
                    ) : (
                      <div className="bubble">
                        <ReplyText text={turn.text} cards={turn.roomCards} view={turn.roomCardsView} />
                      </div>
                    )}
                    <SourcesPanel
                      sources={turn.sources}
                      toolCalls={turn.toolCalls}
                      searchQuery={turn.searchQuery}
                      question={turn.question}
                    />
                    {turn.error && (
                      <div className="turn-error" role="alert">
                        <Icon name="alert" size={16} />
                        <span>{turn.error}</span>
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </main>

      {/* A named region, so the composer is inside a landmark like the rest of the page. */}
      <section className="composer" aria-label="Ask a question">
        {unseen && (
          <button type="button" className="sm jump-down" onClick={jumpDown}>
            <Icon name="chevron-down" size={16} /> New messages
          </button>
        )}
        {voiceOn && <VoiceStatus state={voice.state} seconds={voice.seconds} message={voice.message} onStop={voice.stopSpeaking} />}
        <form
          className="composer-inner"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <label htmlFor="input" className="visually-hidden">
            Your question for {assistantName}
          </label>
          {/* A textarea rather than an input so Shift+Enter can insert a
              newline while Enter alone sends (screens.md § S-1). It stays
              enabled while an answer streams: the next question can be
              typed, and submit() refuses to SEND while busy. */}
          <textarea
            id="input"
            ref={inputRef}
            rows={1}
            placeholder="Ask a question…"
            autoFocus
            value={input}
            onChange={(event) => {
              setInput(event.target.value);
              // Grow with the content, up to the max-height in the stylesheet.
              const el = event.target;
              el.style.height = 'auto';
              el.style.height = `${el.scrollHeight}px`;
            }}
            onKeyDown={(event) => {
              // Enter sends; Shift+Enter inserts a newline.
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                submit();
              }
            }}
          />
          {voiceOn && (
            <MicButton
              state={voice.state}
              seconds={voice.seconds}
              disabled={busy}
              onStart={() => void startListening()}
              onFinish={voice.finish}
            />
          )}
          <button className="primary composer-send" type="submit" aria-label="Send" disabled={busy || input.trim() === ''}>
            <Icon name="arrow-up" size={18} />
          </button>
        </form>
        {/* The fine print under the field, its edges on the field's text: the
            notice, the links to the other pages, and (on a desktop) the keys
            and the Read aloud toggle. One grid (chat.css): on a desktop the
            notice and the links stack on the left with the keys on the right;
            on a phone the notice takes the whole width and the links share
            the last row with the toggle, so the notice is never squeezed into
            a narrow column beside it (the 2026-10-21 phone shot: eight lines). */}
        <div className="composer-foot">
          {/* D-129: what happens to what is typed here, at the moment it is typed. Page text, not prompt text. */}
          <p className="composer-notice">
            {assistantName} is an AI assistant. Chats are saved, read by {businessName}&apos;s staff and processed by
            OpenAI{voiceOn ? '; what you say is sent to OpenAI to be turned into text, and the recording is not kept' : ''}. Don&apos;t share passwords or card numbers.
          </p>
          {/* D-136: the other guest pages stay one click away once the welcome has gone;
              D-129: Privacy and Terms. The separators are CSS, so the links can wrap as a row. */}
          <nav className="composer-links" aria-label="More">
            {nav.book && <Link href={`/t/${slug}/book`}>Book a stay</Link>}
            {nav.manage && <Link href={`/t/${slug}/manage`}>Manage booking</Link>}
            <Link href={`/t/${slug}/privacy`}>Privacy</Link>
            <Link href={`/t/${slug}/terms`}>Terms</Link>
          </nav>
          <div className="composer-side">
            <p className="composer-hint">
              <kbd>Enter</kbd> to send · <kbd>Shift</kbd>+<kbd>Enter</kbd> new line
            </p>
            {voiceOn && <ReadAloudToggle on={voice.readAloud} onChange={voice.setReadAloud} />}
          </div>
        </div>
      </section>
    </div>
  );
}
