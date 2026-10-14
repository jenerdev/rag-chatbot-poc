import type { Metadata } from 'next';
import Link from 'next/link';
import { LegalBody } from '@/components/legal-page';
import { PLATFORM, platformPrivacy } from '@/lib/legal';

// The platform's own privacy policy (D-129), linked from the landing page's
// footer. Static, like the landing page: no tenant, no data.

export const metadata: Metadata = { title: `${PLATFORM.product} · Privacy` };

export default function PlatformPrivacyPage() {
  return (
    <div className="legal-platform">
      <header className="legal-platform-head">
        <Link href="/" className="legal-home">
          {PLATFORM.product}
        </Link>
      </header>
      <main className="legal-main">
        <LegalBody doc={platformPrivacy()} />
      </main>
    </div>
  );
}
