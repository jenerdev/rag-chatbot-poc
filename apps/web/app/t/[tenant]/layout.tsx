import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { loadBranding } from '@/lib/branding';
import { getTenant } from '@/lib/tenant';
import { preconnect } from 'react-dom';
import { ENV } from '@/lib/env';
import { pinsLightScheme } from '@/lib/theme';

// The tenant's frame: its colours, and its name in the browser tab.
//
// A Server Component, so the branding lookup (and @rag/db, which is
// server-only) never reaches the client bundle. The theme is applied as CSS
// custom properties through React's `style` prop, which is escaped, and every
// value was validated against a colour regex in loadBranding(). There is no
// dangerouslySetInnerHTML anywhere in this path (plan.md § 2.4).
//
// An unknown slug is NOT handled here. The page below calls notFound(), so
// that app/t/[tenant]/not-found.tsx renders. A notFound() thrown from a layout
// skips its own segment's not-found file.

type Props = { children: ReactNode; params: Promise<{ tenant: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const tenant = await getTenant((await params).tenant);
  // A generic title for an unknown slug. The tab must not echo a slug back
  // as though it were a real workspace.
  return { title: tenant ? tenant.businessName : 'No such workspace' };
}

export default async function TenantLayout({ children, params }: Props) {
  const tenant = await getTenant((await params).tenant);
  // Every photo, logo and banner on a tenant page is fetched from Storage, so
  // the browser is told to open that connection (DNS, TCP, TLS) before the
  // first <img> asks, from the <head> React hoists this into (2026-10-21).
  // The host alone is sent: the URL is public already (it is in every image
  // URL), and no key goes with it (rule 2). Guarded, because a missing .env
  // must still render the page's one-line error, not throw on new URL('').
  if (ENV.SUPABASE_URL) preconnect(new URL(ENV.SUPABASE_URL).origin);
  const style = tenant ? (await loadBranding(tenant)).themeStyle : undefined;
  // A theme that sets a surface colour stays light in dark mode (D-101).
  return (
    <div className="tenant-root" data-scheme={pinsLightScheme(style) ? 'light' : undefined} style={style}>
      {children}
    </div>
  );
}
