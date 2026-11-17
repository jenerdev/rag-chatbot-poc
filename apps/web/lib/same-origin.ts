// Audit S-7 (D-164): a request that changes something must come from one of
// our own pages. Pure, so it is tested (same-origin.test.ts); applied to
// EVERY handler by withRoute() (lib/route.ts), before anything else runs.
//
// Before this, the only CSRF defence was the session cookie's SameSite=Lax:
// a browser does not send it on a cross-SITE POST. But "site" is the
// registrable domain, so a page on a sibling subdomain (any other app on the
// same custom domain, once there is one) is SAME-site, sends the cookie, and
// could post to a staff route. And JSON was parsed from any content type, so
// a plain HTML <form> (text/plain or urlencoded, no preflight) could deliver
// a JSON-shaped body.
//
// Two rules, for every method that can change state (not GET, HEAD, OPTIONS):
//   1. Origin: when the browser sends one (every modern browser does on a
//      POST, PUT, PATCH or DELETE), its host must be THIS request's host.
//      "null" (a sandboxed frame, a file) is refused. No Origin at all is a
//      non-browser client (curl, the walks, a server): there is no victim's
//      cookie jar to ride, so it is let through to the route's own checks.
//   2. Content type: the two a plain form can send without a preflight,
//      text/plain and application/x-www-form-urlencoded, are refused (415).
//      Our pages send JSON or multipart/form-data (the uploads, voice) and
//      nothing else; a multipart post from a foreign page is rule 1's.

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const FORM_TYPES = ['text/plain', 'application/x-www-form-urlencoded'];

export interface Refusal {
  status: 403 | 415;
  error: string;
}

/**
 * Null when the request may go on; otherwise the status and the sentence.
 * `host` is the request's own host (the Host header, or the URL's host).
 */
export function crossOriginRefusal(method: string, origin: string | null, contentType: string | null, host: string): Refusal | null {
  if (SAFE_METHODS.has(method.toUpperCase())) return null;

  if (origin !== null) {
    let originHost: string | null = null;
    try {
      originHost = origin === 'null' ? null : new URL(origin).host;
    } catch {
      originHost = null;
    }
    if (originHost === null || originHost.toLowerCase() !== host.toLowerCase()) {
      return { status: 403, error: 'This request did not come from this site, so it was refused.' };
    }
  }

  const type = (contentType ?? '').split(';')[0]!.trim().toLowerCase();
  if (FORM_TYPES.includes(type)) {
    return { status: 415, error: 'Send this request as JSON.' };
  }
  return null;
}

/** The request's own host: the Host header (Vercel and next dev set it), or the URL's. */
export function requestHost(request: Request): string {
  return request.headers.get('host') ?? new URL(request.url).host;
}
