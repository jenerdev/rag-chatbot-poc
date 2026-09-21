// api-parity.mjs — does the Next API answer exactly like the Express one?
//
// Phase 5's definition of done: every curl in README.md returns the same status
// code and body shape as it did in Phase 0. Rather than eyeballing that, run
// both servers at once and diff every response.
//
//   legacy Express : http://localhost:3099
//   Next           : http://localhost:3000

const OLD = 'http://localhost:3099';
const NEW = 'http://localhost:3000';

let checks = 0;
let failures = 0;

async function call(base, { method = 'GET', path, body, accept }) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (accept) headers.Accept = accept;

  const res = await fetch(base + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const text = await res.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  return { status: res.status, contentType: res.headers.get('content-type'), body: parsed };
}

/** Compare two responses, ignoring values that cannot be equal across two calls. */
function compare(label, a, b, { shapeOnly = false } = {}) {
  checks++;
  const statusSame = a.status === b.status;
  const bodySame = shapeOnly
    ? JSON.stringify(shape(a.body)) === JSON.stringify(shape(b.body))
    : JSON.stringify(a.body) === JSON.stringify(b.body);

  if (statusSame && bodySame) {
    console.log(`PASS  ${label.padEnd(58)} ${a.status}`);
    return;
  }
  failures++;
  console.error(`FAIL  ${label}`);
  console.error(`   old ${a.status}: ${JSON.stringify(a.body)?.slice(0, 220)}`);
  console.error(`   new ${b.status}: ${JSON.stringify(b.body)?.slice(0, 220)}`);
}

/** Keys and types only — for bodies whose values legitimately differ per call. */
function shape(value) {
  if (Array.isArray(value)) return value.length === 0 ? [] : [shape(value[0])];
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, shape(value[k])]),
    );
  }
  return typeof value;
}

const cases = [
  // --- reads: identical bodies, not just identical shapes -------------------
  { label: 'GET /api/documents', req: { path: '/api/documents' } },

  // --- validation: the messages are part of the contract --------------------
  { label: 'POST /api/documents  (no body)', req: { method: 'POST', path: '/api/documents', body: {} } },
  {
    label: 'POST /api/documents  (no title)',
    req: { method: 'POST', path: '/api/documents', body: { content: 'x' } },
  },
  {
    label: 'POST /api/documents  (blank title)',
    req: { method: 'POST', path: '/api/documents', body: { title: '   ', content: 'x' } },
  },
  {
    label: 'POST /api/documents  (no content)',
    req: { method: 'POST', path: '/api/documents', body: { title: 'T' } },
  },
  {
    label: 'POST /api/documents  (blank content)',
    req: { method: 'POST', path: '/api/documents', body: { title: 'T', content: '   ' } },
  },
  {
    label: 'POST /api/documents  (content too long)',
    req: { method: 'POST', path: '/api/documents', body: { title: 'T', content: 'x'.repeat(100_001) } },
  },
  {
    label: 'POST /api/documents  (title not a string)',
    req: { method: 'POST', path: '/api/documents', body: { title: 42, content: 'x' } },
  },

  // --- ids ------------------------------------------------------------------
  { label: 'DELETE /api/documents/abc', req: { method: 'DELETE', path: '/api/documents/abc' } },
  { label: 'DELETE /api/documents/0', req: { method: 'DELETE', path: '/api/documents/0' } },
  { label: 'DELETE /api/documents/-5', req: { method: 'DELETE', path: '/api/documents/-5' } },
  { label: 'DELETE /api/documents/999999 (absent)', req: { method: 'DELETE', path: '/api/documents/999999' } },
  { label: 'GET /api/documents/abc/chunks', req: { path: '/api/documents/abc/chunks' } },
  { label: 'GET /api/documents/999999/chunks (absent)', req: { path: '/api/documents/999999/chunks' } },

  // --- chat validation ------------------------------------------------------
  { label: 'POST /api/chat  (no message)', req: { method: 'POST', path: '/api/chat', body: {} } },
  {
    label: 'POST /api/chat  (blank message)',
    req: { method: 'POST', path: '/api/chat', body: { message: '   ' } },
  },
  {
    label: 'POST /api/chat  (message too long)',
    req: { method: 'POST', path: '/api/chat', body: { message: 'x'.repeat(2_001) } },
  },
  {
    label: 'POST /api/chat  (conversationId not a string)',
    req: { method: 'POST', path: '/api/chat', body: { message: 'hi', conversationId: 7 } },
  },

  // --- the upstream failure, mapped ----------------------------------------
  // The invalid API key makes this the one live check of the error map: an
  // upstream 401 must reach the client AS a 401, carrying the real message.
  {
    label: 'POST /api/chat  (valid -> upstream 401)',
    req: { method: 'POST', path: '/api/chat', body: { message: 'What is the Wi-Fi password?' } },
  },
];

