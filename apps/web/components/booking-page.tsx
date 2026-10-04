'use client';

// S-6 · the customer booking page (plan/customer-booking.md). PUBLIC: a
// customer picks a slot, a date (and, for an overnight slot, how many nights),
// what to book and for how many guests, sees the server's price, and sends a
// REQUEST with their name, mobile number and email.
//
// What this screen does NOT do:
//   - price anything. Every amount is the server's: the quote before, the
//     stored rows after (plan Rule 3). There is no arithmetic on money here;
//   - decide availability. The quote says whether a night is already
//     confirmed, and the server refuses a request for one (409);
//   - hold a date. A request holds nothing until the resort confirms it
//     (D-070), and the page says so, before and after sending.
//
// Everything the server sends is a React child, so it is escaped, including
// the tenant's own instructions text (CLAUDE.md § Conventions).

import { useEffect, useMemo, useState } from 'react';
import type { BookingPage, RequestQuote, RequestReceipt } from '@rag/bookings';
import { BrandHeader } from '@/components/brand-header';
import { TenantNav } from '@/components/tenant-nav';
import type { NavFeatures } from '@/lib/nav-items';
import { formatMoney } from '@/lib/money';

export interface BookingPageScreenProps {
  slug: string;
  businessName: string;
  logoUrl: string | null;
  bannerUrl: string | null;
  page: BookingPage;
  /** What the tenant has, for the header's links (lib/nav.ts). */
  nav: NavFeatures;
}

/** YYYY-MM-DD plus n days, on UTC midnights, so no DST edge shifts the date. */
function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** "Thu 12 Nov 2026". A calendar date, formatted as UTC because it has no zone. */
function dateLabel(date: string): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/** "14:00" → "2:00 PM". */
function timeLabel(hhmm: string): string {
  const [h, m] = hhmm.split(':').map(Number);
  const hour = ((h! + 11) % 12) + 1;
  return `${hour}:${String(m).padStart(2, '0')} ${h! < 12 ? 'AM' : 'PM'}`;
}

/**
 * When a slot that starts at `start` and lasts `duration` ends: how many days
 * later, and at what wall-clock time. Durations come from Postgres as
 * "22:00:00" or "1 day 02:00:00". Only for DISPLAY: the stored booking's
 * `during` is computed in SQL (slot_range), and the receipt shows that.
 */
function slotEnd(start: string, duration: string): { days: number; time: string } | null {
  const match = /^(?:(\d+) days? )?(\d{2}):(\d{2}):\d{2}$/.exec(duration);
  if (!match) return null;
  const [sh, sm] = start.split(':').map(Number);
  const total = sh! * 60 + sm! + Number(match[1] ?? 0) * 1440 + Number(match[2]) * 60 + Number(match[3]);
  const minutes = total % 1440;
  return { days: Math.floor(total / 1440), time: `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}` };
}

/** An ISO instant, shown in the tenant's timezone. */
function instantLabel(iso: string, timezone: string): string {
  return new Date(iso).toLocaleString('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: timezone,
  });
}

type Sent = { receipt: RequestReceipt } | null;

