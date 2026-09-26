'use client';

// S-2 · Knowledge base. Add, inspect, edit and delete the documents the bot knows.
//
// Ported from public/admin.html + public/admin.js. Same rules as the chat page.
//
// TENANCY (Phases 6-7): rendered by app/t/[tenant]/admin/page.tsx with the
// tenant resolved on the server. Every route this screen calls is admin-only,
// so it starts by asking whether this browser holds a session for THIS tenant.
// If not, it shows a login form. A 401 at any later point, such as an expired
// session, drops back to that form instead of showing an error per row.

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
// The chunker the SERVER uses, imported straight into the browser.
//
// In the POC this worked because server.js served src/chunker.js as a static
// file and the module had no imports — a real constraint, held up by a comment.
// Here it is an ordinary workspace import, and CHUNK_SIZE still exists in
// exactly one place. The static-serve route is gone; the discipline that made
// it possible (pure, no I/O, no dependencies) is kept anyway, because it is
// what makes the file readable on its own.
//
// ⚠️ The chunk COUNT is genuinely an estimate. Since D-018 chunks stop at the
// last paragraph that fits rather than filling to exactly CHUNK_SIZE, so the
// real number depends on where the paragraph breaks fall — which
// estimateChunkCount cannot know from a length alone. Measured, it errs in both
// directions. The UI says "≈" for that reason; do not present it as exact.
import { CHUNK_OVERLAP, CHUNK_SIZE, estimateChunkCount } from '@rag/chunker';
import type { ChunkSummary, DocumentDetail, DocumentSummary } from '@rag/pipeline';
import { MAX_CONTENT_LENGTH } from '@/lib/limits';
import { BrandHeader } from '@/components/brand-header';
import { LoginForm, describeFailure } from '@/components/admin-login';

/** What the server resolved about the tenant. No ids, no admin hash. */
export interface AdminScreenProps {
  slug: string;
  businessName: string;
  logoUrl: string | null;
  bannerUrl: string | null;
  /** Show the link to the bookings screen. Decided on the server, from tenant_applications. */
  bookingsEnabled: boolean;
}

type Auth = 'checking' | 'out' | 'in';

type Notice = { message: string; kind: 'ok' | 'error' } | null;


/**
 * One document row, with its chunks revealed on click.
 *
 * Expanding is lazy: the chunks are only fetched the first time you ask.
 */
