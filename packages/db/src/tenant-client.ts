// tenant-client.ts — how a request reaches Postgres since auth-rls Phase 3.
//
// Every request holds a client built from the PUBLISHABLE key plus one
// short-lived token that names its tenant. PostgREST verifies the token's
// signature against the project's JWKS, switches to the `authenticated` role,
// and hands the claims to Postgres, where the RLS policies in
// sql/schema-auth.sql compare every row's tenant_id against them. So a query
// that forgot its `.eq('tenant_id', …)` still cannot read another tenant
// (plan/auth-rls.md Rule 1: two walls).
//
// The token is signed by US, not by Supabase: ES256 over our own EC P-256
// key, which the project trusts because it is imported as a *standby* signing
// key (D-039, measured in Phase 0). A JWT is base64url(header) .
// base64url(payload) . base64url(signature), and node:crypto does the one
// hard part. No JWT library (D-002's spirit).
//
// ⚠️ TENANT_SIGNING_JWK is a master key too (§ 2.2, R-19). Whoever holds it
// can mint any claim, `role: service_role` included. So it is read here and
// nowhere else, and mintTenantToken() mints exactly one shape: role
// `authenticated`, a tenant, five minutes.
import 'server-only';

import { createPrivateKey, sign, type KeyObject } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Database } from './database.types.js';

/** A supabase-js client typed against this database. What `TenantContext.db` holds. */
export type DbClient = SupabaseClient<Database>;

/**
 * Five minutes. Long enough to outlive a streamed answer (60 s at worst),
 * short enough that a leaked token is dead before it is much use. A token is
 * minted per request, so nothing ever refreshes one.
 */
export const TENANT_TOKEN_SECONDS = 300;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let signingKey: { key: KeyObject; kid: string } | undefined;

function loadSigningKey(): { key: KeyObject; kid: string } {
  if (signingKey) return signingKey;
  const text = process.env.TENANT_SIGNING_JWK;
  if (!text) throw new Error('TENANT_SIGNING_JWK is not set: the private JWK imported as a Supabase standby signing key (D-039)');
  const jwk = JSON.parse(text) as { kid?: string; crv?: string; d?: string };
  // A kid is what lets PostgREST pick OUR key out of the JWKS. Without one,
  // every token fails with PGRST301 "No suitable key", which does not say why.
  if (!jwk.kid || jwk.crv !== 'P-256' || !jwk.d) {
    throw new Error('TENANT_SIGNING_JWK must be a private EC P-256 JWK with a kid');
  }
  signingKey = { key: createPrivateKey({ key: jwk as never, format: 'jwk' }), kid: jwk.kid };
  return signingKey;
}

const base64url = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

/**
 * Mint the token a request reaches Postgres with.
 *
 * - **Chat** (`{ tenantId }`): no `sub` at all. auth.uid() casts `sub` to uuid,
 *   so any non-uuid would make every policy that touches it raise instead of
 *   deny (§ 2.4). Absent, it is null, and those policies are simply false.
 * - **Staff** (`{ tenantId, userId, admin: true }`): the user's uuid, and
 *   `app_admin`. That alone writes nothing: app_is_admin() also requires a
 *   `memberships` row for this user and THIS tenant.
 *
 * There is no `role` parameter. The role is always `authenticated`, which is
 * the refusal § 2.2 asks for: this function cannot mint `service_role`.
 */
export function mintTenantToken(input: { tenantId: number; userId?: string; admin?: boolean }): string {
  const { tenantId, userId, admin = false } = input;
  if (!Number.isSafeInteger(tenantId) || tenantId <= 0) throw new Error(`mintTenantToken: bad tenantId ${tenantId}`);
  if (userId !== undefined && !UUID.test(userId)) throw new Error('mintTenantToken: userId must be a uuid');
  if (admin && userId === undefined) throw new Error('mintTenantToken: an admin token needs a userId');

  const { key, kid } = loadSigningKey();
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    role: 'authenticated',
    tenant_id: tenantId,
    ...(userId !== undefined ? { sub: userId } : {}),
    ...(admin ? { app_admin: true } : {}),
    iat: now,
    exp: now + TENANT_TOKEN_SECONDS,
  };
  const input64 = `${base64url({ alg: 'ES256', typ: 'JWT', kid })}.${base64url(claims)}`;
  // A JWT's ES256 signature is raw r||s (IEEE P1363). node:crypto defaults to
  // DER, which every verifier rejects, with an error that does not say why.
  const signature = sign('sha256', Buffer.from(input64), { key, dsaEncoding: 'ieee-p1363' });
  return `${input64}.${signature.toString('base64url')}`;
}

function publishableClient(headers?: Record<string, string>): DbClient {
  return createClient<Database>(process.env.SUPABASE_URL!, process.env.SUPABASE_PUBLISHABLE_KEY!, {
    // No session: the token is the whole identity, and it is never refreshed.
    auth: { persistSession: false, autoRefreshToken: false },
    ...(headers ? { global: { headers } } : {}),
  });
}

/** A client that reaches Postgres as this token, and so under its RLS. */
export function scopedClient(token: string): DbClient {
  return publishableClient({ Authorization: `Bearer ${token}` });
}

/**
 * No token at all: the `anon` role. It reads no table. It exists for
 * tenant_public(slug), which is called before the server knows which tenant
 * to mint a token for.
 */
export function anonClient(): DbClient {
  return publishableClient();
}
