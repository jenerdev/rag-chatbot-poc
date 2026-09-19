// server.js — the Express app: routes, validation, static files, and the one
// place where an error becomes an HTTP status code.
//
// No business logic lives here. Routes validate their input, call into rag.js,
// and shape the response. Everything about chunking, embedding and retrieval
// is in src/.

import 'dotenv/config';
import express from 'express';
import {
  ingestDocument,
  listDocuments,
  deleteDocument,
  getChunks,
  answerQuestion,
  getMessages,
} from './src/rag.js';

// --- fail fast on missing config -------------------------------------------
// A missing key should be a one-line error at boot, not a confusing 401 twenty
// minutes later when you are debugging something else (architecture.md § 8).
const REQUIRED_ENV = [
  'OPENAI_API_KEY',
  'OPENAI_CHAT_MODEL',
  'OPENAI_EMBEDDING_MODEL',
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
];
const missing = REQUIRED_ENV.filter((name) => !process.env[name]);
if (missing.length > 0) {
  console.error(`Missing required environment variable(s): ${missing.join(', ')}`);
  console.error('Copy .env.example to .env and fill it in.');
  process.exit(1);
}

// Longest document accepted, in characters. Validation lives at the route
// boundary; the pipeline assumes its input is already sane.
const MAX_CONTENT_LENGTH = 100_000;

// Longest single question accepted. A question is embedded as one unit, and
// anything longer than this is a pasted document in the wrong box.
const MAX_MESSAGE_LENGTH = 2_000;
const PORT = process.env.PORT || 3000;

const app = express();

// Parse JSON bodies. The limit is generous enough for MAX_CONTENT_LENGTH of
// text plus the other fields, and stops a runaway paste from eating memory.
app.use(express.json({ limit: '1mb' }));

// Serve public/ as the site root, so GET / returns public/index.html.
app.use(express.static('public'));

// Serve the chunker to the browser as well.
//
// chunker.js is a pure module with no imports, which means the SAME file runs
// unchanged in Node and in the browser. The admin page imports it to show the
// live chunk estimate as you type, so CHUNK_SIZE and CHUNK_OVERLAP exist in
// exactly one place instead of being duplicated into frontend code where they
// would silently drift. This is the payoff for keeping that file dependency-free.
app.use('/chunker.js', express.static('src/chunker.js'));

/**
 * Wrap an async route so a rejected promise reaches the error handler.
 *
 * Express 4 does not catch async errors by itself (D-009 — this is one of the
 * few places where 5 would differ). Without this, a throw inside a route hangs
 * the request instead of returning a response.
 */
const route = (handler) => (req, res, next) => handler(req, res).catch(next);

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

// Add a document: chunk it, embed it, store it.
app.post('/api/documents', route(async (req, res) => {
  const { title, source, content } = req.body ?? {};

  if (typeof title !== 'string' || title.trim() === '') {
    return res.status(400).json({ error: 'A title is required' });
  }
  if (typeof content !== 'string' || content.trim() === '') {
    return res.status(400).json({ error: 'Document content is required' });
  }
  if (content.length > MAX_CONTENT_LENGTH) {
    return res.status(400).json({
      error: `Document is ${content.length} characters; the limit is ${MAX_CONTENT_LENGTH}`,
    });
  }

  const result = await ingestDocument({
    title: title.trim(),
    source: typeof source === 'string' && source.trim() !== '' ? source.trim() : null,
    content,
  });
  res.status(201).json(result);
}));

// List every document with its chunk count.
app.get('/api/documents', route(async (_req, res) => {
  res.json(await listDocuments());
}));

// Delete a document. Its chunks cascade.
app.delete('/api/documents/:id', route(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: 'Invalid document id' });
  }

  const deleted = await deleteDocument(id);
  if (!deleted) return res.status(404).json({ error: `No document with id ${id}` });
  res.json({ deleted: true });
}));

// The chunks of one document, for the expandable row on the admin page.
app.get('/api/documents/:id/chunks', route(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: 'Invalid document id' });
  }
  res.json(await getChunks(id));
}));

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------

// Ask a question. Returns the answer plus the exact chunks it was built from.
app.post('/api/chat', route(async (req, res) => {
  const { conversationId, message } = req.body ?? {};

  if (typeof message !== 'string' || message.trim() === '') {
    return res.status(400).json({ error: 'A message is required' });
  }
  if (message.length > MAX_MESSAGE_LENGTH) {
    return res.status(400).json({
      error: `Question is ${message.length} characters; the limit is ${MAX_MESSAGE_LENGTH}`,
    });
  }
  // conversationId is a uuid from a previous reply, or absent on the first
  // message of a session. Anything else is a client bug worth surfacing.
  if (conversationId !== undefined && conversationId !== null && typeof conversationId !== 'string') {
    return res.status(400).json({ error: 'conversationId must be a string' });
  }

  const result = await answerQuestion({
    conversationId: conversationId || null,
    message: message.trim(),
  });
  res.json(result);
}));

// Reload a conversation's transcript. The UI does not list past conversations
// (out of scope), but the messages are in the database, so this exists.
app.get('/api/conversations/:id/messages', route(async (req, res) => {
  res.json(await getMessages(req.params.id));
}));

// ---------------------------------------------------------------------------
// Errors -> status codes, in exactly one place
// ---------------------------------------------------------------------------

// Errors thrown by openai.js carry the upstream HTTP status. Everything else is
// a 500. The real message always reaches the client: no swallowing, no generic
// "something went wrong", no retries (architecture.md § 9). This is a local
// learning POC — leaking an internal message to yourself is the point.
app.use((error, _req, res, _next) => {
  const upstream = error.status;
  const status = upstream === 401 || upstream === 429 ? upstream
    : upstream >= 500 ? 502
    : 500;
  console.error('[error]', error.message);
  res.status(status).json({ error: error.message });
});

app.listen(PORT, () => {
  console.log(`RAG chatbot POC listening on http://localhost:${PORT}`);
  console.log(`  chat model      : ${process.env.OPENAI_CHAT_MODEL}`);
  console.log(`  embedding model : ${process.env.OPENAI_EMBEDDING_MODEL}`);
});
