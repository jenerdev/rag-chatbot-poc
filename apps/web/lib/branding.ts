import 'server-only';
import { cache } from 'react';
import type { CSSProperties } from 'react';
import { anonClient } from '@rag/db';
import type { TenantContext } from '@rag/pipeline';
import { themeVars } from './theme';

// Per-tenant branding: server data becoming markup (plan.md § 2.4).
//
// The obvious implementation is
//     <style dangerouslySetInnerHTML={{ __html: `:root{--accent:${theme.accent}}` }} />
// which is CSS injection from a database column, and exactly what CLAUDE.md
// § Conventions forbids. Instead, the colours are set as CSS custom properties
// through React's ordinary `style` prop, which React escapes. On top of that,
// each value must pass a strict colour regex, so a string that is not a colour
// never reaches the page at all.

// The theme's keys, regex and `themeVars()` live in lib/theme.ts since tenant
// management Phase 3: the platform form writes themes now, and it must
// validate with the SAME rule this page reads with. That file is pure, so the
// form (a Client Component) can import it; this one stays server-only.

/** An absolute https: URL, or nothing. An unvalidated `<img src>` is the same class of hole as unvalidated CSS. */
function httpsUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    return new URL(value).protocol === 'https:' ? value : null;
  } catch {
    return null;
  }
}

/** What a page needs to look like its tenant. Never contains the admin hash. */
export interface Branding {
  businessName: string;
  assistantName: string;
  logoUrl: string | null;
  bannerUrl: string | null;
  /** the assistant's picture (D-124); null: the logo, else its initial */
  assistantAvatarUrl: string | null;
  /** Ready for a `style` prop: only allowlisted custom properties, only valid colours. */
  themeStyle: CSSProperties;
  /** What the privacy page states (D-129): tenant_public()'s legal columns. */
  legal: { contactName: string | null; contactEmail: string | null; policyVersion: string; chatRetentionDays: number; guestRetentionDays: number };
}

export { themeVars };

/**
 * Load a tenant's branding, validated on READ as well as on write.
 *
 * Through `tenant_public(slug)`, the same function loadTenant() uses: no token
 * can read `tenants` directly (auth-rls Phase 1), and that function's column
 * list is the whole boundary: only public columns can reach a Client Component's props.
 *
 * Memoised per request with React `cache()`, like getTenant() and
 * loadFeatures(): the tenant layout and the page it wraps both ask for the
 * branding of the same request, and before this each paid its own
 * `tenant_public` round trip (2026-10-27: three calls per staff page, one of
 * them getTenant()'s). cache() compares the argument by identity, and
 * getTenant() hands every caller the same TenantContext object, so this is
 * one query per request.
 */
export const loadBranding = cache(async (tenant: TenantContext): Promise<Branding> => {
  const { data: rows, error } = await anonClient().rpc('tenant_public', { p_slug: tenant.slug });
  const data = rows?.[0];
  if (error || !data) throw new Error(`Could not load branding for "${tenant.slug}": ${error?.message ?? 'no such tenant'}`);

  return {
    businessName: tenant.businessName,
    assistantName: tenant.assistantName,
    logoUrl: httpsUrl(data.logo_url),
    bannerUrl: httpsUrl(data.banner_url),
    assistantAvatarUrl: httpsUrl((data as { assistant_avatar_url?: unknown }).assistant_avatar_url),
    themeStyle: themeVars(data.theme),
    legal: {
      contactName: data.privacy_contact_name ?? null,
      contactEmail: data.privacy_contact_email ?? null,
      policyVersion: data.policy_version ?? '1',
      chatRetentionDays: data.chat_retention_days ?? 365,
      guestRetentionDays: data.guest_retention_days ?? 1095,
    },
  };
});
