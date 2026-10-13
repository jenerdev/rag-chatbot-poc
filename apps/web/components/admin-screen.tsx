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
//
// The look (plan/ui-refresh.md Phase 8): "Add a document" is the page's
// action and opens the form in a side drawer; Edit opens the same drawer
// with the document loaded. Closing the drawer abandons an edit but keeps a
// new document's draft. Delete asks in a dialog that names the document.

import Link from 'next/link';
import { useCallback, useDeferredValue, useEffect, useMemo, useState } from 'react';
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
import { CHUNK_OVERLAP, CHUNK_SIZE, chunkText, estimateChunkCount } from '@rag/chunker';
import type { ChunkSummary, DocumentDetail, DocumentSummary } from '@rag/pipeline';
import { MAX_CONTENT_LENGTH } from '@/lib/limits';
import { LoginForm, describeFailure } from '@/components/admin-login';
import { fetchRole } from '@/components/tenant-nav';
import { StaffFrame } from '@/components/staff-frame';
import type { NavFeatures } from '@/lib/nav-items';
import { ROLE_LABELS, can, isRole, type Role } from '@/lib/permissions';
import { Drawer, useConfirmDialog, type Question } from '@/components/dialogs';
import { useNotice } from '@/components/toast';
import { Icon } from '@/components/icons';
import { Tip } from '@/components/tooltip';
import { EmptyState, LOADING, LoadState, failed, type Load } from '@/components/load-state';
import { ListSearch } from '@/components/list-search';
import { matches } from '@/lib/search';

/** What the server resolved about the tenant. No ids, no admin hash. */
export interface AdminScreenProps {
  slug: string;
  businessName: string;
  logoUrl: string | null;
  /** What the tenant has, for the header's links (lib/nav.ts). */
  nav: NavFeatures;
}

type Auth = 'checking' | 'out' | 'in';

