// app.js — the chat page (S-1).
//
// Native DOM, no framework, no build step. Two rules run through this file:
//
//   1. textContent, NEVER innerHTML, for anything that came from the server or
//      the model. The model's output is untrusted text, and so is the content
//      of any document you pasted in. textContent cannot execute anything.
//   2. No markdown rendering in the MVP — newlines are handled by CSS
//      (white-space: pre-wrap), not by parsing.

const messagesEl = document.getElementById('messages');
const turnsEl = document.getElementById('turns');
const emptyStateEl = document.getElementById('empty-state');
const emptyHintEl = document.getElementById('empty-hint');
const inputEl = document.getElementById('input');
const sendEl = document.getElementById('send');
const newChatEl = document.getElementById('new-chat');

// The whole of this session's state.
//
// The conversation lives in the database, but the browser only has to remember
// its id — the server re-sends the last few messages to the model on every
// turn. Refreshing the page starts a new conversation, which is deliberate:
// listing past conversations is out of scope (mvp.md).
let conversationId = null;
let busy = false;

// --- rendering --------------------------------------------------------------

function scrollToBottom() {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function addUserTurn(text) {
  const turn = document.createElement('div');
  turn.className = 'turn user';
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.textContent = text;
  turn.append(bubble);
  turnsEl.append(turn);
  scrollToBottom();
}

/** The animated placeholder shown while the server is working. */
function addPendingTurn() {
  const turn = document.createElement('div');
  turn.className = 'turn assistant';
  const bubble = document.createElement('div');
  bubble.className = 'bubble pending';
  bubble.textContent = 'Searching the knowledge base…';
  turn.append(bubble);
  turnsEl.append(turn);
  scrollToBottom();
  return turn;
}

/**
 * Build the sources panel for one answer.
 *
 * This is a required feature, not a debug aid (D-012). It is the only way to
 * tell "the bot read my document" from "the model happened to know this" —
 * without it, a wrong answer is a mystery instead of something you can
 * diagnose in two seconds.
 */
function buildSources(sources, searchQuery, question) {
  const details = document.createElement('details');
  details.className = 'sources';

  const summary = document.createElement('summary');
  if (sources.length === 0) {
    // Not an error. This is the system correctly declining to answer.
    summary.textContent = 'No matching chunks above the similarity threshold.';
    details.append(summary);
    return details;
  }
  summary.textContent = `${sources.length} source${sources.length === 1 ? '' : 's'}`;
  details.append(summary);

  // If the search used different words from the ones typed, say so. Retrieval
  // quietly searching for something other than the question is exactly the
  // kind of thing that should be visible (D-016, same argument as D-012).
  if (searchQuery && searchQuery !== question) {
    const note = document.createElement('p');
    note.className = 'rewrite-note';
    note.textContent = `searched for: ${searchQuery}`;
    details.append(note);
  }

  for (const source of sources) {
    const box = document.createElement('div');
    box.className = 'source';

    const head = document.createElement('div');
    head.className = 'source-head';

    const title = document.createElement('span');
    title.className = 'source-title';
    title.textContent = source.documentTitle;

    const score = document.createElement('span');
    score.className = 'source-score';
    // Three decimals: the difference between 0.42 and 0.45 is the difference
    // between a good match and a mediocre one, and you want to see it.
    score.textContent = source.similarity.toFixed(3);

    // Which of the two searches found this chunk (D-015). Worth showing: a
    // 'keyword' badge on a chunk with a low similarity score is the hybrid
    // search visibly doing the job vector search could not.
    const found = document.createElement('span');
    found.className = `source-found ${source.foundBy}`;
    found.textContent = source.foundBy;
    found.title = {
      vector: 'Found by semantic similarity',
      keyword: 'Found by exact keyword match — vector search missed this',
      both: 'Found by both searches',
    }[source.foundBy] ?? '';

    head.append(title, found, score);

    const text = document.createElement('p');
    text.className = 'source-text truncated';
    text.textContent = source.content;
    text.title = 'Click to expand';
    // Click a chunk to read it in full. Seeing the whole chunk is what tells
    // you whether the answer was really in there.
    text.addEventListener('click', () => text.classList.toggle('truncated'));

    box.append(head, text);
    details.append(box);
  }

  return details;
}

/** Replace a pending turn with the real answer and its sources. */
function fillAnswer(turn, reply, sources, searchQuery, question) {
  turn.textContent = '';
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.textContent = reply;
  turn.append(bubble, buildSources(sources, searchQuery, question));
  scrollToBottom();
}

/**
 * Replace a pending turn with an error, plus a Retry button.
 *
 * The user's message stays in the list (screens.md § S-1) — losing what you
 * typed because the server hiccuped is its own small insult.
 */
function fillError(turn, message, retry) {
  turn.textContent = '';
  const notice = document.createElement('div');
  notice.className = 'notice error';
  notice.textContent = message;

  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = 'Retry';
  button.addEventListener('click', () => {
    turn.remove();
    retry();
  });

  notice.append(button);
  turn.append(notice);
  scrollToBottom();
}

// --- talking to the server --------------------------------------------------

/**
 * Turn a failed request into a sentence worth reading.
 *
 * The server already sends specific messages (architecture.md § 9), so the job
 * here is mostly to pass them through and to recognise the one case the server
 * cannot report: itself being down.
 */
async function describeFailure(error, response) {
  if (response) {
    let detail = `HTTP ${response.status}`;
    try {
      const body = await response.json();
      if (body.error) detail = body.error;
    } catch {
      // Not JSON — keep the status line.
    }
    if (response.status === 401) return `OpenAI rejected the API key — check .env. (${detail})`;
    if (response.status === 429) return `OpenAI request failed: out of credits or rate limited. (${detail})`;
    return detail;
  }
  // fetch itself rejected: nothing answered on localhost:3000.
  return `Cannot reach the server. Is \`node server.js\` running? (${error.message})`;
}

async function send(text) {
  if (busy) return;
  busy = true;
  sendEl.disabled = true;
  inputEl.disabled = true;
  emptyStateEl.classList.add('hidden');

  addUserTurn(text);
  const pending = addPendingTurn();

  let response = null;
  try {
    response = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationId, message: text }),
    });
    if (!response.ok) throw new Error('request failed');

    const data = await response.json();
    // Hold onto the id so the next message continues the same conversation.
    conversationId = data.conversationId;
    fillAnswer(pending, data.reply, data.sources, data.searchQuery, text);
  } catch (error) {
    fillError(pending, await describeFailure(error, response), () => send(text));
  } finally {
    busy = false;
    sendEl.disabled = false;
    inputEl.disabled = false;
    inputEl.focus();
  }
}

