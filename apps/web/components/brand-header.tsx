import type { ReactNode } from 'react';

/**
 * The tenant's header: an optional banner, then a logo (if any), the business
 * name, and the page's own buttons.
 *
 * The URLs have already been checked on the server: `loadBranding()` only
 * passes an absolute `https:` URL, and anything else arrives here as null.
 * The business name is a React child, so it is escaped like everything else
 * (CLAUDE.md § Conventions).
 *
 * A plain `<img>`, not `next/image`. next/image would need every tenant's
 * image host allowlisted in next.config, and these are arbitrary per-tenant
 * URLs.
 */
export function BrandHeader({
  businessName,
  logoUrl,
  bannerUrl,
  subtitle,
  children,
}: {
  businessName: string;
  logoUrl: string | null;
  bannerUrl: string | null;
  subtitle?: string;
  children: ReactNode;
}) {
  return (
    <>
      {bannerUrl && (
        // eslint-disable-next-line @next/next/no-img-element
        <img className="brand-banner" src={bannerUrl} alt="" />
      )}
      <header>
        <h1 className="brand">
          {logoUrl && (
            // eslint-disable-next-line @next/next/no-img-element
            <img className="brand-logo" src={logoUrl} alt="" />
          )}
          <span>{businessName}</span>
          {subtitle && <span className="brand-subtitle">{subtitle}</span>}
        </h1>
        <nav>{children}</nav>
      </header>
    </>
  );
}
