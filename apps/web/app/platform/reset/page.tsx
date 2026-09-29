import type { Metadata } from 'next';
import Link from 'next/link';
import { ResetPassword } from '@/components/reset-password';

// Where a super user's invite or password-reset email lands (tenant
// management Phase 5). Until this page existed, a new super address set its
// password through a tenant's reset page with the fragment kept (status.md,
// 2026-09-29). The proof is in the link's #fragment, read by the Client
// Component; the POST goes to /api/platform/password.

export const metadata: Metadata = { title: 'Platform · set a password' };
export const dynamic = 'force-dynamic';

export default function PlatformResetPage() {
  return (
    <>
      <header>
        <h1 className="brand">
          <span>Platform</span>
          <span className="brand-subtitle">Set a password</span>
        </h1>
        <nav>
          <Link className="button" href="/platform">
            ← Platform login
          </Link>
        </nav>
      </header>
      <main>
        <ResetPassword api="/api/platform/password" loginHref="/platform" />
      </main>
    </>
  );
}
