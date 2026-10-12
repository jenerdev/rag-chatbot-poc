// The price of a stay, night by night (D-111): drawn by the booking page
// (S-6) and the staff form on S-3, from the same RequestQuote, so a guest and
// a staff member see the same breakdown. Every figure is the server's; this
// file adds nothing up (customer-booking Rule 3).

import type { RequestQuote } from '@rag/bookings';
import { formatMoney } from '@/lib/money';

/** "Fri". Formatted as UTC because the date string has no zone; it is a calendar date. */
function weekday(date: string): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', timeZone: 'UTC' });
}

/**
 * A stay, night by night: each unit's rate, extra guests and holiday
 * surcharge, then the promo's discount (D-097) and the total. The lines'
 * prices are net of the discount already; the discount line says what came
 * off, so the figures add up as the server added them.
 */
export function StayLines({
  lines,
  currency,
  total,
  discount,
  promoName,
}: {
  lines: RequestQuote['lines'];
  currency: string;
  total: number;
  discount: number;
  promoName: string | null;
}) {
  const dates = [...new Set(lines.map((l) => l.date))];
  const multipleUnits = new Set(lines.map((l) => l.unitId)).size > 1;
  return (
    <div className="stay-lines">
      {dates.map((date, night) =>
        lines
          .filter((l) => l.date === date)
          .map((l) => {
            // One group per night (and room): the rate on the first line, each
            // addition or deduction on its own line under it, then the night's
            // total, the server's `price`, only when something was added.
            const extras = l.extraGuestPrice > 0 || l.surcharge > 0 || l.discount > 0;
            return (
              <div key={`${date}-${l.unitId}`} className="quote-night">
                <div className="quote-line">
                  {/* The dates are in Check-in / Check-out above: a night is named by its
                      number and weekday (weekday and weekend rates differ), not its date again. */}
                  <span>
                    {dates.length > 1 ? `Night ${night + 1} · ${weekday(date)}` : multipleUnits ? '' : 'Rate'}
                    {multipleUnits ? `${dates.length > 1 ? ' · ' : ''}${l.unit}` : ''}
                    {l.holiday && <span className="holiday-badge">{l.holiday}</span>}
                  </span>
                  <span>{formatMoney(l.basePrice, currency)}</span>
                </div>
                {l.extraGuestPrice > 0 && (
                  <div className="quote-line quote-sub">
                    <span>Extra guests</span>
                    <span>+{formatMoney(l.extraGuestPrice, currency)}</span>
                  </div>
                )}
                {l.surcharge > 0 && (
                  <div className="quote-line quote-sub">
                    <span>Holiday surcharge</span>
                    <span>+{formatMoney(l.surcharge, currency)}</span>
                  </div>
                )}
                {l.discount > 0 && (
                  <div className="quote-line quote-sub quote-discount">
                    <span>Promo</span>
                    <span>−{formatMoney(l.discount, currency)}</span>
                  </div>
                )}
                {extras && (
                  <div className="quote-line quote-sub quote-subtotal">
                    <span>{multipleUnits ? 'Room total' : 'Night total'}</span>
                    <span>{formatMoney(l.price, currency)}</span>
                  </div>
                )}
              </div>
            );
          }),
      )}
      {discount > 0 && (
        <div className="quote-line quote-discount">
          <span>{promoName ? `Promo: ${promoName}` : 'Promo discount'}</span>
          <span>−{formatMoney(discount, currency)}</span>
        </div>
      )}
      <div className="quote-line quote-total">
        <strong>Total</strong>
        <strong>{formatMoney(total, currency)}</strong>
      </div>
    </div>
  );
}
