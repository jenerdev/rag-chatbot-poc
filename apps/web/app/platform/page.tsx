import type { Metadata } from 'next';
import { PlatformScreen } from '@/components/platform-screen';

// The platform (plan/tenant-management.md § 4.3): where a super user creates,
// edits and archives tenants. NOT linked from the root page, which lists no
// tenants (plan.md Phase 7); it is reached by being given the address, and it
// is a login form until it is not. The page holds nothing: every read and
// write goes through /api/platform/*, each on the platform token.

export const metadata: Metadata = { title: 'Platform' };
export const dynamic = 'force-dynamic';

export default function PlatformPage() {
  return <PlatformScreen />;
}
