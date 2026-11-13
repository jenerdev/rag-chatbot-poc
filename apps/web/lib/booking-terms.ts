// Audit E-4 (D-175): the terms a guest agrees to by sending a request, said
// on the Review step BEFORE Send, from the tenant's own payment policy
// (`page.payment`, D-105 to D-108). Pure, so it is tested
// (booking-terms.test.ts), and browser-safe.
//
// Words only, never an amount worked out here (customer-booking Rule 3):
// a deposit is "30% of the price" or the fixed amount the tenant set; what a
// given stay owes is stay_required()'s, on Manage booking. Every line says
// what the database will do: no refund tiers means change_terms() refunds
// 0%, and no reschedule cutoff means Manage booking takes no date change.

import { formatMoney } from './money';

export interface PaymentTerms {
  deposit: boolean;
  payWithinHours: number | null;
  reviewWithinHours: number | null;
  hold: 'none' | 'on_proof' | 'on_request';
  fee: { kind: 'full' } | { kind: 'fixed'; amount: number } | { kind: 'percent'; hundredths: number };
  cancellation: { daysBefore: number; refundPercent: number }[];
  rescheduleUntilDaysBefore: number | null;
}

export interface TermLine {
  title: string;
  text: string;
}

const hours = (h: number) => `${h} hour${h === 1 ? '' : 's'}`;
const days = (d: number) => `${d} day${d === 1 ? '' : 's'}`;
const percent = (hundredths: number) => `${Number((hundredths / 100).toFixed(2))}%`;
const back = (p: number) => (p >= 100 ? 'everything you paid back' : p <= 0 ? 'nothing back' : `${p}% of what you paid back`);

/** The refund tiers as sentences, most days first, ending with what is left (nothing) below the last tier. */
export function cancellationWords(tiers: PaymentTerms['cancellation']): string {
  if (tiers.length === 0) return 'Cancelling does not refund what you paid.';
  const sorted = [...tiers].sort((a, b) => b.daysBefore - a.daysBefore);
  const parts = sorted.map((t, i) => {
    if (i === 0) return t.daysBefore === 0 ? `Any time before check-in: ${back(t.refundPercent)}` : `${days(t.daysBefore)} or more before check-in: ${back(t.refundPercent)}`;
    const above = sorted[i - 1]!.daysBefore - 1;
    if (t.daysBefore === 0) return `Less than ${days(above + 1)}: ${back(t.refundPercent)}`;
    return t.daysBefore === above ? `${days(t.daysBefore)}: ${back(t.refundPercent)}` : `${t.daysBefore} to ${days(above)}: ${back(t.refundPercent)}`;
  });
  const last = sorted[sorted.length - 1]!;
  if (last.daysBefore > 0) parts.push(`Less than ${days(last.daysBefore)}: nothing back`);
  return `${parts.join('. ')}.`;
}

/** The Review step's "Before you send" lines. `pay` null: the tenant takes no payment on the page. */
export function bookingTerms(pay: PaymentTerms | null, businessName: string, currency: string): TermLine[] {
  if (!pay) {
    return [
      { title: 'Paying', text: `${businessName} contacts you about the price and how to pay, quoting your reference.` },
      { title: 'Your dates', text: `Nothing is held until ${businessName} confirms; until then someone else may book them.` },
    ];
  }
  const within = pay.payWithinHours ? ` within ${hours(pay.payWithinHours)} of sending this request` : '';
  const paying =
    pay.fee.kind === 'fixed'
      ? `A deposit of ${formatMoney(pay.fee.amount, currency)}${within}; the rest as Manage booking shows.`
      : pay.fee.kind === 'percent'
        ? `A deposit of ${percent(pay.fee.hundredths)} of the price${within}; the rest as Manage booking shows.`
        : `The full price${within}.`;
  const lines: TermLine[] = [
    { title: 'Paying', text: `${paying} You pay on Manage booking and send a photo of the receipt.` },
  ];
  if (pay.payWithinHours) {
    lines.push({ title: 'If it is not paid', text: `If nothing is paid within ${hours(pay.payWithinHours)}, the request expires and the dates go to others.` });
  }
  lines.push({
    title: 'Your dates',
    text:
      pay.hold === 'on_request'
        ? 'They are held for you while you pay.'
        : pay.hold === 'on_proof'
          ? 'They are held once you send your proof of payment; until then someone else may book them.'
          : `Nothing is held until ${businessName} confirms; until then someone else may book them.`,
  });
  lines.push({ title: 'Cancelling', text: cancellationWords(pay.cancellation) });
  lines.push({
    title: 'Changing dates',
    text:
      pay.rescheduleUntilDaysBefore === null
        ? `Contact ${businessName}.`
        : pay.rescheduleUntilDaysBefore === 0
          ? `Ask on Manage booking, up to check-in; ${businessName} decides.`
          : `Ask on Manage booking until ${days(pay.rescheduleUntilDaysBefore)} before check-in; ${businessName} decides.`,
  });
  return lines;
}
