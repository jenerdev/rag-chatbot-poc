import 'server-only';
import type { CSSProperties } from 'react';
import { z } from 'zod';
import { anonClient } from '@rag/db';
import type { TenantContext } from '@rag/pipeline';

// Per-tenant branding: server data becoming markup (plan.md § 2.4).
//
// The obvious implementation is
//     <style dangerouslySetInnerHTML={{ __html: `:root{--accent:${theme.accent}}` }} />
// which is CSS injection from a database column, and exactly what CLAUDE.md
// § Conventions forbids. Instead, the colours are set as CSS custom properties
// through React's ordinary `style` prop, which React escapes. On top of that,
// each value must pass a strict colour regex, so a string that is not a colour
// never reaches the page at all.

/**
 * The ONLY theme keys that exist. Each maps to a custom property that
 * globals.css already uses everywhere. That is why five keys are enough, and
 * why nothing here writes CSS rules, only variables.
 */
const THEME_KEYS = {
  accent: '--accent',
  accentSoft: '--accent-soft',
  bg: '--bg',
  panel: '--panel',
  ink: '--ink',
} as const;

/** #rgb or #rrggbb. Nothing else: no url(), no var(), no semicolons, no expressions. */
const colour = z.string().regex(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/);

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
  /** Ready for a `style` prop: only allowlisted custom properties, only valid colours. */
  themeStyle: CSSProperties;
}

/**
 * Turn the `theme` jsonb into custom properties.
 *
 * Unknown keys are ignored, and invalid values are DROPPED rather than
 * rejected, so a bad theme degrades to the default look instead of taking the
 * page down.
 */
export function themeVars(theme: unknown): CSSProperties {
  const style: Record<string, string> = {};
  if (theme === null || typeof theme !== 'object') return style;
  for (const [key, property] of Object.entries(THEME_KEYS)) {
    const parsed = colour.safeParse((theme as Record<string, unknown>)[key]);
    if (parsed.success) style[property] = parsed.data;
  }
  return style as CSSProperties;
}

/**
 * Load a tenant's branding, validated on READ as well as on write.
 *
 * Through `tenant_public(slug)`, the same function loadTenant() uses: no token
 * can read `tenants` directly (auth-rls Phase 1), and that function's column
 * list is the whole boundary: only public columns can reach a Client Component's props.
 */
export async function loadBranding(tenant: TenantContext): Promise<Branding> {
  const { data: rows, error } = await anonClient().rpc('tenant_public', { p_slug: tenant.slug });
  const data = rows?.[0];
  if (error || !data) throw new Error(`Could not load branding for "${tenant.slug}": ${error?.message ?? 'no such tenant'}`);

  return {
    businessName: tenant.businessName,
    assistantName: tenant.assistantName,
    logoUrl: httpsUrl(data.logo_url),
    bannerUrl: httpsUrl(data.banner_url),
    themeStyle: themeVars(data.theme),
  };
}
