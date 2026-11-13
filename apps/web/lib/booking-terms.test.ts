import { describe, expect, it } from 'vitest';
import { bookingTerms, cancellationWords, type PaymentTerms } from './booking-terms';

// Audit E-4 (D-175).
const base: PaymentTerms = {
  deposit: false,
  payWithinHours: 24,
  reviewWithinHours: 24,
  hold: 'none',
  fee: { kind: 'full' },
  cancellation: [],
  rescheduleUntilDaysBefore: null,
};
const text = (lines: { title: string; text: string }[], title: string) => lines.find((l) => l.title === title)?.text;

describe('cancellationWords', () => {
  it('says plainly that nothing is refunded when the tenant set no tiers (change_terms() refunds 0%)', () => {
    expect(cancellationWords([])).toBe('Cancelling does not refund what you paid.');
  });
  it('reads the tiers most days first, with the gap below the last one', () => {
    expect(cancellationWords([{ daysBefore: 2, refundPercent: 50 }, { daysBefore: 7, refundPercent: 100 }])).toBe(
      '7 days or more before check-in: everything you paid back. 2 to 6 days: 50% of what you paid back. Less than 2 days: nothing back.',
    );
  });
  it('handles adjacent tiers, a tier at 0 days, and a single 0-day tier', () => {
    expect(cancellationWords([{ daysBefore: 3, refundPercent: 100 }, { daysBefore: 2, refundPercent: 50 }])).toBe(
      '3 days or more before check-in: everything you paid back. 2 days: 50% of what you paid back. Less than 2 days: nothing back.',
    );
    expect(cancellationWords([{ daysBefore: 5, refundPercent: 100 }, { daysBefore: 0, refundPercent: 20 }])).toBe(
      '5 days or more before check-in: everything you paid back. Less than 5 days: 20% of what you paid back.',
    );
    expect(cancellationWords([{ daysBefore: 0, refundPercent: 100 }])).toBe('Any time before check-in: everything you paid back.');
  });
});

describe('bookingTerms', () => {
  it('the full price within a window, its expiry, nothing held, no refund, ask to change dates', () => {
    const lines = bookingTerms(base, 'Villa Amihan', 'PHP');
    expect(lines.map((l) => l.title)).toEqual(['Paying', 'If it is not paid', 'Your dates', 'Cancelling', 'Changing dates']);
    expect(text(lines, 'Paying')).toMatch(/^The full price within 24 hours of sending this request\./);
    expect(text(lines, 'If it is not paid')).toBe('If nothing is paid within 24 hours, the request expires and the dates go to others.');
    expect(text(lines, 'Cancelling')).toBe('Cancelling does not refund what you paid.');
    expect(text(lines, 'Changing dates')).toBe('Contact Villa Amihan.');
  });
  it('a fixed or a percentage deposit, as the rule the tenant set, never a worked-out amount', () => {
    expect(text(bookingTerms({ ...base, fee: { kind: 'fixed', amount: 200000 } }, 'X', 'PHP'), 'Paying')).toMatch(/^A deposit of ₱2,000\.00 within 24 hours/);
    expect(text(bookingTerms({ ...base, fee: { kind: 'percent', hundredths: 3000 } }, 'X', 'PHP'), 'Paying')).toMatch(/^A deposit of 30% of the price within 24 hours/);
    expect(text(bookingTerms({ ...base, fee: { kind: 'percent', hundredths: 3333 } }, 'X', 'PHP'), 'Paying')).toMatch(/33\.33% of the price/);
  });
  it('no deadline: no expiry line; the holds; the reschedule cutoff', () => {
    const lines = bookingTerms({ ...base, payWithinHours: null, hold: 'on_request', rescheduleUntilDaysBefore: 3 }, 'X', 'PHP');
    expect(text(lines, 'If it is not paid')).toBeUndefined();
    expect(text(lines, 'Your dates')).toBe('They are held for you while you pay.');
    expect(text(lines, 'Changing dates')).toBe('Ask on Manage booking until 3 days before check-in; X decides.');
  });
  it('no payment on the page: the resort contacts the guest', () => {
    expect(bookingTerms(null, 'Villa Amihan', 'PHP').map((l) => l.title)).toEqual(['Paying', 'Your dates']);
  });
});
