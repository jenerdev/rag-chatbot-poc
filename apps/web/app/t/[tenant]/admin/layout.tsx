import type { Metadata } from 'next';
import type { ReactNode } from 'react';

// The staff pages' extra <head> (plan/notifications.md § 2b.3): the tenant's
// web app manifest, so an iPhone can add the staff app to its Home Screen,
// which is the only way iOS allows Web Push. Nothing else: the tenant layout
// above draws the frame.

type Props = { children: ReactNode; params: Promise<{ tenant: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { tenant } = await params;
  return { manifest: `/t/${encodeURIComponent(tenant)}/manifest.webmanifest`, appleWebApp: { capable: true, statusBarStyle: 'default' } };
}

export default function AdminLayout({ children }: Props) {
  return children;
}
