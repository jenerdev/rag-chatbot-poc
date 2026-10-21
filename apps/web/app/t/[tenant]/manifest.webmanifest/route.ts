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
    // D-146: square PNGs from our own route, always, whatever the tenant's logo is (a WebP of any
    // shape is not an installer's icon). The same 512 serves `maskable`: it is full-bleed with the
    // mark inside the safe zone, so Android's mask cuts nothing that matters.
    icons: [
      { src: `/t/${tenant.slug}/app-icon.png?size=192`, sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: `/t/${tenant.slug}/app-icon.png?size=512`, sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: `/t/${tenant.slug}/app-icon.png?size=512`, sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
  return new Response(JSON.stringify(manifest), { headers: { 'Content-Type': 'application/manifest+json', 'Cache-Control': 'no-cache' } });
});
