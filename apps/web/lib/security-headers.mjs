// Audit S-1 / B-2 (docs/audit/production-readiness-2026-11-03.md): the
// response headers every page and route carries, written ONCE here and
// applied by next.config.mjs's headers(). Pure: no I/O, so it is tested
// (security-headers.test.ts) and a .mjs, because next.config.mjs cannot
// import TypeScript.
//
// Why each one exists:
// - frame-ancestors 'none' (and X-Frame-Options: DENY for browsers that
//   predate it): no other site may put our pages in a frame. Without it a
//   page on any domain could frame S-15 or /platform under a decoy and
//   steer a signed-in staff member's click onto Confirm, Verify payment or
//   Archive tenant (clickjacking). Nothing of ours is meant to be embedded:
//   the chat is a page, not a widget.
// - The rest of the CSP is the SECOND wall behind React's escaping: if
//   anything ever renders model or tenant text as HTML, the injected script
//   still cannot load code from elsewhere or send data anywhere but here.
//   Every source below was measured against what the pages load (see the
//   comment on each), not copied from a template.
// - HSTS: once a browser has seen us over https it never tries http again,
//   so a staff login cannot be downgraded on café Wi-Fi. No `preload`: that
//   is a commitment to a list we would have to leave by hand.
// - nosniff: a guest's uploaded proof or a tenant's photo is served as what
//   its Content-Type says, never re-guessed as HTML or script.
// - Referrer-Policy: Manage booking carries ?ref=<booking reference>; a
//   cross-origin request (a tenant's logo on any https host) gets our origin
//   only, never that path and query.
// - Permissions-Policy: the voice composer needs the microphone (D-134), on
//   our own pages only; nothing needs the camera or location.

/**
 * The origin of the Supabase project, which serves the signed URL of a
 * payment proof that S-14 shows in an <iframe> when it is a PDF
 * (components/proof-viewer.tsx). Null when the URL is missing or unusable:
 * the proof PDF then cannot be framed, which fails closed.
 * @param {string | undefined} supabaseUrl
 * @returns {string | null}
 */
export function supabaseOrigin(supabaseUrl) {
  if (!supabaseUrl) return null;
  try {
    const url = new URL(supabaseUrl);
    return url.protocol === 'https:' || url.hostname === 'localhost' || url.hostname === '127.0.0.1' ? url.origin : null;
  } catch {
    return null;
  }
}

/**
 * The Content-Security-Policy, one directive per line of reasoning.
 * @param {{ supabaseUrl?: string, dev?: boolean }} options
 * @returns {string}
 */
export function contentSecurityPolicy({ supabaseUrl, dev = false } = {}) {
  const storage = supabaseOrigin(supabaseUrl);
  /** @type {Record<string, string[]>} */
  const directives = {
    'default-src': ["'self'"],
    // Next's App Router writes its flight data and bootstrap as INLINE
    // scripts (self.__next_f.push). Allowing them by nonce would need a
    // middleware and would make every page dynamic, the static landing page
    // and the public pages included; 'unsafe-inline' is the price of keeping
    // them static. Scripts still load from our own origin only. In `next
    // dev`, React Refresh evaluates code: 'unsafe-eval' there and nowhere else.
    'script-src': ["'self'", "'unsafe-inline'", ...(dev ? ["'unsafe-eval'"] : [])],
    // The tenant theme reaches the page as CSS custom properties in a
    // `style` attribute (D-030), and React renders every style prop as one.
    'style-src': ["'self'", "'unsafe-inline'"],
    // Room photos come from the Storage bucket, but a tenant's logo, banner
    // and avatar may be ANY https URL (lib/schemas.ts refuses everything
    // else); data: and blob: are a proof's preview before upload
    // (URL.createObjectURL) and the resized photo (lib/resize-image.ts).
    'img-src': ["'self'", 'data:', 'blob:', 'https:'],
    // Read aloud plays the speak route's audio as a blob: URL (voice.tsx).
    'media-src': ["'self'", 'blob:'],
    // Every fetch the browser makes is to our own /api; the browser never
    // talks to Supabase or OpenAI. `next dev`'s hot reload is a websocket.
    'connect-src': ["'self'", ...(dev ? ['ws:', 'wss:'] : [])],
    'font-src': ["'self'", 'data:'],
    // The proof PDF on S-14, a signed URL on the Supabase project.
    'frame-src': ["'self'", ...(storage ? [storage] : [])],
    // The tenant's service worker (/t/<slug>/sw.js, D-116).
    'worker-src': ["'self'"],
    'manifest-src': ["'self'"],
    'object-src': ["'none'"],
    // A <base> tag would re-point every relative URL; nothing sets one.
    'base-uri': ["'self'"],
    // Every form posts by fetch to our own routes.
    'form-action': ["'self'"],
    // The clickjacking wall: nobody frames us, ourselves included.
    'frame-ancestors': ["'none'"],
  };
  // No upgrade-insecure-requests: under `next start` on http://localhost it
  // rewrites our own script requests to https and the page dies, and it adds
  // nothing here: every source above is 'self' or https: only, and HSTS
  // covers navigation.
  return Object.entries(directives)
    .map(([name, sources]) => `${name} ${sources.join(' ')}`)
    .join('; ');
}

/**
 * Every header, as next.config.mjs's headers() wants them.
 * @param {{ supabaseUrl?: string, dev?: boolean }} options
 * @returns {{ key: string, value: string }[]}
 */
export function securityHeaders(options = {}) {
  return [
    { key: 'Content-Security-Policy', value: contentSecurityPolicy(options) },
    { key: 'X-Frame-Options', value: 'DENY' },
    { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains' },
    { key: 'X-Content-Type-Options', value: 'nosniff' },
    { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
    { key: 'Permissions-Policy', value: 'microphone=(self), camera=(), geolocation=(), payment=(), usb=()' },
  ];
}
