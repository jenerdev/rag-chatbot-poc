'use client';

// S-13 · Manage booking (plan/manage-booking.md). PUBLIC: a guest types the
// reference and the email or mobile number they booked with, and sees that
// one stay: its status in words, its dates, its rooms and the stored price.
//
// Phase 2 is READ-ONLY. Later phases add the one next action each state
// allows (pay, upload proof, ask for a change); until then the page says
// what happens next and nothing more.
//
// What this screen does NOT do:
//   - keep the guest "signed in". The reference and contact live in React
//     state only; a reload asks again (plan § 2.3). No cookie, no storage;
//   - tell misses apart. The server answers every miss with one sentence,
//     and the page shows that sentence as it came (plan Rule 4);
//   - add up money. Every amount is a sum the database made of the stored
//     rows; this only formats it.
//
// Everything from the server is a React child, so it is escaped.

import { useState } from 'react';
import type { GuestStatus, GuestStay } from '@rag/bookings';
import { BrandHeader } from '@/components/brand-header';
import { instantLabel } from '@/components/booking-page';
import { Icon } from '@/components/icons';
import { TenantNav } from '@/components/tenant-nav';
import { formatMoney } from '@/lib/money';
import type { NavFeatures } from '@/lib/nav-items';

export interface ManageBookingScreenProps {
  slug: string;
  businessName: string;
  logoUrl: string | null;
  bannerUrl: string | null;
  nav: NavFeatures;
  /** from `?ref=`, already checked for shape by the page; '' for none */
  initialReference: string;
}

type Found = GuestStay & { guestStatus: GuestStatus };

/** The status as a word and a tint (a badge is never the tint alone). */
const BADGE: Record<GuestStatus, { label: string; tone: string }> = {
  pending: { label: 'Waiting for confirmation', tone: 'warn' },
  confirmed: { label: 'Confirmed', tone: 'ok' },
  completed: { label: 'Completed', tone: '' },
  cancelled: { label: 'Cancelled', tone: 'danger' },
  expired: { label: 'Expired', tone: '' },
};

function nextStep(status: GuestStatus, businessName: string): string {
  switch (status) {
    case 'pending':
      return `${businessName} has your request and will confirm it. Until they do, the dates are not held, and someone else may book them.`;
    case 'confirmed':
      return `Your stay is confirmed. ${businessName} will contact you if anything changes.`;
    case 'completed':
      return 'This stay has ended. Thank you for staying.';
    case 'cancelled':
      return `This booking was cancelled. Contact ${businessName} if you think this is a mistake.`;
    case 'expired':
      return `This request expired before it was confirmed. You can send a new one from the booking page.`;
  }
}

export function ManageBookingScreen({ slug, businessName, logoUrl, bannerUrl, nav, initialReference }: ManageBookingScreenProps) {
  const [reference, setReference] = useState(initialReference);
  const [contact, setContact] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stay, setStay] = useState<Found | null>(null);

  async function lookUp(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/t/${slug}/manage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reference, contact }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        setError(typeof body.error === 'string' ? body.error : 'Something went wrong. Please try again.');
        return;
      }
      setStay(body.stay as Found);
    } catch {
      setError('Could not reach the server. Check your connection and try again.');
    } finally {
      setBusy(false);
    }
  }

  function another() {
    setStay(null);
    setContact('');
    setError(null);
  }

  const header = (
    <BrandHeader businessName={businessName} logoUrl={logoUrl} bannerUrl={bannerUrl} subtitle="Manage booking">
      <TenantNav slug={slug} features={nav} current="manage" />
    </BrandHeader>
  );

  if (stay) {
    const badge = BADGE[stay.guestStatus];
    const p = stay.price;
    return (
      <>
        {header}
        <main className="book-main">
          <section className="card receipt" aria-labelledby="stay-title">
            <h1 className="page-title" id="stay-title">
              Your booking
            </h1>
            <div className="receipt-reference">
              <span className="small muted">Reference</span>
              <strong className="reference">{stay.reference}</strong>
              <span className={`badge ${badge.tone}`}>{badge.label}</span>
            </div>
            <p className={stay.guestStatus === 'pending' ? 'notice warn' : 'notice'}>{nextStep(stay.guestStatus, businessName)}</p>
            <div className="stay-summary">
              <div className="stay-summary-title">
                {stay.guestName}
                {stay.nights > 1 ? ` · ${stay.nights} nights` : ''}
              </div>
              <div className="small muted">
                From {instantLabel(stay.startsAt, stay.timezone)} to {instantLabel(stay.endsAt, stay.timezone)}
              </div>
            </div>
            <div className="stay-lines">
              {stay.rooms.map((r) => (
                <div key={`${r.unit}-${r.slot}-${r.guests}`} className="quote-line">
                  <span>
                    {r.unit} · {r.slot}
                  </span>
                  <span>
                    {r.guests} {r.guests === 1 ? 'guest' : 'guests'}
                  </span>
                </div>
              ))}
              {p.total !== null && (
                <>
                  {p.extraGuests || p.surcharge || p.discount ? (
                    <>
                      {p.base !== null && <Line label="Rate" amount={p.base} currency={stay.currency} />}
                      {!!p.extraGuests && <Line label="Extra guests" amount={p.extraGuests} currency={stay.currency} />}
                      {!!p.surcharge && <Line label="Holiday surcharge" amount={p.surcharge} currency={stay.currency} />}
                      {!!p.discount && <Line label="Promo discount" amount={-p.discount} currency={stay.currency} discount />}
                    </>
                  ) : null}
                  <div className="quote-line quote-total">
                    <strong>Total</strong>
                    <strong>{formatMoney(p.total, stay.currency)}</strong>
                  </div>
                </>
              )}
            </div>
            <div className="form-footer">
              <button type="button" onClick={another}>
                Look up another booking
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
      <main className="book-main">
        <section className="card receipt" aria-labelledby="manage-title">
          <h1 className="page-title" id="manage-title">
            Manage your booking
          </h1>
          <p className="book-intro">
            Enter your booking reference and the email address or mobile number you booked with.
          </p>
          <form onSubmit={lookUp} noValidate>
            <div className="field">
              <label htmlFor="reference">Booking reference</label>
              <input
                type="text"
                id="reference"
                required
                autoComplete="off"
                autoCapitalize="characters"
                spellCheck={false}
                maxLength={20}
                placeholder="ABC-7KQ4MX"
                value={reference}
                onChange={(e) => setReference(e.target.value)}
              />
            </div>
            <div className="field">
              <label htmlFor="contact">Email or mobile number</label>
              <input
                type="text"
                id="contact"
                required
                autoComplete="email"
                maxLength={254}
                placeholder="you@example.com or 0917 123 4567"
                value={contact}
                onChange={(e) => setContact(e.target.value)}
              />
            </div>
            {error && (
              <div className="notice error" role="alert">
                {error}
              </div>
            )}
            <div className="form-footer">
              <button type="submit" className="primary" aria-busy={busy || undefined} disabled={busy || !reference.trim() || !contact.trim()}>
                <Icon name="search" size={16} /> {busy ? 'Looking up…' : 'Look up booking'}
              </button>
            </div>
          </form>
        </section>
      </main>
    </>
  );
}

function Line({ label, amount, currency, discount }: { label: string; amount: number; currency: string; discount?: boolean }) {
  return (
    <div className={discount ? 'quote-line quote-discount' : 'quote-line'}>
      <span>{label}</span>
      <span>{amount < 0 ? `−${formatMoney(-amount, currency)}` : formatMoney(amount, currency)}</span>
    </div>
  );
}
