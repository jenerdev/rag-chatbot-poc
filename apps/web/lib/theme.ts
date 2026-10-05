// theme.ts — the tenant theme's shape, shared by the page that READS it and the
// form that WRITES it (plan/tenant-management.md § 2.5).
//
// Pure, like limits.ts and money.ts: no imports, no `server-only`, so the
// platform form (a Client Component) validates a colour as the person types
// it, with the SAME regex the server applies again on write and the SAME one
// Postgres applies in tenants_theme_shape (sql/schema-roles.sql § 4). Three
// copies of one rule, and this file is the one the other two are checked
// against.
//
// Why so strict: a theme value becomes a CSS custom property on the page.
// React's `style` prop escapes it, but the allowlist below is what makes the
// escaping unnecessary in the first place: #rgb or #rrggbb, nothing else. No
// url(), no var(), no semicolons, no expressions (plan.md § 2.4, D-030).

import type { CSSProperties } from 'react';

/**
 * The ONLY theme keys that exist. Each maps to a custom property that
 * the stylesheets already use everywhere, and every other colour (hover,
 * border, focus ring, the status tints) is MIXED from these in
 * app/styles/tokens.css (plan/ui-refresh.md Rule 2). That is why five keys
 * are enough, and why nothing here writes CSS rules, only variables.
 */
export const THEME_KEYS = {
  accent: '--accent',
  accentSoft: '--accent-soft',
  bg: '--bg',
  panel: '--panel',
  ink: '--ink',
} as const;
export type ThemeKey = keyof typeof THEME_KEYS;
export const THEME_KEY_LIST = Object.keys(THEME_KEYS) as ThemeKey[];

/** What people see beside each colour on the form. */
export const THEME_LABELS: Readonly<Record<ThemeKey, string>> = {
  accent: 'Accent',
  accentSoft: 'Accent, soft',
  bg: 'Background',
  panel: 'Panel',
  ink: 'Text',
};

/** #rgb or #rrggbb. The one regex; tenants_theme_shape carries the same. */
export const COLOUR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
export const isColour = (value: unknown): value is string => typeof value === 'string' && COLOUR.test(value);

/** A theme as the form holds it: only known keys, only colours. */
export type Theme = Partial<Record<ThemeKey, string>>;

/**
 * Turn the `theme` jsonb into custom properties for a `style` prop.
 *
 * Unknown keys are ignored, and invalid values are DROPPED rather than
 * rejected, so a bad theme degrades to the default look instead of taking the
 * page down. (Since schema-roles.sql a bad value cannot be stored at all; this
 * stays as the read-side wall.)
 */
export function themeVars(theme: unknown): CSSProperties {
  const style: Record<string, string> = {};
  if (theme === null || typeof theme !== 'object') return style;
  for (const key of THEME_KEY_LIST) {
    const value = (theme as Record<string, unknown>)[key];
    if (isColour(value)) style[THEME_KEYS[key]] = value;
  }
  return style as CSSProperties;
}

/**
 * The keys that paint a SURFACE. A theme that sets any of them was chosen for
 * a light page, so that page stays light when the system is dark: half a dark
 * palette under a light background would be unreadable (D-101). A theme that
 * sets the accent alone follows the system.
 */
const SURFACE_PROPERTIES = [THEME_KEYS.bg, THEME_KEYS.panel, THEME_KEYS.ink, THEME_KEYS.accentSoft];

/** True when themeVars()'s result must pin the light scheme (data-scheme="light"). */
export function pinsLightScheme(style: CSSProperties | undefined): boolean {
  if (!style) return false;
  return SURFACE_PROPERTIES.some((property) => property in style);
}

/**
 * The form's half: keep only known keys with valid colours, and say which
 * were wrong, so the person can fix them before the server refuses.
 */
export function parseTheme(input: unknown): { theme: Theme; problems: string[] } {
  const theme: Theme = {};
  const problems: string[] = [];
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return { theme, problems: ['The theme must be an object.'] };
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (!(key in THEME_KEYS)) problems.push(`Unknown theme key "${key}".`);
    else if (value === '' || value === undefined || value === null) continue; // an emptied field: the default colour
    else if (!isColour(value)) problems.push(`${THEME_LABELS[key as ThemeKey]} must be a colour like #0f766e or #fff.`);
    else theme[key as ThemeKey] = value;
  }
  return { theme, problems };
}
