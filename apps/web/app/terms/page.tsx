import type { Metadata } from 'next';
import Link from 'next/link';
import { LegalBody } from '@/components/legal-page';
import { PLATFORM, platformTerms } from '@/lib/legal';

// The platform's own terms of use (D-129), linked from the landing page's
// footer. Static: no tenant, no data.

export const metadata: Metadata = { title: `${PLATFORM.product} · Terms` };

export default function PlatformTermsPage() {
  return (
    <div className="legal-platform">
      <header className="legal-platform-head">
        <Link href="/" className="legal-home">
          {PLATFORM.product}
        </Link>
      </header>
      <main className="legal-main">
        <LegalBody doc={platformTerms()} />
      </main>
    </div>
  );
}
