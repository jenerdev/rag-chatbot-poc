/**
 * A tenant's mark on the platform pages: its logo when it has one, else the
 * first letter of its name, in the same square either way, so the list's
 * rows stay in line. The logo sits on a white tile and is contained, never
 * cropped: logos come in every shape.
 *
 * The URL is the row's own, which Postgres holds to https
 * (tenants_urls_https); an <img>, not next/image, for the reason
 * brand-header.tsx gives. Decorative: the business's name is always beside it.
 */
export function TenantMark({ businessName, logoUrl, size = 'md' }: { businessName: string; logoUrl: string | null; size?: 'md' | 'lg' }) {
  if (logoUrl) {
    return (
      <span className={`tenant-mark has-logo ${size}`} aria-hidden="true">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={logoUrl} alt="" />
      </span>
    );
  }
  return (
    <span className={`tenant-mark ${size}`} aria-hidden="true">
      {businessName.trim().charAt(0).toUpperCase() || '·'}
    </span>
  );
}
