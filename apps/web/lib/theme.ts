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

// --- contrast (plan/ui-refresh.md Rule 5, Phase 9) ---------------------------
//
// A tenant chooses its colours; the platform form says when they would make
// text hard to read, BEFORE they are saved. Advice, not a rule: Postgres
// still accepts any valid colour, and the tenant may know its audience.

/** The light defaults of app/styles/tokens.css: what an unset key falls back to. Keep in step with that file. */
export const LIGHT_DEFAULTS: Readonly<Record<ThemeKey, string>> = {
  accent: '#2563eb',
  accentSoft: '#eef3ff',
  bg: '#f7f7f8',
  panel: '#ffffff',
  ink: '#18181b',
};

/** WCAG 2 relative luminance of #rgb or #rrggbb. */
function luminance(hex: string): number {
  const h = hex.slice(1);
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const [r, g, b] = [0, 2, 4].map((i) => {
    const c = parseInt(full.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

/** The WCAG contrast ratio of two colours, 1 to 21. */
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

/**
 * The pairs a page actually draws, each against WCAG AA for body text
 * (4.5:1). One sentence per pair that falls short; [] when all pass. Unset
 * or invalid keys are judged at their default, as the page would draw them.
 */
export function contrastProblems(theme: Theme): string[] {
  const colour = (key: ThemeKey) => (isColour(theme[key]) ? theme[key]! : LIGHT_DEFAULTS[key]);
  const pairs: [string, string, string][] = [
    ['Text on the background', colour('ink'), colour('bg')],
    ['Text on the panels', colour('ink'), colour('panel')],
    ['White button text on the accent', '#ffffff', colour('accent')],
    ['Text on the soft accent', colour('ink'), colour('accentSoft')],
  ];
  return pairs
    .map(([what, a, b]) => ({ what, ratio: contrastRatio(a, b) }))
    .filter(({ ratio }) => ratio < 4.5)
    .map(({ what, ratio }) => `${what} is ${ratio.toFixed(1)}:1; 4.5:1 is the minimum for reading.`);
}