function DocumentRow({
  api,
  doc,
  onChanged,
  onError,
  onClearNotice,
  onUnauthorized,
  onEdit,
  editing,
}: {
  api: string;
  doc: DocumentSummary;
  onChanged: () => void;
  /** Load this document into the form above. */
  onEdit: (doc: DocumentSummary) => void;
  /** This row is the one in the form: deleting it mid-edit would make Save a 404. */
  editing: boolean;
  onUnauthorized: () => void;
  onError: (message: string) => void;
  onClearNotice: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [chunks, setChunks] = useState<ChunkSummary[] | null>(null);
  const [chunksMessage, setChunksMessage] = useState('Loading chunks…');
  const [deleting, setDeleting] = useState(false);

  const toggle = useCallback(async () => {
    const next = !open;
    setOpen(next);
    if (!next || chunks !== null) return;

    let response: Response | null = null;
    try {
      response = await fetch(`${api}/documents/${doc.id}/chunks`);
      if (response.status === 401) return onUnauthorized();
      if (!response.ok) throw new Error('failed');
      setChunks(await response.json());
    } catch (error) {
      setChunksMessage(await describeFailure(error as Error, response));
    }
  }, [api, chunks, doc.id, onUnauthorized, open]);

  const remove = useCallback(async () => {
    if (!confirm(`Delete "${doc.title}" and all ${doc.chunkCount} of its chunks?`)) return;
    setDeleting(true);
    let response: Response | null = null;
    try {
      response = await fetch(`${api}/documents/${doc.id}`, { method: 'DELETE' });
      if (response.status === 401) return onUnauthorized();
      if (!response.ok) throw new Error('failed');
      onClearNotice();
      onChanged();
    } catch (error) {
      setDeleting(false);
      onError(`Could not delete: ${await describeFailure(error as Error, response)}`);
    }
  }, [api, doc.chunkCount, doc.id, doc.title, onChanged, onClearNotice, onError, onUnauthorized]);

  return (
    <div className="doc">
      <div className="doc-head">
        <span className="doc-title" title="Click to show the chunks" onClick={toggle}>
          {doc.title}
        </span>
        <span className="doc-meta">
          {doc.chunkCount === 0 ? (
            // The R-7 orphan: a document that exists but can never be
            // retrieved. Ingest cleans up after itself now, so this should
            // never appear — but a symptom you can see beats one you cannot.
            <span className="warn">⚠ 0 chunks</span>
          ) : (
            `${doc.chunkCount} chunk${doc.chunkCount === 1 ? '' : 's'}`
          )}
          {` · ${new Date(doc.created_at).toLocaleDateString()}`}
        </span>
        <button type="button" title="Edit this document" disabled={deleting || editing} onClick={() => onEdit(doc)}>
          ✎
        </button>
        <button type="button" title="Delete this document" disabled={deleting || editing} onClick={remove}>
          🗑
        </button>
      </div>

      <div className={`doc-chunks${open ? '' : ' hidden'}`}>
        {chunks === null ? (
          chunksMessage
        ) : (
          <>
            {chunks.map((chunk) => (
              <div className="chunk" key={chunk.id}>
                <div className="chunk-label">
                  chunk {chunk.chunk_index} · {chunk.content.length} characters
                </div>
                <pre className="chunk-text">{chunk.content}</pre>
              </div>
            ))}
            {/* Carefully worded: since D-018 the overlap is NOT always present.
                When the carried tail plus the next paragraph would exceed
                CHUNK_SIZE the tail is dropped, which happens on every boundary
                once paragraphs get large. Claiming the repetition is always
                there would have people reading their own chunks, seeing none of
                it, and concluding the feature is broken. */}
            {chunks.length > 1 && (
              <p className="small muted">
                Chunks end at paragraph boundaries. Where one chunk begins by repeating the end of
                the previous one, that is the {CHUNK_OVERLAP}-character overlap — it is skipped when
                a paragraph needs the whole chunk to itself.
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}


export function AdminScreen({ slug, businessName, logoUrl, bannerUrl, bookingsEnabled }: AdminScreenProps) {
  const api = `/api/t/${slug}`;
  const [auth, setAuth] = useState<Auth>('checking');
  const [documents, setDocuments] = useState<DocumentSummary[] | null>(null);
  const [listMessage, setListMessage] = useState('Loading documents…');
  const [notice, setNotice] = useState<Notice>(null);
  const [title, setTitle] = useState('');
  const [source, setSource] = useState('');
  const [content, setContent] = useState('');
  const [submitting, setSubmitting] = useState(false);
  // The document the form is editing, or null when it is adding a new one.
  const [editing, setEditing] = useState<{ id: number; title: string } | null>(null);

  // Any 401 means the session is gone (expired, logged out elsewhere, or the
  // secret was rotated). Back to the login form, with nothing left on screen.
  const unauthorized = useCallback(() => {
    setAuth('out');
    setDocuments(null);
    setEditing(null);
  }, []);

  // First: does this browser hold a session for THIS tenant?
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

  const loadDocuments = useCallback(async () => {
    let response: Response | null = null;
    try {
      response = await fetch(`${api}/documents`);
      if (response.status === 401) return unauthorized();
      if (!response.ok) throw new Error('failed');
      setDocuments(await response.json());
    } catch (error) {
      setDocuments(null);
      setListMessage(await describeFailure(error as Error, response));
    }
  }, [api, unauthorized]);

  useEffect(() => {
    if (auth === 'in') void loadDocuments();
  }, [auth, loadDocuments]);

  const logout = useCallback(async () => {
    await fetch(`${api}/admin/session`, { method: 'DELETE' }).catch(() => undefined);
    unauthorized();
  }, [api, unauthorized]);

  const clearForm = useCallback(() => {
    setEditing(null);
    setTitle('');
    setSource('');
    setContent('');
  }, []);

  // Edit: fetch the document's full original text (the list carries none of
  // it) and load it into the same form that adds documents.
  const startEdit = useCallback(
    async (doc: DocumentSummary) => {
      setNotice(null);
      let response: Response | null = null;
      try {
        response = await fetch(`${api}/documents/${doc.id}`);
        if (response.status === 401) return unauthorized();
        if (!response.ok) throw new Error('failed');
        const detail: DocumentDetail = await response.json();
        setEditing({ id: detail.id, title: detail.title });
        setTitle(detail.title);
        setSource(detail.source ?? '');
        setContent(detail.content);
        window.scrollTo({ top: 0, behavior: 'smooth' });
      } catch (error) {
        setNotice({ message: `Could not open: ${await describeFailure(error as Error, response)}`, kind: 'error' });
      }
    },
    [api, unauthorized],
  );

  const submit = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();
      setNotice(null);

      const trimmedTitle = title.trim();
      const trimmedContent = content.trim();

      // Client-side validation as well as server-side. The server is the one
      // that matters; this just avoids a pointless round trip.
      if (trimmedTitle === '') return setNotice({ message: 'A title is required.', kind: 'error' });
      if (trimmedContent === '')
        return setNotice({ message: 'Document content is required.', kind: 'error' });
      if (trimmedContent.length > MAX_CONTENT_LENGTH) {
        return setNotice({
          message:
            `Document is ${trimmedContent.length.toLocaleString()} characters; the limit is ` +
            `${MAX_CONTENT_LENGTH.toLocaleString()}.`,
          kind: 'error',
        });
      }

      setSubmitting(true);
      let response: Response | null = null;
      try {
        // Editing is a PUT to the document; the server re-chunks and re-embeds
        // it, then removes the old version. Adding is a POST, as before.
        response = await fetch(editing ? `${api}/documents/${editing.id}` : `${api}/documents`, {
          method: editing ? 'PUT' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: trimmedTitle, source: source.trim(), content: trimmedContent }),
        });
        if (response.status === 401) return unauthorized();
        if (!response.ok) throw new Error('failed');
        const result = await response.json();

        setNotice({
          message: `${editing ? 'Updated' : 'Added'} “${result.title}” — ${result.chunkCount} chunk${
            result.chunkCount === 1 ? '' : 's'
          } embedded.`,
          kind: 'ok',
        });
        clearForm();
        void loadDocuments();
      } catch (error) {
        setNotice({
          message: `Embedding failed: ${await describeFailure(error as Error, response)}`,
          kind: 'error',
        });
      } finally {
        setSubmitting(false);
      }
    },
    [api, clearForm, content, editing, loadDocuments, source, title, unauthorized],
  );

  const length = content.trim().length;
  const chunkCount = estimateChunkCount(length);

  const header = (
    <BrandHeader
      businessName={businessName}
      logoUrl={logoUrl}
      bannerUrl={bannerUrl}
      subtitle="Knowledge base"
    >
      {auth === 'in' && (
        <button type="button" className="link" onClick={logout}>
          Log out
        </button>
      )}
      <Link className="button" href={`/t/${slug}/admin/unanswered`}>
        Unanswered
      </Link>
      {bookingsEnabled && (
        <Link className="button" href={`/t/${slug}/admin/bookings`}>
          Bookings
        </Link>
      )}
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
        <div className={notice ? `notice ${notice.kind}` : 'notice hidden'}>{notice?.message}</div>

        <section className="card">
          <h2>{editing ? `Edit “${editing.title}”` : 'Add a document'}</h2>
          <form onSubmit={submit}>
            <div className="field">
              <label htmlFor="title">Title</label>
              <input
                type="text"
                id="title"
                required
                placeholder="Returns Policy"
                value={title}
                onChange={(event) => setTitle(event.target.value)}
              />
            </div>

            <div className="field">
              <label htmlFor="source">
                Source <span className="muted">(optional)</span>
              </label>
              <input
                type="text"
                id="source"
                placeholder="handbook p.12"
                value={source}
                onChange={(event) => setSource(event.target.value)}
              />
            </div>

            <div className="field">
              <label htmlFor="content">Content</label>
              <textarea
                id="content"
                required
                placeholder="Paste the document text here…"
                value={content}
                onChange={(event) => setContent(event.target.value)}
              />
            </div>

            <div className="form-footer">
              {/* Updated live using the SAME chunker the server runs, so you can
                  see how your text will be split before committing. */}
              <span
                className="estimate"
                style={length > MAX_CONTENT_LENGTH ? { color: 'var(--danger)' } : undefined}
              >
                {length.toLocaleString()} characters · ≈ {chunkCount} chunk
                {chunkCount === 1 ? '' : 's'} ({CHUNK_SIZE} chars, {CHUNK_OVERLAP} overlap)
              </span>
              {editing && (
                <button type="button" disabled={submitting} onClick={clearForm}>
                  Cancel
                </button>
              )}
              <button type="submit" className="primary" disabled={submitting}>
                {/* Genuinely slow for a long document: the OpenAI embeddings
                    call is synchronous and there is no background job (mvp.md). */}
                {submitting
                  ? 'Embedding… (this may take a few seconds)'
                  : editing
                    ? 'Save changes'
                    : 'Add to knowledge base'}
              </button>
            </div>
          </form>
        </section>

        <section className="card">
          <h2>Documents{documents ? ` (${documents.length})` : ''}</h2>

          {documents === null ? (
            <div className="small">{listMessage}</div>
          ) : documents.length === 0 ? (
            <div className="small muted">
              No documents yet. Paste something above to give the bot something to know.
            </div>
          ) : (
            <div>
              {documents.map((doc) => (
                <DocumentRow
                  key={doc.id}
                  api={api}
                  doc={doc}
                  onUnauthorized={unauthorized}
                  onChanged={loadDocuments}
                  onEdit={startEdit}
                  editing={editing?.id === doc.id}
                  onClearNotice={() => setNotice(null)}
                  onError={(message) => setNotice({ message, kind: 'error' })}
                />
              ))}
            </div>
          )}
        </section>
      </main>
    </>
  );
}