console.log('legacy :3099   vs   next :3000\n');

for (const { label, req, shapeOnly } of cases) {
  const [a, b] = [await call(OLD, req), await call(NEW, req)];
  compare(label, a, b, { shapeOnly });
}

// --- the chunks of a real document -------------------------------------------
const docs = await call(OLD, { path: '/api/documents' });
const firstId = docs.body[0]?.id;
if (firstId) {
  const [a, b] = [
    await call(OLD, { path: `/api/documents/${firstId}/chunks` }),
    await call(NEW, { path: `/api/documents/${firstId}/chunks` }),
  ];
  compare(`GET /api/documents/${firstId}/chunks`, a, b);
}

// --- content negotiation ------------------------------------------------------
// The bug the POC documented: curl sends `Accept: */*`, and a negotiation helper
// matches that against text/event-stream. Both servers must hand */* the JSON.
console.log('\ncontent negotiation (D-019)');
for (const [label, accept] of [
  ['Accept: */*            -> JSON', '*/*'],
  ['Accept: application/json -> JSON', 'application/json'],
]) {
  const req = { method: 'POST', path: '/api/chat', body: { message: 'hello' }, accept };
  const [a, b] = [await call(OLD, req), await call(NEW, req)];
  checks++;
  const oldJson = (a.contentType ?? '').includes('application/json');
  const newJson = (b.contentType ?? '').includes('application/json');
  if (oldJson && newJson) console.log(`PASS  ${label.padEnd(58)} ${b.status}`);
  else {
    failures++;
    console.error(`FAIL  ${label}: old ${a.contentType}, new ${b.contentType}`);
  }
}

// Accept: text/event-stream must stream on both — and, with a dead API key,
// must deliver the failure as an `error` EVENT inside a 200, not as a status.
console.log('\nstreaming: the failure travels as data');
for (const [name, base] of [
  ['legacy', OLD],
  ['next', NEW],
]) {
  const res = await fetch(`${base}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify({ message: 'What is the Wi-Fi password?' }),
  });
  const text = await res.text();
  const events = [...text.matchAll(/^event: (\w+)$/gm)].map((m) => m[1]);
  checks++;

  const ok =
    res.status === 200 &&
    (res.headers.get('content-type') ?? '').includes('text/event-stream') &&
    res.headers.get('x-accel-buffering') === 'no' &&
    events.includes('error');

  if (ok) {
    const error = /^data: (.*)$/m.exec(text.slice(text.indexOf('event: error')))?.[1];
    console.log(`PASS  ${name.padEnd(8)} 200 text/event-stream  events=[${events.join(' ')}]`);
    console.log(`         ${JSON.parse(error).error.slice(0, 96)}`);
  } else {
    failures++;
    console.error(
      `FAIL  ${name}: status ${res.status}, type ${res.headers.get('content-type')}, ` +
        `x-accel-buffering ${res.headers.get('x-accel-buffering')}, events [${events.join(' ')}]`,
    );
  }
}

console.log(`\n${checks} comparisons, ${failures} differences`);
process.exit(failures === 0 ? 0 : 1);
