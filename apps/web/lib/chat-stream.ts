// Reading the answer stream in the browser.
//
// Ported from public/app.js with the logic unchanged — only the module shape is
// different. Deliberately NOT a React hook: it is a loop over a response body,
// and wrapping it in one would hide the buffering that is the whole point.

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
export async function readEventStream(
  response: Response,
  onEvent: (name: string, data: any) => void,
): Promise<void> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true }).replace(/\r/g, '');

    let boundary: number;
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

/**
 * Turn a failed request into a sentence worth reading.
 *
 * The server already sends specific messages (architecture.md § 9), so the job
 * here is mostly to pass them through and to recognise the one case the server
 * cannot report: itself being down.
 */
export async function describeFailure(error: Error, response: Response | null): Promise<string> {
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
    if (response.status === 429)
      return `OpenAI request failed: out of credits or rate limited. (${detail})`;
    return detail;
  }
  // fetch itself rejected: nothing answered on localhost:3000.
  //
  // The command named here is the one thing in this file that HAD to change:
  // the POC said `node server.js`, which no longer exists. A message telling
  // someone to run a command that is gone is worse than no message.
  return `Cannot reach the server. Is \`pnpm dev\` running? (${error.message})`;
}