export function BookingPageScreen({ slug, businessName, logoUrl, bannerUrl, page, nav }: BookingPageScreenProps) {
  const api = `/api/t/${slug}`;
  const perRoom = page.bookingType === 'per_room';

  // An overnight slot first: it is the one a stay is made of.
  const [slotId, setSlotId] = useState<number>(() => (page.slots.find((s) => s.nightly) ?? page.slots[0])!.id);
  const slot = page.slots.find((s) => s.id === slotId)!;
  const [checkIn, setCheckIn] = useState('');
  const [nights, setNights] = useState('1');
  // whole_resort: one unit, one guest count. per_room: ticked rooms, each with its own.
  const [guests, setGuests] = useState('');
  const [chosen, setChosen] = useState<Record<number, string>>({});
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [notes, setNotes] = useState('');
  // The honeypot (plan § 2.1): hidden from people, so only a bot fills it.
  const [website, setWebsite] = useState('');
  // D-097: a promo code, sent with the quote (which says whether it applies,
  // in words) and with the request (which resolves it again under the lock).
  const [promoCode, setPromoCode] = useState('');

  const [quote, setQuote] = useState<{ quote: RequestQuote | null; message: string | null }>({ quote: null, message: null });
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<Sent>(null);

  // Only units priced for this slot are offered. Memoised: `rooms` below
  // depends on it, and the quote effect on `rooms`, so a new array every
  // render would re-ask the server on every render.
  const units = useMemo(() => page.units.filter((u) => u.rates.some((r) => r.slotId === slotId)), [page.units, slotId]);
  const nightCount = slot.nightly ? Number(nights) : 1;

  const rooms = useMemo(() => {
    if (!perRoom) {
      const unit = units[0];
      return unit && guests !== '' ? [{ unitId: unit.id, guests: Number(guests) }] : [];
    }
    return Object.entries(chosen)
      .filter(([id]) => units.some((u) => u.id === Number(id)))
      .map(([id, g]) => ({ unitId: Number(id), guests: g === '' ? NaN : Number(g) }));
  }, [chosen, guests, perRoom, units]);
  const roomsComplete = rooms.length > 0 && rooms.every((r) => Number.isInteger(r.guests) && r.guests > 0);
  const nightsValid = Number.isInteger(nightCount) && nightCount >= 1 && nightCount <= page.maxNights;
  // Closed dates (D-080), from the calendar the page already has. Said up
  // front, and again when the stay touches one; the server refuses it anyway.
  const closedDays = useMemo(() => page.calendar.filter((c) => c.kind === 'closed'), [page.calendar]);
  const closedInStay =
    checkIn && nightsValid
      ? closedDays.find((c) => c.day >= checkIn && c.day <= addDays(checkIn, nightCount - 1)) ?? null
      : null;

  // The server's price, re-asked whenever the choice changes (debounced).
  useEffect(() => {
    if (!checkIn || !roomsComplete || !nightsValid) {
      setQuote({ quote: null, message: null });
      return;
    }
    let stale = false;
    const timer = setTimeout(async () => {
      try {
        const response = await fetch(`${api}/book/quote`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ slotId, rooms, checkIn, nights: nightCount, promoCode: promoCode.trim() || null }),
        });
        const body = await response.json().catch(() => null);
        if (stale) return;
        if (!response.ok) setQuote({ quote: null, message: body?.error ?? 'Could not get a price.' });
        else setQuote({ quote: body as RequestQuote, message: null });
      } catch {
        if (!stale) setQuote({ quote: null, message: 'Could not reach the server.' });
      }
    }, 300);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [api, checkIn, nightCount, nightsValid, promoCode, rooms, roomsComplete, slotId]);

  const end = slotEnd(slot.startTime, slot.duration);
  const checkOut = checkIn && end && nightsValid ? addDays(checkIn, nightCount - 1 + end.days) : null;

  async function send(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setSending(true);
    try {
      const response = await fetch(`${api}/book/request`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slotId, rooms, checkIn, nights: nightCount, name, phone, email, notes: notes || null, website, promoCode: promoCode.trim() || null }),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        setError(body?.error ?? `The request could not be sent (${response.status}).`);
        return;
      }
      setSent({ receipt: body as RequestReceipt });
      window.scrollTo({ top: 0 });
    } catch {
      setError('Could not reach the server. Please try again.');
    } finally {
      setSending(false);
    }
  }

  function startOver() {
    setSent(null);
    setCheckIn('');
    setNights('1');
    setGuests('');
    setChosen({});
    setNotes('');
    setQuote({ quote: null, message: null });
  }

  const header = (
    <BrandHeader businessName={businessName} logoUrl={logoUrl} bannerUrl={bannerUrl} subtitle="Book">
      <TenantNav slug={slug} features={nav} current="book" />
    </BrandHeader>
  );

  // After sending: the receipt, from the STORED rows.
  if (sent) {
    const r = sent.receipt;
    return (
      <>
        {header}
        <main>
          <section className="card receipt">
            <h2>Request sent</h2>
            <p>
              Your reference is <strong className="reference">{r.reference}</strong>. Keep it: the resort will use it when they
              contact you.
            </p>
            <p className="notice">
              <strong>This is a request, not a confirmation.</strong> The date is yours once {businessName} confirms it. Until
              then, someone else may book it.
            </p>
            <div className="stay-summary">
              <div>
                {r.slot}
                {r.nights > 1 ? ` · ${r.nights + 1} days, ${r.nights} nights` : ''}
              </div>
              <div className="small muted">
                From {instantLabel(r.startsAt, page.timezone)} to {instantLabel(r.endsAt, page.timezone)}
              </div>
            </div>
            <Lines lines={r.lines} currency={r.currency} total={r.total} discount={r.discount} promoName={null} />
            {r.instructions && (
              <>
                <h3>What happens next</h3>
                <div className="instructions">{r.instructions}</div>
              </>
            )}
            <div className="form-footer">
              <button type="button" onClick={startOver}>
                Make another request
              </button>
            </div>
          </section>
        </main>
      </>
    );
  }

  return (
    <>
      {header}
      <main>
        <section className="card">
          <h2>Request a booking</h2>
          <p className="small muted">
            Choose a date and see the price. Sending a request does not book the date: {businessName} confirms it and
            contacts you.
          </p>

          <form onSubmit={send}>
            <div className="field-row">
              {page.slots.length > 1 && (
                <div className="field">
                  <label htmlFor="slot">What</label>
                  <select id="slot" value={slotId} onChange={(e) => setSlotId(Number(e.target.value))}>
                    {page.slots.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name} — from {timeLabel(s.startTime)}
                      </option>
                    ))}
                  </select>
                </div>
              )}
              <div className="field">
                <label htmlFor="check-in">{slot.nightly ? 'Check-in date' : 'Date'}</label>
                <input
                  type="date"
                  id="check-in"
                  required
                  min={page.today}
                  max={page.lastDate}
                  value={checkIn}
                  onChange={(e) => setCheckIn(e.target.value)}
                />
                {/* The tenant's booking horizon, said up front, and again the moment it is passed. */}
                <div className={`small${checkIn > page.lastDate ? ' field-error' : ' muted'}`}>
                  {checkIn > page.lastDate ? 'Too far ahead: the latest is' : 'Up to'} {dateLabel(page.lastDate)}
                </div>
                {closedInStay && (
                  <div className="small field-error">
                    Closed on {dateLabel(closedInStay.day)} ({closedInStay.label}). Choose other dates.
                  </div>
                )}
              </div>
              {slot.nightly && (
                <div className="field narrow">
                  <label htmlFor="nights">Nights</label>
                  <input
                    type="number"
                    id="nights"
                    min={1}
                    max={page.maxNights}
                    step={1}
                    required
                    value={nights}
                    onChange={(e) => setNights(e.target.value)}
                  />
                  {/* The tenant's max stay, said up front, and again the moment it is passed. */}
                  <div className={`small${nightCount > page.maxNights ? ' field-error' : ' muted'}`}>
                    {nightCount > page.maxNights ? 'At most' : 'Up to'} {page.maxNights} night{page.maxNights === 1 ? '' : 's'}
                  </div>
                </div>
              )}
              {!perRoom && (
                <div className="field narrow">
                  <label htmlFor="guests">Guests</label>
                  <input
                    type="number"
                    id="guests"
                    min={1}
                    max={units[0]?.capacity ?? undefined}
                    step={1}
                    required
                    value={guests}
                    onChange={(e) => setGuests(e.target.value)}
                  />
                </div>
              )}
            </div>

            {closedDays.length > 0 && (
              <div className="small muted">
                Closed on {closedDays.slice(0, 6).map((c) => dateLabel(c.day)).join(', ')}
                {closedDays.length > 6 ? `, and ${closedDays.length - 6} more date${closedDays.length === 7 ? '' : 's'}` : ''}.
              </div>
            )}
            {checkIn && end && nightsValid && (
              <div className="small muted stay-line">
                {slot.nightly && nightCount > 1 ? `${nightCount + 1} days, ${nightCount} nights · ` : ''}
                {dateLabel(checkIn)}, {timeLabel(slot.startTime)} to {checkOut ? dateLabel(checkOut) : ''}, {timeLabel(end.time)}
              </div>
            )}
            {!perRoom && units[0] && (
              <div className="small muted">
                {units[0].standardCapacity !== null && units[0].extraPersonRate
                  ? `The rate covers ${units[0].standardCapacity} guests; each guest above that is ${formatMoney(units[0].extraPersonRate, page.currency)}. `
                  : ''}
                {units[0].capacity !== null ? `At most ${units[0].capacity} guests. ` : ''}
                {page.guestHint ?? ''}
              </div>
            )}

            {perRoom && (
              <div className="field">
                <label>Rooms</label>
                {page.guestHint && <div className="small muted">{page.guestHint}</div>}
                <div className="room-picks">
                  {units.map((u) => {
                    const picked = chosen[u.id] !== undefined;
                    return (
                      <div key={u.id} className={`room-pick${picked ? ' picked' : ''}`}>
                        <label>
                          <input
                            type="checkbox"
                            checked={picked}
                            onChange={(e) =>
                              setChosen((current) => {
                                const next = { ...current };
                                if (e.target.checked) next[u.id] = '';
                                else delete next[u.id];
                                return next;
                              })
                            }
                          />{' '}
                          {u.name}
                          {u.capacity !== null && <span className="muted"> · up to {u.capacity}</span>}
                          {u.standardCapacity !== null && u.extraPersonRate ? (
                            <span className="muted">
                              {' '}
                              · {u.standardCapacity} included, +{formatMoney(u.extraPersonRate, page.currency)} each extra
                            </span>
                          ) : null}
                          {u.description && <span className="room-description">{u.description}</span>}
                        </label>
                        {picked && (
                          <input
                            type="number"
                            min={1}
                            max={u.capacity ?? undefined}
                            step={1}
                            placeholder="guests"
                            aria-label={`Guests in ${u.name}`}
                            value={chosen[u.id]}
                            onChange={(e) => setChosen((current) => ({ ...current, [u.id]: e.target.value }))}
                          />
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {(quote.quote || quote.message) && (
              <div className={`quote${quote.message || (quote.quote && !quote.quote.available) ? ' error' : ''}`}>
                {quote.quote ? (
                  <>
                    {!quote.quote.available && (
                      <div className="quote-warning">
                        A night in this stay is already booked. Please choose other dates.
                      </div>
                    )}
                    <Lines
                      lines={quote.quote.lines}
                      currency={quote.quote.currency}
                      total={quote.quote.total}
                      discount={quote.quote.discount}
                      promoName={quote.quote.promo?.name ?? null}
                    />
                    {/* A typed code that did not apply: the server's words, the price unchanged (D-097). */}
                    {quote.quote.promoMessage && <div className="quote-warning">{quote.quote.promoMessage}</div>}
                  </>
                ) : (
                  quote.message
                )}
              </div>
            )}

            <h3>Your details</h3>
            <div className="field-row">
              <div className="field grow">
                <label htmlFor="name">Name</label>
                <input type="text" id="name" required autoComplete="name" maxLength={100} value={name} onChange={(e) => setName(e.target.value)} />
              </div>
              <div className="field">
                <label htmlFor="phone">Mobile number</label>
                <input
                  type="tel"
                  id="phone"
                  required
                  autoComplete="tel"
                  placeholder="0917 123 4567"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                />
              </div>
              <div className="field grow">
                <label htmlFor="email">Email</label>
                <input type="email" id="email" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
              </div>
            </div>
            <div className="field-row">
              <div className="field grow">
                <label htmlFor="notes">
                  Notes <span className="muted">(optional)</span>
                </label>
                <input type="text" id="notes" maxLength={1000} value={notes} onChange={(e) => setNotes(e.target.value)} />
              </div>
              <div className="field">
                <label htmlFor="promo-code">
                  Promo code <span className="muted">(optional)</span>
                </label>
                {/* The quote above answers it as you type: the discount line, or why it does not apply. */}
                <input type="text" id="promo-code" maxLength={32} autoComplete="off" placeholder="SUMMER10" value={promoCode} onChange={(e) => setPromoCode(e.target.value)} />
              </div>
            </div>
            {/* The honeypot: off-screen, not tabbable, not announced. */}
            <div className="honeypot" aria-hidden="true">
              <label htmlFor="website">Website</label>
              <input type="text" id="website" tabIndex={-1} autoComplete="off" value={website} onChange={(e) => setWebsite(e.target.value)} />
            </div>

            {error && <div className="notice error">{error}</div>}

            <div className="form-footer">
              <span className="small muted">Times are in {page.timezone}.</span>
              <button
                type="submit"
                className="primary"
                disabled={sending || !quote.quote || !quote.quote.available || !name || !phone || !email}
              >
                {sending ? 'Sending…' : 'Send request'}
              </button>
            </div>
          </form>
        </section>
      </main>
    </>
  );
}

/**
 * A stay, night by night: each unit's rate, extra guests and holiday
 * surcharge, then the promo's discount (D-097) and the total. The lines'
 * prices are net of the discount already; the discount line says what came
 * off, so the figures add up as the server added them.
 */
function Lines({
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
      {dates.map((date) =>
        lines
          .filter((l) => l.date === date)
          .map((l) => (
            <div key={`${date}-${l.unitId}`} className="quote-line">
              <span>
                {dateLabel(date)}
                {multipleUnits ? ` · ${l.unit}` : ''}
                {l.holiday && <span className="holiday-badge">{l.holiday}</span>}
              </span>
              <span>
                {formatMoney(l.basePrice, currency)}
                {l.extraGuestPrice > 0 && ` + ${formatMoney(l.extraGuestPrice, currency)} extra guests`}
                {l.surcharge > 0 && ` + ${formatMoney(l.surcharge, currency)} surcharge`}
                {l.discount > 0 && ` − ${formatMoney(l.discount, currency)} promo`}
                {l.extraGuestPrice > 0 || l.surcharge > 0 || l.discount > 0 ? ` = ${formatMoney(l.price, currency)}` : ''}
              </span>
            </div>
          )),
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
