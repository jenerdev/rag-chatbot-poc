import { config } from 'dotenv';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Load the repo-root .env.
//
// Next reads .env files from the Next project root, which is apps/web — but the
// secrets live at the repo root, where the legacy POC, the eval tools and the
// db verification script all read them from. Copying them into apps/web would
// mean two files holding the same API key, free to drift, and two places to
// revoke when one leaks.
//
// This runs before the server starts, so anything it sets is in process.env by
// the time a route handler runs. In production, env comes from the platform and
// this file finds nothing to load, which is correct.
config({ path: join(dirname(fileURLToPath(import.meta.url)), '..', '..', '.env') });

// D-148: which build this is, worked out ONCE here and inlined into the
// pages as NEXT_PUBLIC_APP_VERSION (apps/web/lib/version.ts): the short
// commit (Vercel's VERCEL_GIT_COMMIT_SHA, or git on a machine), a "+" when
// the tree has uncommitted changes, and the build date. A number someone
// must bump by hand says nothing reliable; the commit does.
function appVersion() {
  const git = (args) => {
    try {
      return execSync(`git ${args}`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    } catch {
      return '';
    }
  };
  const sha = (process.env.VERCEL_GIT_COMMIT_SHA ?? '').slice(0, 7) || git('rev-parse --short HEAD') || 'unknown';
  const dirty = process.env.VERCEL_GIT_COMMIT_SHA ? '' : git('status --porcelain') ? '+' : '';
  return `${sha}${dirty} · ${new Date().toISOString().slice(0, 10)}`;
}

/** @type {import('next').NextConfig} */
const nextConfig = {
  env: { NEXT_PUBLIC_APP_VERSION: appVersion() },
  // The workspace packages ship compiled JavaScript, so Next has nothing to
  // transpile. If a package is ever consumed straight from TypeScript source,
  // it goes in `transpilePackages` here.
  experimental: {},
};

export default nextConfig;
