import { ImageResponse } from 'next/og';
import { createElement } from 'react';
import sharp from 'sharp';
import { loadBranding } from '@/lib/branding';
import { LIGHT_DEFAULTS, THEME_KEYS, contrastRatio } from '@/lib/theme';
import { withTenantRoute } from '@/lib/tenant';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The tenant's app icon, a PNG (D-146). The installed staff app had no icon:
 * the manifest named the logo only when the tenant had one, as `sizes: any`,
 * and a logo is a WebP of any shape (resize-image.ts makes it so), which
 * neither Android's installer nor iOS's Home Screen takes as an icon (they
 * want square PNGs, 192 and 512, and iOS its own 180 through
 * apple-touch-icon). This route always answers with a square PNG at the
 * asked size:
 *
 *   - with a logo: the logo fetched from its bucket and set by sharp on a
 *     square of the tenant's panel colour, 70 % of the side, so it sits inside
 *     the 40 % safe zone. sharp is Next's own image library, now declared on
 *     the web app too (the same copy; no new download). Next's renderer
 *     (next/og) was tried first and drew a WebP as a blank tile, silently.
 *   - without one, or when the logo cannot be fetched or decoded: the
 *     business's initial on its accent, the mark BrandMark draws
 *     (brand-header.tsx), through next/og, which draws text without a font
 *     file of ours.
 *
 * `?size=` is one of three, so a stranger cannot ask for a 10,000 px render,
 * and the logo fetch gives up after five seconds. Full-bleed, no rounded
 * corners: Android masks it (purpose maskable), iOS rounds it.
 */
const SIZES = new Set([180, 192, 512]);
const LOGO_FETCH_MS = 5000;

export const GET = withTenantRoute(async (request, { tenant }) => {
  const asked = Number(new URL(request.url).searchParams.get('size') ?? 512);
  const size = SIZES.has(asked) ? asked : 512;
  const branding = await loadBranding(tenant);
  const colour = (key: keyof typeof THEME_KEYS) => (branding.themeStyle as Record<string, string | undefined>)[THEME_KEYS[key]] ?? LIGHT_DEFAULTS[key];
  const headers = { 'Cache-Control': 'public, max-age=3600', 'Content-Type': 'image/png' };

  if (branding.logoUrl) {
    try {
      const fetched = await fetch(branding.logoUrl, { signal: AbortSignal.timeout(LOGO_FETCH_MS) });
      if (!fetched.ok) throw new Error(`logo fetch ${fetched.status}`);
      const side = Math.round(size * 0.7);
      const pad = Math.round((size - side) / 2);
      const logo = Buffer.from(await fetched.arrayBuffer());
      // The tile's colour is whichever of the theme's three the logo stands out from most: a cream
      // mark drawn for a dark banner vanishes on the white panel, a dark one on the dark accent.
      // The logo's colour is the mean of its VISIBLE pixels (alpha above half), on a 64 px copy:
      // sharp's own `dominant` counts the transparent ones, whose hidden RGB decided the tile.
      const { data, info } = await sharp(logo).resize(64, 64, { fit: 'inside' }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      let r = 0;
      let g = 0;
      let b = 0;
      let seen = 0;
      for (let i = 0; i < data.length; i += info.channels) {
        if (data[i + 3]! < 128) continue;
        r += data[i]!;
        g += data[i + 1]!;
        b += data[i + 2]!;
        seen++;
      }
      const meanHex = seen ? `#${[r, g, b].map((c) => Math.round(c / seen).toString(16).padStart(2, '0')).join('')}` : colour('ink');
      const background = ([colour('panel'), colour('accent'), colour('ink')] as const).reduce((best, candidate) => (contrastRatio(candidate, meanHex) > contrastRatio(best, meanHex) ? candidate : best));
      const png = await sharp(logo)
        .resize(side, side, { fit: 'contain', background })
        .flatten({ background })
        .extend({ top: pad, bottom: size - side - pad, left: pad, right: size - side - pad, background })
        .png()
        .toBuffer();
      // The tile's colour, named, for the walk (and for anyone wondering why it is dark).
      return new Response(new Uint8Array(png), { headers: { ...headers, 'X-App-Icon-Tile': `${background} for a logo of ${meanHex}` } });
    } catch (error) {
      console.warn(`[app-icon] ${tenant.slug}: the logo could not be drawn, using the initial:`, error instanceof Error ? error.message : error);
    }
  }

  const initial = branding.businessName.trim().charAt(0).toUpperCase() || '·';
  const tile = createElement(
    'div',
    { style: { width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: colour('accent') } },
    createElement('div', { style: { display: 'flex', color: '#ffffff', fontSize: Math.round(size * 0.56), fontWeight: 700 } }, initial),
  );
  const bytes = await new ImageResponse(tile, { width: size, height: size }).arrayBuffer();
  return new Response(bytes, { headers });
});
