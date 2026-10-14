'use client';

// The platform tenant form's Knowledge base tab (D-128): a super user lists,
// adds and deletes a tenant's documents, so a tenant can be one where only
// the platform adds them (its owner and admin left with documents:read on
// the Permissions tab). The same ingest as the tenant's own screen: the
// text is chunked and embedded on the server, and the list shows each
// document's chunk count. A text or Markdown file is read here, in the
// browser, into the text box; nothing else is uploaded.

import { useCallback, useEffect, useState } from 'react';
import { describeFailure } from '@/components/admin-login';
import { useConfirmDialog } from '@/components/dialogs';
import { Icon } from '@/components/icons';
import { EmptyState, LOADING, LoadState, failed, type Load } from '@/components/load-state';
import { MAX_CONTENT_LENGTH } from '@/lib/limits';

interface DocumentRow {
  id: number;
  title: string;
  source: string | null;
  created_at: string;
  chunkCount: number;
}

export function KnowledgePanel({
  api,
  tenantName,
  onMessage,
  onUnauthorized,
}: {
  /** /api/platform/tenants/<id>/documents */
  api: string;
  tenantName: string;
  onMessage: (message: string, kind: 'ok' | 'error') => void;
  onUnauthorized: () => void;
}) {
  const [docs, setDocs] = useState<DocumentRow[] | Load>(LOADING);
  const [title, setTitle] = useState('');
  const [source, setSource] = useState('');
  const [content, setContent] = useState('');
  const [busy, setBusy] = useState(false);
  const { ask, dialog } = useConfirmDialog();

  const load = useCallback(async () => {
    setDocs(LOADING);
    let response: Response | null = null;
    try {
      response = await fetch(api);
      if (response.status === 401) return onUnauthorized();
      if (!response.ok) throw new Error('failed');
      setDocs(await response.json());
    } catch (error) {
      setDocs(failed(await describeFailure(error as Error, response)));
    }
  }, [api, onUnauthorized]);
  useEffect(() => void load(), [load]);

  async function add(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    let response: Response | null = null;
    try {
      response = await fetch(api, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: title.trim(), source: source.trim() || undefined, content }),
      });
      if (response.status === 401) return onUnauthorized();
      if (!response.ok) throw new Error('failed');
      const added: { chunkCount?: number } = await response.json();
      onMessage(`Added "${title.trim()}"${typeof added.chunkCount === 'number' ? `: ${added.chunkCount} chunks` : ''}.`, 'ok');
      setTitle('');
      setSource('');
      setContent('');
      void load();
    } catch (error) {
      onMessage(await describeFailure(error as Error, response), 'error');
    } finally {
      setBusy(false);
    }
  }

  async function remove(doc: DocumentRow) {
    const sure = await ask({
      title: `Delete "${doc.title}"?`,
      body: `The assistant of ${tenantName} stops knowing what it says at once. This cannot be undone.`,
      actionLabel: 'Delete',
      danger: true,
    });
    if (sure === null) return;
    setBusy(true);
    let response: Response | null = null;
    try {
      response = await fetch(`${api}/${doc.id}`, { method: 'DELETE' });
      if (response.status === 401) return onUnauthorized();
      if (!response.ok) throw new Error('failed');
      onMessage(`Deleted "${doc.title}".`, 'ok');
      void load();
    } catch (error) {
      onMessage(await describeFailure(error as Error, response), 'error');
    } finally {
      setBusy(false);
    }
  }

  async function readFile(file: File | undefined) {
    if (!file) return;
    if (file.size > MAX_CONTENT_LENGTH * 4) return onMessage('That file is too large to be one document.', 'error');
    const text = await file.text();
    setContent(text);
    if (!title.trim()) setTitle(file.name.replace(/\.(txt|md|markdown)$/i, ''));
    if (!source.trim()) setSource(file.name);
  }

  return (
    <div className="card settings">
      {dialog}
      <section className="settings-section" aria-labelledby="kb-list">
        <div className="settings-about">
          <h2 id="kb-list">Documents</h2>
          <p>What the assistant answers from. To make the platform the only one who adds them, untick &ldquo;Add, edit and delete documents&rdquo; for every role on the Permissions tab.</p>
        </div>
        <div>
          {!Array.isArray(docs) ? (
            <LoadState load={docs} onRetry={() => void load()} what="documents" />
          ) : docs.length === 0 ? (
            <EmptyState icon="file" title="No documents yet" compact>
              Until one is added, the chat says it is still being set up.
            </EmptyState>
          ) : (
            <ul className="kb-list">
              {docs.map((d) => (
                <li key={d.id}>
                  <Icon name="file" size={16} />
                  <span className="kb-title">
                    {d.title}
                    <span className="small muted">
                      {' '}
                      · {d.chunkCount} chunk{d.chunkCount === 1 ? '' : 's'}
                      {d.source ? ` · ${d.source}` : ''}
                    </span>
                  </span>
                  <button type="button" className="ghost sm kb-delete" disabled={busy} onClick={() => void remove(d)} aria-label={`Delete ${d.title}`}>
                    <Icon name="trash" size={14} /> Delete
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
      <form className="settings-section" aria-labelledby="kb-add" onSubmit={(e) => void add(e)}>
        <div className="settings-about">
          <h2 id="kb-add">Add a document</h2>
          <p>Paste the text, or read a .txt or .md file into the box. It is chunked and embedded when you add it.</p>
        </div>
        <div className="settings-fields">
          <div className="field-row">
            <div className="field grow">
              <label htmlFor="kb-title">Title</label>
              <input id="kb-title" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} required autoComplete="off" />
            </div>
            <div className="field grow">
              <label htmlFor="kb-source">
                Source <span className="muted">(optional)</span>
              </label>
              <input id="kb-source" value={source} onChange={(e) => setSource(e.target.value)} maxLength={500} autoComplete="off" placeholder="a file name, a link or a note" />
            </div>
          </div>
          <div className="field">
            <label htmlFor="kb-content">Text</label>
            <textarea id="kb-content" rows={10} value={content} onChange={(e) => setContent(e.target.value)} maxLength={MAX_CONTENT_LENGTH} required />
            <p className="hint">
              {content.length.toLocaleString('en-GB')} of {MAX_CONTENT_LENGTH.toLocaleString('en-GB')} characters.
            </p>
          </div>
          <div className="form-footer kb-actions">
            <label className="brand-upload">
              <input type="file" accept=".txt,.md,.markdown,text/plain,text/markdown" className="visually-hidden" onChange={(e) => void readFile(e.target.files?.[0])} disabled={busy} />
              <span className="button sm">
                <Icon name="file" size={14} /> Read a file
              </span>
            </label>
            <button type="submit" className="primary" disabled={busy || !title.trim() || !content.trim()} aria-busy={busy || undefined}>
              {busy ? 'Adding…' : 'Add document'}
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}
