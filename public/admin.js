// admin.js — the knowledge base page (S-2).
//
// Same two rules as app.js: textContent never innerHTML for server data, and no
// markdown rendering.

// The chunker the SERVER uses, imported straight into the browser.
//
// chunker.js is a pure module with no imports and no I/O, which means the exact
// same file runs in both places. So the estimate below is not an approximation
// of what the server will do — it is the same arithmetic with the same
// constants. Change CHUNK_SIZE in src/chunker.js and this page updates with it.
// That is the practical payoff for keeping that module dependency-free.
import { estimateChunkCount, CHUNK_SIZE, CHUNK_OVERLAP } from './chunker.js';

const MAX_CONTENT_LENGTH = 100_000; // must match server.js

const form = document.getElementById('add-form');
const titleEl = document.getElementById('title');
const sourceEl = document.getElementById('source');
const contentEl = document.getElementById('content');
const estimateEl = document.getElementById('estimate');
const submitEl = document.getElementById('submit');
const noticeEl = document.getElementById('notice');
const docsEl = document.getElementById('docs');
const headingEl = document.getElementById('docs-heading');

// --- notices ----------------------------------------------------------------

function showNotice(message, kind) {
  noticeEl.textContent = message;
  noticeEl.className = `notice ${kind}`;
}

function clearNotice() {
  noticeEl.textContent = '';
  noticeEl.className = 'notice hidden';
}

async function describeFailure(error, response) {
  if (response) {
    try {
      const body = await response.json();
      if (body.error) return body.error;
    } catch {
      // Not JSON — fall through to the status line.
    }
    return `Request failed with HTTP ${response.status}`;
  }
  return `Cannot reach the server. Is \`node server.js\` running? (${error.message})`;
}

// --- the live chunk estimate ------------------------------------------------

function updateEstimate() {
  const length = contentEl.value.trim().length;
  const chunks = estimateChunkCount(length);
  const plural = chunks === 1 ? '' : 's';
  estimateEl.textContent =
    `${length.toLocaleString()} characters · ≈ ${chunks} chunk${plural} ` +
    `(${CHUNK_SIZE} chars, ${CHUNK_OVERLAP} overlap)`;
  estimateEl.style.color = length > MAX_CONTENT_LENGTH ? 'var(--danger)' : '';
}

contentEl.addEventListener('input', updateEstimate);
updateEstimate();

// --- the document list ------------------------------------------------------

/** Fetch a document's chunks and show them under its row. */
async function expandChunks(container, documentId) {
  container.textContent = 'Loading chunks…';
  let response = null;
  try {
    response = await fetch(`/api/documents/${documentId}/chunks`);
    if (!response.ok) throw new Error('failed');
    const chunks = await response.json();

    container.textContent = '';
    for (const chunk of chunks) {
      const label = document.createElement('div');
      label.className = 'chunk-label';
      label.textContent = `chunk ${chunk.chunk_index} · ${chunk.content.length} characters`;

      const text = document.createElement('pre');
      text.className = 'chunk-text';
      text.textContent = chunk.content;

      const wrap = document.createElement('div');
      wrap.className = 'chunk';
      wrap.append(label, text);
      container.append(wrap);
    }

    // Worth pointing out explicitly: the repeated text at each boundary is the
    // overlap, and reading it here is what makes chunking concrete.
    if (chunks.length > 1) {
      const hint = document.createElement('p');
      hint.className = 'small muted';
      hint.textContent =
        `The last ${CHUNK_OVERLAP} characters of each chunk are repeated at the ` +
        'start of the next one — that is the overlap.';
      container.append(hint);
    }
  } catch (error) {
    container.textContent = await describeFailure(error, response);
  }
}

