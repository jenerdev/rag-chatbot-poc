// percent.ts — a percentage as typed ↔ hundredths of a percent, by string,
// never × 100 (plan/promos.md § 2.1). Shared by the Promos screen and the
// Payments screen's fee. Browser-safe: no imports.

/**
 * "12.5" → 1250, "10" → 1000, "0.25" → 25: hundredths of a percent, by
 * string. null for anything else (more than two decimals, letters, over 100).
 */
export function parsePercentInput(text: string): number | null {
  const match = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(text.trim());
  if (!match) return null;
  const whole = Number(match[1]);
  const frac = (match[2] ?? '').padEnd(2, '0');
  const value = whole * 100 + Number(frac);
  return value > 0 && value <= 10000 ? value : null;
}

/** 1250 → "12.5", 1000 → "10". */
export function percentToInput(value: number): string {
  const whole = Math.floor(value / 100);
  const frac = value % 100;
  return frac === 0 ? String(whole) : `${whole}.${String(frac).padStart(2, '0').replace(/0$/, '')}`;
}