/** Past this many documents the list gets a search on titles; at or under it, one look is enough. */
const SEARCH_FROM = 8;

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
  onDeleted,
  onUnauthorized,
  onEdit,
  editing,
  readOnly,
  ask,
}: {
  api: string;
  doc: DocumentSummary;
  onChanged: () => void;
  /** Load this document into the form above. */
  onEdit: (doc: DocumentSummary) => void;
  /** This row is the one in the form: deleting it mid-edit would make Save a 404. */
  editing: boolean;
  /** The member may read but not write (staff): no Edit, no Delete. The route refuses anyway (403). */
  readOnly: boolean;
  onUnauthorized: () => void;
  onError: (message: string) => void;
  /** Said as a toast: before toasts, a delete said nothing; the row just went. */
  onDeleted: (message: string) => void;
  /** The screen's confirmation dialog (components/dialogs.tsx). */
  ask: (question: Question) => Promise<string | null>;
}) {
  const [open, setOpen] = useState(false);
  const [chunks, setChunks] = useState<ChunkSummary[] | null>(null);
  const [chunksLoad, setChunksLoad] = useState<Load>(LOADING);
  const [deleting, setDeleting] = useState(false);

  // Its own function, so Retry runs it again (plan/ui-components.md Phase 2).
  const loadChunks = useCallback(async () => {
    let response: Response | null = null;
    try {
      response = await fetch(`${api}/documents/${doc.id}/chunks`);
      if (response.status === 401) return onUnauthorized();
      if (!response.ok) throw new Error('failed');
      setChunks(await response.json());
    } catch (error) {
      setChunksLoad(failed(await describeFailure(error as Error, response)));
    }
  }, [api, doc.id, onUnauthorized]);

  const toggle = useCallback(async () => {
    const next = !open;
    setOpen(next);
    if (next && chunks === null) await loadChunks();
  }, [chunks, loadChunks, open]);

  const remove = useCallback(async () => {
    const sure = await ask({
      title: `Delete “${doc.title}”?`,
      body: `Its ${doc.chunkCount} chunk${doc.chunkCount === 1 ? '' : 's'} go with it, and the assistant stops answering from it. This cannot be undone.`,
      actionLabel: 'Delete',
      backLabel: 'Keep it',
      danger: true,
    });
    if (sure === null) return;
    setDeleting(true);
    let response: Response | null = null;
    try {
      response = await fetch(`${api}/documents/${doc.id}`, { method: 'DELETE' });
      if (response.status === 401) return onUnauthorized();
      if (!response.ok) throw new Error('failed');
      onDeleted(`Deleted “${doc.title}” and its ${doc.chunkCount} chunk${doc.chunkCount === 1 ? '' : 's'}.`);
      onChanged();
    } catch (error) {
      setDeleting(false);
      onError(`Could not delete: ${await describeFailure(error as Error, response)}`);
    }
  }, [api, ask, doc.chunkCount, doc.id, doc.title, onChanged, onDeleted, onError, onUnauthorized]);

  return (
    <div className="doc">
      <div className="doc-head">
        {/* A button, so the keyboard opens the chunks too. */}
        <button type="button" className="doc-title" aria-expanded={open} onClick={toggle}>
          <Icon name="chevron-right" size={16} className="doc-chevron" />
          <span>{doc.title}</span>
        </button>
        <span className="doc-meta">
          {doc.chunkCount === 0 ? (
            // The R-7 orphan: a document that exists but can never be
            // retrieved. Ingest cleans up after itself now, so this should
            // never appear — but a symptom you can see beats one you cannot.
            <span className="badge danger">
              <Icon name="alert" size={12} /> 0 chunks
            </span>
          ) : (
            `${doc.chunkCount} chunk${doc.chunkCount === 1 ? '' : 's'}`
          )}
          {` · ${new Date(doc.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}`}
        </span>
        {!readOnly && (
          <>
            <Tip label="Edit">
              <button type="button" className="ghost sm" aria-label={`Edit ${doc.title}`} disabled={deleting || editing} onClick={() => onEdit(doc)}>
                <Icon name="edit" size={16} />
              </button>
            </Tip>
            <Tip label="Delete">
              <button type="button" className="ghost sm danger" aria-label={`Delete ${doc.title}`} disabled={deleting || editing} onClick={remove}>
                <Icon name="trash" size={16} />
              </button>
            </Tip>
          </>
        )}
      </div>

      <div className={`doc-chunks${open ? '' : ' hidden'}`}>
        {chunks === null ? (
          <LoadState load={chunksLoad} what="chunks" rows={2} onRetry={() => { setChunksLoad(LOADING); void loadChunks(); }} />
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


export function AdminScreen({ slug, businessName, logoUrl, nav }: AdminScreenProps) {
  const api = `/api/t/${slug}`;
  const [auth, setAuth] = useState<Auth>('checking');
  // What this member is (tenant management Phase 3). Staff reads the knowledge
  // base and gets no form and no Edit or Delete; the routes refuse a staff
  // write with a 403 whatever the screen shows (lib/permissions.ts).
  const [role, setRole] = useState<Role | null>(null);
  const canWrite = role !== null && can(role, 'documents:write');
  const [documents, setDocuments] = useState<DocumentSummary[] | null>(null);
  const [loadState, setLoadState] = useState<Load>(LOADING);
  const [title, setTitle] = useState('');
  const [source, setSource] = useState('');
  const [content, setContent] = useState('');
  const [submitting, setSubmitting] = useState(false);
  // The document the form is editing, or null when it is adding a new one.
  const [editing, setEditing] = useState<{ id: number; title: string } | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [query, setQuery] = useState('');
  // How many questions the documents could not answer (S-4's open list), for
  // the callout that sends staff there. null until read, or when unreadable.
  const [openQuestions, setOpenQuestions] = useState<number | null>(null);
  const { notice, setNotice } = useNotice(formOpen);
  const { ask, dialog } = useConfirmDialog();

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
        setRole(isRole(body.role) ? body.role : null);
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
      setLoadState(failed(await describeFailure(error as Error, response)));
    }
  }, [api, unauthorized]);

  useEffect(() => {
    if (auth === 'in') void loadDocuments();
  }, [auth, loadDocuments]);

  // The open questions, counted for the callout. A failure only hides it.
  useEffect(() => {
    if (auth !== 'in') return;
    void fetch(`${api}/unanswered`)
      .then((r) => (r.ok ? r.json() : null))
      .then((rows: unknown[] | null) => setOpenQuestions(Array.isArray(rows) ? rows.length : null))
      .catch(() => setOpenQuestions(null));
  }, [api, auth]);

  // ?question=… (Unanswered's "Add answer"): the form opens with the question
  // as the title and a question-and-answer start, for a member who may write.
  // The address is cleaned so a reload does not open it again.
  useEffect(() => {
    if (auth !== 'in' || role === null || !can(role, 'documents:write')) return;
    const params = new URLSearchParams(window.location.search);
    const question = params.get('question')?.trim();
    if (!question) return;
    setEditing(null);
    setTitle(question.slice(0, 200));
    setSource('Unanswered question');
    setContent(`Question: ${question}\nAnswer: `);
    setFormOpen(true);
    params.delete('question');
    window.history.replaceState(null, '', `${window.location.pathname}${params.size ? `?${params}` : ''}`);
  }, [auth, role]);

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
        setFormOpen(true);
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
        setFormOpen(false);
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

  const shownDocuments = documents?.filter((doc) => matches(doc.title, query)) ?? [];
  const length = content.trim().length;
  const chunkCount = estimateChunkCount(length);
  // The split preview: the SAME chunkText() the server runs (@rag/chunker
  // has no I/O, so the browser runs it too), computed only while the preview
  // is open, on a deferred copy of the text so typing never waits for it.
  const [previewOpen, setPreviewOpen] = useState(false);
  const deferredContent = useDeferredValue(content);
  const previewChunks = useMemo(
    () => (previewOpen && deferredContent.trim() !== '' && deferredContent.trim().length <= MAX_CONTENT_LENGTH ? chunkText(deferredContent.trim()) : []),
    [deferredContent, previewOpen],
  );
  // What the Add button still needs, in words; null when it is ready.
  const formMissing =
    title.trim() === ''
      ? 'Add a title'
      : length === 0
        ? 'Add the content'
        : length > MAX_CONTENT_LENGTH
          ? `${(length - MAX_CONTENT_LENGTH).toLocaleString()} characters over the limit`
          : null;

  // "Load a text file": a .txt or .md file's text into Content (and its name
  // into an empty Title), read in this browser; nothing is uploaded.
  const loadFile = useCallback(async (file: File | undefined) => {
    if (!file) return;
    if (!/\.(txt|md|markdown)$/i.test(file.name) && !file.type.startsWith('text/')) {
      setNotice({ message: 'Choose a plain text file (.txt or .md). For a PDF or Word file, copy its text and paste it.', kind: 'error' });
      return;
    }
    const text = await file.text();
    setContent(text);
    setTitle((current) => (current.trim() === '' ? file.name.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ') : current));
    setSource((current) => (current.trim() === '' ? file.name : current));
  }, [setNotice]);

  const frame = { slug, businessName, logoUrl, features: nav, current: 'documents' as const, title: 'Knowledge base', session: { auth, role, onLogout: logout } };
  // Closing abandons an edit (the row must not stay "being edited"), but a
  // new document's draft is kept for when the drawer opens again.
  const closeForm = () => {
    setFormOpen(false);
    if (editing) clearForm();
  };
  const addDocument = canWrite ? (
    <button
      type="button"
      className="primary"
      onClick={() => {
        if (editing) clearForm();
        setNotice(null);
        setFormOpen(true);
      }}
    >
      <Icon name="plus" size={16} /> Add a document
    </button>
  ) : undefined;

  if (auth !== 'in') {
    return (
      <>
        <StaffFrame {...frame}>
          {auth === 'checking' ? (
            <div className="small muted">Checking your session…</div>
          ) : (
            <LoginForm
              api={api}
              slug={slug}
              onLoggedIn={() => {
                setAuth('in');
                // The login route says only "admin: true"; the role is the session GET's.
                void fetchRole(api).then(setRole);
              }}
            />
          )}
        </StaffFrame>
      </>
    );
  }

  return (
    <>
      <StaffFrame {...frame} actions={addDocument}>
        {dialog}

        {!canWrite && role && (
          <section className="card">
            <p className="small muted">
              You are {ROLE_LABELS[role].toLowerCase()} here: you can read the knowledge base and see what each answer was
              built from. Adding or editing documents is for an admin or owner.
            </p>
          </section>
        )}

        {canWrite && (
        <Drawer open={formOpen} title={editing ? `Edit “${editing.title}”` : 'Add a document'} onClose={closeForm}>
          <form onSubmit={submit} className="doc-form">
            <p className="small muted doc-form-intro">
              The assistant answers only from what is written here. One topic per document, in plain sentences, works best.
            </p>

            <div className="field">
              <label htmlFor="title">Title</label>
              <input
                type="text"
                id="title"
                required
                autoComplete="off"
                placeholder="Pets and animals"
                value={title}
                onChange={(event) => setTitle(event.target.value)}
              />
              <p className="hint">What it covers. Staff see it in this list and beside each answer built from it.</p>
            </div>

            <div className="field">
              <label htmlFor="source">
                Source <span className="muted">(optional)</span>
              </label>
              <input
                type="text"
                id="source"
                autoComplete="off"
                placeholder="House rules, page 3"
                value={source}
                onChange={(event) => setSource(event.target.value)}
              />
              <p className="hint">Where it came from, for your own reference.</p>
            </div>

            <div className="field">
              <div className="label-row">
                <label htmlFor="content">Content</label>
                {/* A file's text, read here; nothing is uploaded. */}
                <label className="button sm file-pick">
                  <Icon name="file" size={14} /> Load a text file
                  <input
                    type="file"
                    accept=".txt,.md,.markdown,text/plain,text/markdown"
                    className="visually-hidden"
                    onChange={(event) => {
                      void loadFile(event.target.files?.[0]);
                      event.target.value = '';
                    }}
                  />
                </label>
              </div>
              <textarea
                id="content"
                required
                placeholder={'Paste the text here, or load a .txt or .md file.\n\nFor example:\nPets are welcome in the garden rooms, up to two per room, for ₱500 a night each. They are not allowed in the pool area.'}
                value={content}
                aria-describedby="content-estimate"
                aria-invalid={length > MAX_CONTENT_LENGTH || undefined}
                onChange={(event) => setContent(event.target.value)}
              />
              {/* Live, by the SAME chunker the server runs, so the split is seen before it is saved. */}
              <div id="content-estimate" className={length > MAX_CONTENT_LENGTH ? 'content-meter over' : 'content-meter'}>
                <span>
                  {length.toLocaleString()} / {MAX_CONTENT_LENGTH.toLocaleString()} characters
                </span>
                <span>
                  ≈ {chunkCount} chunk{chunkCount === 1 ? '' : 's'}
                </span>
              </div>
            </div>

            {length > 0 && length <= MAX_CONTENT_LENGTH && (
              <details className="doc-disclosure" open={previewOpen} onToggle={(event) => setPreviewOpen((event.target as HTMLDetailsElement).open)}>
                <summary>How it will be split</summary>
                <p className="small muted">
                  The assistant searches these pieces, not the whole document: up to {CHUNK_SIZE} characters each, ending at a paragraph where it can, each
                  repeating up to {CHUNK_OVERLAP} characters of the one before when a paragraph allows.
                </p>
                <ol className="chunk-preview">
                  {previewChunks.map((chunk, i) => (
                    <li key={i}>
                      <span className="small muted">
                        Chunk {i + 1} · {chunk.length} characters
                      </span>
                      <span className="chunk-preview-text">{chunk.length > 220 ? `${chunk.slice(0, 220)}…` : chunk}</span>
                    </li>
                  ))}
                </ol>
              </details>
            )}

            <details className="doc-disclosure">
              <summary>Tips for answers guests get right</summary>
              <ul className="small">
                <li>Use the words guests use: “check-in time”, not only “arrival policy”.</li>
                <li>Give the figure itself: prices, times, distances, limits.</li>
                <li>Say what is not allowed or not offered, too; the assistant can only refuse what is missing.</li>
                <li>Keep one topic per document, so each answer is built from the right one.</li>
              </ul>
            </details>

            {/* A refusal while the drawer is open is said here, above the buttons, not as a toast (useNotice). */}
            {notice?.kind === 'error' && formOpen && (
              <div className="notice error drawer-notice" role="alert">
                {notice.message}
              </div>
            )}

            <div className="drawer-footer">
              <div className="drawer-footer-total">
                <span className="small muted">
                  {submitting ? 'Reading it into the knowledge base… this can take a few seconds.' : (formMissing ?? (editing ? 'Saving replaces the old version.' : 'Ready to add.'))}
                </span>
              </div>
              <button type="button" disabled={submitting} onClick={closeForm}>
                Cancel
              </button>
              <button type="submit" className="primary" aria-busy={submitting || undefined} disabled={submitting || formMissing !== null}>
                {/* Genuinely slow for a long document: the OpenAI embeddings
                    call is synchronous and there is no background job (mvp.md). */}
                {submitting ? 'Saving…' : editing ? 'Save changes' : 'Add to knowledge base'}
              </button>
            </div>
          </form>
        </Drawer>
        )}

        {/* What the documents miss, said where they are written (S-4 is the list). */}
        {openQuestions !== null && openQuestions > 0 && (
          <section className="card callout">
            <Icon name="help" size={18} />
            <p>
              <strong>
                {openQuestions} question{openQuestions === 1 ? '' : 's'} the assistant could not answer.
              </strong>{' '}
              <span className="muted">Add the answers here, then mark them resolved.</span>
            </p>
            <Link className="button sm" href={`/t/${slug}/admin/unanswered`}>
              See the questions
            </Link>
          </section>
        )}

        <section className="card">
          <div className="kb-head">
            <h2>Documents</h2>
            {documents && documents.length > 0 && (
              <span className="small muted">
                {documents.length} document{documents.length === 1 ? '' : 's'} · {documents.reduce((n, d) => n + d.chunkCount, 0)} chunks · newest{' '}
                {new Date(Math.max(...documents.map((d) => Date.parse(d.created_at)))).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}
              </span>
            )}
          </div>
            <p className="small muted kb-intro">The assistant answers only from these. Open one to see the chunks it was split into.</p>

          {documents === null ? (
            <LoadState load={loadState} what="documents" onRetry={() => { setLoadState(LOADING); void loadDocuments(); }} />
          ) : documents.length === 0 ? (
            // addDocument is undefined for staff, who may not add one: no button, the page's own courtesy.
            <EmptyState icon="file" title="No documents yet" action={addDocument}>
              {canWrite ? 'A document gives the assistant something to answer from.' : undefined}
            </EmptyState>
          ) : (
            <div>
              {/* A search only once the list is long enough to need one (plan/ui-components.md Phase 4). */}
              {documents.length > SEARCH_FROM && <ListSearch value={query} onChange={setQuery} label="Search the titles" />}
              {shownDocuments.length === 0 && (
                <EmptyState
                  icon="search"
                  title={`No title matches “${query.trim()}”`}
                  action={
                    <button type="button" onClick={() => setQuery('')}>
                      Clear search
                    </button>
                  }
                  compact
                />
              )}
              {shownDocuments.map((doc) => (
                <DocumentRow
                  key={doc.id}
                  api={api}
                  doc={doc}
                  onUnauthorized={unauthorized}
                  onChanged={loadDocuments}
                  onEdit={startEdit}
                  editing={editing?.id === doc.id}
                  readOnly={!canWrite}
                  ask={ask}
                  onDeleted={(message) => setNotice({ message, kind: 'ok' })}
                  onError={(message) => setNotice({ message, kind: 'error' })}
                />
              ))}
            </div>
          )}
        </section>
      </StaffFrame>
    </>
  );
}
