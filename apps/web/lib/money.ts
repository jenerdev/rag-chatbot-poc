// money.ts — prices in the browser, which always arrive as CENTAVOS.
//
// Browser-safe (no server-only import), like limits.ts. Every amount in this
// app is a whole number of centavos from the database (plan/booking-types.md
// § 2.3). This file only turns one into text for a person, and a person's
// typed pesos back into centavos, with no float arithmetic in either
// direction: "3500.10" becomes 350010 by splitting the string, never by
// 3500.10 * 100, which is 350009.99999999994.

/** 350000 → "₱3,500.00" (in the tenant's currency). */
export function formatMoney(centavos: number, currency: string): string {
  // Dividing by 100 for DISPLAY is safe: the result is only formatted, never
  // stored or added up.
  return new Intl.NumberFormat('en-PH', { style: 'currency', currency }).format(centavos / 100);
}

/** 350000 → "3500.00", for an input the staff edit. */
export function centavosToInput(centavos: number): string {
  const whole = Math.floor(centavos / 100);
  const cents = String(centavos % 100).padStart(2, '0');
  return `${whole}.${cents}`;
}

/**
 * "3,500", "3500.5", "3500.50" → 350000, 350050, 350050. null for anything
 * else: negative, more than two decimals, letters, empty.
 */
export function parseMoneyInput(text: string): number | null {
  const cleaned = text.trim().replace(/,/g, '');
  const match = /^(\d{1,7})(?:\.(\d{1,2}))?$/.exec(cleaned);
  if (!match) return null;
  const whole = Number(match[1]);
  const cents = Number((match[2] ?? '').padEnd(2, '0'));
  return whole * 100 + cents;
}
