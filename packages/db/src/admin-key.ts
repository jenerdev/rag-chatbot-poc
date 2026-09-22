// admin-key.ts — how `tenants.admin_key_hash` is written and checked.
//
// Lives in @rag/db, beside the column it protects, because two callers need it:
// the web app's login route verifies a key, and `tools/tenant.mjs` hashes a new
// one. Only `node:crypto` is used. No bcrypt/argon2 dependency, because
// D-001/D-002 ("no library does a step") applies to auth too: the whole scheme
// is readable in this file.

import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

/**
 * scrypt cost. 2^15 is the current OWASP-style floor for interactive logins.
 * Measured at 50 ms per hash on this machine, which is fine for an admin sign-in.
 */
const N = 2 ** 15;
const R = 8;
const P = 1;
const KEY_LENGTH = 64;
/** scrypt needs 128·N·r bytes, which is 32 MiB at these settings. Node's default cap is exactly 32 MiB, so raise it. */
const MAXMEM = 64 * 1024 * 1024;

/**
 * Hash a new admin key for storage.
 *
 * The stored form is `scrypt$<N>$<salt-b64>$<hash-b64>`, so the cost travels
 * with the hash. N can be raised later: old hashes still verify with their own
 * N, and there is no migration.
 */
export async function hashAdminKey(key: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(key, salt, KEY_LENGTH, { N, r: R, p: P, maxmem: MAXMEM });
  return `scrypt$${N}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

/**
 * Does `key` match the stored hash?
 *
 * `false` for a NULL hash. A tenant with no key set has NO admin access, which
 * is default-deny (plan.md Phase 6). The other default would be one forgotten
 * column away from an open admin panel. `false`, too, for a malformed stored
 * value, rather than a throw that would turn into a 500.
 *
 * The comparison is `timingSafeEqual`, never `===`. A string compare returns as
 * soon as a byte differs, which leaks, through response time, how much of a
 * guess was right.
 */
export async function verifyAdminKey(key: string, stored: string | null): Promise<boolean> {
  if (!stored) return false;

  const [scheme, cost, saltB64, hashB64] = stored.split('$');
  const n = Number(cost);
  if (scheme !== 'scrypt' || !Number.isInteger(n) || !saltB64 || !hashB64) return false;

  const expected = Buffer.from(hashB64, 'base64');
  const actual = await scrypt(key, Buffer.from(saltB64, 'base64'), expected.length, {
    N: n,
    r: R,
    p: P,
    maxmem: MAXMEM,
  });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/**
 * A new admin key: 32 random bytes, base64url.
 *
 * Printed exactly once by `tools/tenant.mjs` and never stored. Only its hash
 * is. A "recover the key" feature would be a "read the key" feature.
 */
export function generateAdminKey(): string {
  return randomBytes(32).toString('base64url');
}
