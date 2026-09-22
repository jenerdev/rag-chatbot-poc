import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { loadBranding } from '@/lib/branding';
import { getTenant } from '@/lib/tenant';

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
  const style = tenant ? (await loadBranding(tenant)).themeStyle : undefined;
  return (
    <div className="tenant-root" style={style}>
      {children}
    </div>
  );
}
