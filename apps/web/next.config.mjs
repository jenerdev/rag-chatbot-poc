import { config } from 'dotenv';
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

/** @type {import('next').NextConfig} */
const nextConfig = {
  // The workspace packages ship compiled JavaScript, so Next has nothing to
  // transpile. If a package is ever consumed straight from TypeScript source,
  // it goes in `transpilePackages` here.
  experimental: {},
};

export default nextConfig;
