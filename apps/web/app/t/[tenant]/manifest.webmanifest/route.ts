import { loadBranding } from '@/lib/branding';
import { LIGHT_DEFAULTS, THEME_KEYS } from '@/lib/theme';
import { withTenantRoute } from '@/lib/tenant';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The tenant's web app manifest (plan/notifications.md § 2b.3). iPhone gives
 * Web Push only to a site added to the Home Screen, and that needs a
 * manifest. It opens on the staff dashboard, inside /t/<slug>/ (the service
 * worker's scope), in the tenant's colours, with its logo when it has one.
 * Linked from the staff pages only (app/t/[tenant]/admin/layout.tsx): a
 * guest has no reason to install the staff app.
 */
export const GET = withTenantRoute(async (_request, { tenant }) => {
  const branding = await loadBranding(tenant);
  const colour = (key: keyof typeof THEME_KEYS) => (branding.themeStyle as Record<string, string | undefined>)[THEME_KEYS[key]] ?? LIGHT_DEFAULTS[key];
  const manifest = {
    name: `${branding.businessName} · Staff`,
    short_name: branding.businessName.length > 12 ? branding.businessName.slice(0, 12).trim() : branding.businessName,
    start_url: `/t/${tenant.slug}/admin/dashboard`,
    scope: `/t/${tenant.slug}/`,
    display: 'standalone',
    background_color: colour('bg'),
    theme_color: colour('accent'),
    ...(branding.logoUrl ? { icons: [{ src: branding.logoUrl, sizes: 'any', purpose: 'any' }] } : {}),
  };
  return new Response(JSON.stringify(manifest), { headers: { 'Content-Type': 'application/manifest+json', 'Cache-Control': 'no-cache' } });
});