function buildDocumentRow(doc, onChanged) {
  const row = document.createElement('div');
  row.className = 'doc';

  const head = document.createElement('div');
  head.className = 'doc-head';

  const title = document.createElement('span');
  title.className = 'doc-title';
  title.textContent = doc.title;
  title.title = 'Click to show the chunks';

  const meta = document.createElement('span');
  meta.className = 'doc-meta';
  if (doc.chunkCount === 0) {
    // The R-7 orphan: a document that exists but can never be retrieved.
    // Ingest cleans up after itself now, so this should never appear — but a
    // symptom you can see beats one you cannot.
    const warn = document.createElement('span');
    warn.className = 'warn';
    warn.textContent = '⚠ 0 chunks';
    meta.append(warn);
  } else {
    meta.textContent = `${doc.chunkCount} chunk${doc.chunkCount === 1 ? '' : 's'}`;
  }
  meta.append(` · ${new Date(doc.created_at).toLocaleDateString()}`);

  const del = document.createElement('button');
  del.type = 'button';
  del.textContent = '🗑';
  del.title = 'Delete this document';
  del.addEventListener('click', async () => {
    if (!confirm(`Delete "${doc.title}" and all ${doc.chunkCount} of its chunks?`)) return;
    del.disabled = true;
    let response = null;
    try {
      response = await fetch(`/api/documents/${doc.id}`, { method: 'DELETE' });
      if (!response.ok) throw new Error('failed');
      clearNotice();
      onChanged();
    } catch (error) {
      del.disabled = false;
      showNotice(`Could not delete: ${await describeFailure(error, response)}`, 'error');
    }
  });

  head.append(title, meta, del);
  row.append(head);

  // Expanding is lazy: the chunks are only fetched the first time you ask.
  const chunksEl = document.createElement('div');
  chunksEl.className = 'doc-chunks hidden';
  let loaded = false;
  title.addEventListener('click', () => {
    chunksEl.classList.toggle('hidden');
    if (!loaded && !chunksEl.classList.contains('hidden')) {
      loaded = true;
      expandChunks(chunksEl, doc.id);
    }
  });
  row.append(chunksEl);

  return row;
}

async function loadDocuments() {
  docsEl.textContent = 'Loading documents…';
  docsEl.className = 'small muted';

  let response = null;
  try {
    response = await fetch('/api/documents');
    if (!response.ok) throw new Error('failed');
    const documents = await response.json();

    headingEl.textContent = `Documents (${documents.length})`;
    docsEl.textContent = '';

    if (documents.length === 0) {
      docsEl.className = 'small muted';
      docsEl.textContent =
        'No documents yet. Paste something above to give the bot something to know.';
      return;
    }

    docsEl.className = '';
    for (const doc of documents) {
      docsEl.append(buildDocumentRow(doc, loadDocuments));
    }
  } catch (error) {
    docsEl.className = 'small';
    docsEl.textContent = await describeFailure(error, response);
  }
}

// --- adding a document ------------------------------------------------------

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  clearNotice();

  const title = titleEl.value.trim();
  const content = contentEl.value.trim();

  // Client-side validation as well as server-side. The server is the one that
  // matters; this just avoids a pointless round trip.
  if (title === '') return showNotice('A title is required.', 'error');
  if (content === '') return showNotice('Document content is required.', 'error');
  if (content.length > MAX_CONTENT_LENGTH) {
    return showNotice(
      `Document is ${content.length.toLocaleString()} characters; the limit is ` +
      `${MAX_CONTENT_LENGTH.toLocaleString()}.`,
      'error',
    );
  }

  submitEl.disabled = true;
  // Genuinely slow for a long document: the OpenAI embeddings call is
  // synchronous and there is no streaming or background job (mvp.md).
  submitEl.textContent = 'Embedding… (this may take a few seconds)';

  let response = null;
  try {
    response = await fetch('/api/documents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, source: sourceEl.value.trim(), content }),
    });
    if (!response.ok) throw new Error('failed');
    const result = await response.json();

    showNotice(
      `Added “${result.title}” — ${result.chunkCount} chunk${result.chunkCount === 1 ? '' : 's'} embedded.`,
      'ok',
    );
    form.reset();
    updateEstimate();
    loadDocuments();
  } catch (error) {
    showNotice(`Embedding failed: ${await describeFailure(error, response)}`, 'error');
  } finally {
    submitEl.disabled = false;
    submitEl.textContent = 'Add to knowledge base';
  }
});

loadDocuments();
