import type { ReactNode } from 'react';

/**
 * The tenant's header (plan/public-brand.md): the logo, or a monogram of the
 * business's initial in its accent when there is none, the business name,
 * and the page's own buttons, under a thin stripe of the accent.
 *
 * With `hero` (the booking page and Manage booking), the header sits INSIDE
 * a branded band: the tenant's banner image under a darkening overlay, or,
 * with no banner, a gradient of its accent. The business name is set large
 * there, with a line saying what the page is for (`hero`), so the header's
 * own name gives way to it. Without `hero` (the chat, signed-out staff
 * pages), the banner is a slim strip above the header, as before.
 *
 * The URLs have already been checked on the server: `loadBranding()` only
 * passes an absolute `https:` URL, and anything else arrives here as null.
 * The banner is an <img>, never a CSS url() built from the string. The
 * business name is a React child, so it is escaped like everything else
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
  hero,
  children,
}: {
  businessName: string;
  logoUrl: string | null;
  bannerUrl: string | null;
  subtitle?: string;
  /** The band's line above the name, e.g. "Online booking". Set, the header is drawn inside the band. */
  hero?: string;
  children: ReactNode;
}) {
  const header = (
    <header className={hero ? 'public-header on-hero' : 'public-header'}>
      <h1 className="brand">
        <BrandMark businessName={businessName} logoUrl={logoUrl} />
        <span className={hero ? 'brand-name visually-hidden' : 'brand-name'}>{businessName}</span>
        {subtitle && <span className="brand-subtitle">{subtitle}</span>}
      </h1>
      <nav>{children}</nav>
    </header>
  );

  if (hero) {
    return (
      <div className={bannerUrl ? 'public-hero has-image' : 'public-hero'}>
        {bannerUrl && (
          // eslint-disable-next-line @next/next/no-img-element
          <img className="hero-image" src={bannerUrl} alt="" />
        )}
        {header}
        <div className="hero-body" aria-hidden="true">
          <span className="hero-eyebrow">{hero}</span>
          <span className="hero-name">{businessName}</span>
        </div>
      </div>
    );
  }

  return (
    <>
      {bannerUrl && (
        // eslint-disable-next-line @next/next/no-img-element
        <img className="brand-banner" src={bannerUrl} alt="" />
      )}
      {header}
    </>
  );
}

/** The logo, or the business's initial on its accent: every public page has a mark. */
export function BrandMark({ businessName, logoUrl, size = 'sm' }: { businessName: string; logoUrl: string | null; size?: 'sm' | 'lg' }) {
  if (logoUrl) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img className={`brand-logo ${size}`} src={logoUrl} alt="" />;
  }
  const initial = businessName.trim().charAt(0).toUpperCase() || '·';
  return (
    <span className={`brand-monogram ${size}`} aria-hidden="true">
      {initial}
    </span>
  );
}
