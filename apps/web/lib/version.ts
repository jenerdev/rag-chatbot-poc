// version.ts — which build this is (D-148).
//
// The user: "please add version. so i know im accessing the latest version."
// A number someone must remember to bump says nothing reliable; the commit
// does. next.config.mjs works it out once per build and inlines it here as
// NEXT_PUBLIC_APP_VERSION: the short commit (Vercel's VERCEL_GIT_COMMIT_SHA,
// or `git rev-parse --short HEAD` on a machine) and the build date, UTC,
// "cd1c21a · 2026-10-26". A tree with uncommitted changes is marked "+".
// Browser-safe: a constant, inlined at build time, read nowhere else.

export const APP_VERSION = process.env.NEXT_PUBLIC_APP_VERSION ?? 'dev';
