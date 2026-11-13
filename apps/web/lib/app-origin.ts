// Audit S-13 (D-169): the address a password-reset email links back to.
// Pure, so it is tested (app-origin.test.ts).
//
// The reset routes used to build it from the REQUEST's own URL, whose host
// is the Host header, which the caller writes. A forged Host would ask
// Supabase to email the recovery link (the token is in its fragment) to
// another site. Supabase's Redirect URLs allowlist is what refused that; a
// broad wildcard there would have let it through. Now the origin comes from
// configuration, never from the request, except in development:
//
//   1. APP_URL, when set: the same setting the CLI invites use
//      (tools/member.mjs, tools/super.mjs);
//   2. on Vercel, VERCEL_PROJECT_PRODUCTION_URL, which Vercel sets to the
//      production domain itself (a preview's reset link goes to production);
//   3. in development, the request's origin, as before (localhost);
//   4. anywhere else in production: refused, in words, rather than trusting
//      the Host header.

export class AppOriginError extends Error {}

export function appOrigin(
  env: { APP_URL?: string | undefined; VERCEL_PROJECT_PRODUCTION_URL?: string | undefined; NODE_ENV?: string | undefined },
  requestUrl: string,
): string {
  const configured = env.APP_URL?.trim();
  if (configured) {
    const url = new URL(configured);
    if (url.protocol !== 'https:' && env.NODE_ENV === 'production' && url.hostname !== 'localhost') {
      throw new AppOriginError('APP_URL must be https in production.');
    }
    return url.origin;
  }
  const vercel = env.VERCEL_PROJECT_PRODUCTION_URL?.trim();
  if (vercel) return new URL(`https://${vercel.replace(/^https?:\/\//, '')}`).origin;
  if (env.NODE_ENV !== 'production') return new URL(requestUrl).origin;
  throw new AppOriginError('Set APP_URL to this site\'s address (https://…): password-reset links are not built from the request.');
}
