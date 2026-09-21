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

/**
 * Swap a pending turn into a real answer bubble, ready to be written into.
 *
 * Called the moment retrieval finishes, before a single token of the answer
 * exists — so the sources panel appears first and you can read what the model
 * was given while it is still deciding what to make of it (D-019).
 */
function startAnswer(turn, sources, searchQuery, question) {
  turn.textContent = '';
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  turn.append(bubble, buildSources(sources, searchQuery, question));
  scrollToBottom();
  return bubble;
}

/**
 * Append one fragment to the answer.
 *
 * `textContent +=` rather than innerHTML, same rule as everywhere else. It
 * also means a partial answer is always valid text: there is no half-parsed
 * markup to leave on screen if the stream stops mid-sentence.
 */
function appendDelta(bubble, text) {
  bubble.textContent += text;
  // Only follow the text down if the reader has not scrolled up to re-read
  // something. Yanking the viewport while someone is reading is worse than
  // making them scroll.
  const nearBottom = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 80;
  if (nearBottom) scrollToBottom();
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
    // Remove the question too, not just the error. retry() calls send(),
    // which adds the user's message to the list again - so leaving the
    // original in place makes the same question appear twice after one retry.
    const question = turn.previousElementSibling;
    if (question && question.classList.contains('user')) question.remove();
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
  // An error delivered inside the stream already carries the server's own
  // message; re-reading the body would fail, since it is consumed.
  if (response && response.bodyUsed) return error.message;
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

/**
 * Read a Server-Sent Events stream from a fetch response.
 *
 * `EventSource` exists for exactly this and cannot be used here, because it
 * only issues GET requests and the question has to go up in a POST body. So
 * the wire format gets parsed by hand — which is about fifteen lines, and is
 * the same parsing the server does to OpenAI's stream (D-019).
 *
 * The buffering matters: a network chunk can end halfway through an event, so
 * only text up to the last blank line can be processed, and the remainder has
 * to wait for more bytes.
 */
async function readEventStream(response, onEvent) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true }).replace(/\r/g, '');

    let boundary;
    while ((boundary = buffer.indexOf('\n\n')) !== -1) {
      const raw = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);

      let name = 'message';
      let data = '';
      for (const line of raw.split('\n')) {
        if (line.startsWith('event:')) name = line.slice(6).trim();
        else if (line.startsWith('data:')) data += line.slice(5).trim();
      }
      if (data !== '') onEvent(name, JSON.parse(data));
    }
  }
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
  let bubble = null;
  try {
    response = await fetch('/api/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // Asking for the streamed form. Drop this header and the same route
        // returns one JSON body instead.
        Accept: 'text/event-stream',
      },
      body: JSON.stringify({ conversationId, message: text }),
    });
    // Validation errors still arrive as a normal status, because they happen
    // before any streaming starts.
    if (!response.ok) throw new Error('request failed');

    let streamError = null;
    // The server ends every successful answer with `done`. Without checking
    // for it, ANY end of stream looks like success - including the server
    // dying or the socket dropping mid-sentence, which would leave a
    // truncated answer on screen indistinguishable from a complete one.
    let sawDone = false;
    await readEventStream(response, (event, data) => {
      if (event === 'meta') {
        conversationId = data.conversationId;
        bubble = startAnswer(pending, data.sources, data.searchQuery, text);
      } else if (event === 'delta') {
        if (bubble) appendDelta(bubble, data.text);
      } else if (event === 'done') {
        sawDone = true;
      } else if (event === 'error') {
        // A failure that happened after the response started. The status code
        // was already committed to 200, so this is the only way it can reach
        // us — and it has to be treated as seriously as a bad status.
        streamError = data.error;
      }
    });
    if (streamError) throw new Error(streamError);
    if (!sawDone) throw new Error('The connection closed before the answer finished.');
  } catch (error) {
    // If the answer had already started, keep what arrived and put the error
    // underneath it rather than discarding a partial answer.
    if (bubble && bubble.textContent !== '') {
      const notice = document.createElement('div');
      notice.className = 'notice error';
      notice.textContent = await describeFailure(error, response);
      pending.append(notice);
      scrollToBottom();
    } else {
      fillError(pending, await describeFailure(error, response), () => send(text));
    }
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
