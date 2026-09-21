// The request limits, shared by the route handlers and the browser.
//
// NOT in env.ts, which is `server-only`. The admin page renders a live
// character count against MAX_CONTENT_LENGTH, so a Client Component has to be
// able to import it — and importing anything from a server-only module fails
// the build, correctly.
//
// In the POC these were declared in server.js and duplicated into admin.js
// under a `// must match server.js` comment. They now exist once. This file is
// the dividing line the monorepo makes possible: values the browser may know,
// separate from values it may not.

/**
 * Longest document accepted, in characters.
 *
 * Validation lives at the route boundary; the pipeline assumes its input is
 * already sane.
 */
export const MAX_CONTENT_LENGTH = 100_000;

/**
 * Longest single question accepted.
 *
 * A question is embedded as one unit, and anything longer than this is a
 * pasted document in the wrong box.
 */
export const MAX_MESSAGE_LENGTH = 2_000;