function submit() {
  const text = inputEl.value.trim();
  if (text === '') return;
  inputEl.value = '';
  inputEl.style.height = 'auto';
  send(text);
}

// --- wiring -----------------------------------------------------------------

sendEl.addEventListener('click', submit);

inputEl.addEventListener('keydown', (event) => {
  // Enter sends; Shift+Enter inserts a newline.
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    submit();
  }
});

// Grow the textarea with its content, up to the max-height in the stylesheet.
inputEl.addEventListener('input', () => {
  inputEl.style.height = 'auto';
  inputEl.style.height = `${inputEl.scrollHeight}px`;
});

newChatEl.addEventListener('click', () => {
  // Clearing the id is all it takes: the server creates a new conversation row
  // on the next message. The old conversation stays in the database.
  conversationId = null;
  turnsEl.textContent = '';
  emptyStateEl.classList.remove('hidden');
  inputEl.focus();
});

/**
 * On load, check whether there is anything to ask about.
 *
 * An empty knowledge base makes every question return the refusal, which looks
 * broken if you do not know why. Better to say so up front.
 */
(async function checkKnowledgeBase() {
  try {
    const response = await fetch('/api/documents');
    if (!response.ok) return;
    const documents = await response.json();
    if (documents.length === 0) {
      emptyHintEl.textContent = 'Your knowledge base is empty — add a document first.';
      const link = document.createElement('a');
      link.href = 'admin.html';
      link.textContent = 'Go to the knowledge base';
      link.className = 'button';
      link.style.marginTop = '12px';
      link.style.display = 'inline-block';
      emptyStateEl.append(document.createElement('br'), link);
    }
  } catch {
    // The server being down is not worth a banner before the user has done
    // anything — the first message will report it clearly.
  }
})();
