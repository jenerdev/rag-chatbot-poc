'use client';

// S-13 · Manage booking (plan/manage-booking.md). PUBLIC: a guest types the
// reference and the email or mobile number they booked with, and sees that
// one stay: its status in words, its dates, its rooms and the stored price.
//
// Each state shows its ONE next action. Since Phase 3 that includes paying:
// the tenant's ways to pay, the amount the stay needs, and a form that sends
// a proof (a photo, resized and EXIF-stripped here, or a PDF as it is). The
// amount typed is a CLAIM; staff verify it against their account.
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

import { useEffect, useMemo, useState } from 'react';
import type { GuestStatus, GuestStay, PaymentStatus } from '@rag/bookings';
import { BrandHeader } from '@/components/brand-header';
import { instantLabel } from '@/components/booking-page';
import { CopyButton } from '@/components/copy-button';
import { ProofThumb, proofKind } from '@/components/proof-viewer';
import { Icon } from '@/components/icons';
import { PublicFooter } from '@/components/public-footer';
import { TenantNav } from '@/components/tenant-nav';
import { timeLeft } from '@/lib/countdown';
import { centavosToInput, formatMoney } from '@/lib/money';
import { resizeImage } from '@/lib/resize-image';
import type { NavFeatures } from '@/lib/nav-items';

export interface ManageBookingScreenProps {
  slug: string;
  businessName: string;
  /** the assistant's name, for the header's chat link (D-136) */
  assistantName: string;
  logoUrl: string | null;
  bannerUrl: string | null;
  nav: NavFeatures;
  /** from `?ref=`, already checked for shape by the page; '' for none */
  initialReference: string;
  /** the proof's limits, from @rag/bookings through the server page (never a copy) */
  limits: { maxProofBytes: number; maxProofEdge: number; maxPayerReference: number; proofRetentionDays: number };
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

/**
 * The badge for this stay: its status, except that a stay cancelled before it
 * was ever confirmed reads "Declined", and a pending one whose dates were
 * taken since says so, since it can no longer be confirmed.
 */
function stayBadge(stay: Found): { label: string; tone: string } {
  if (stay.guestStatus === 'pending' && stay.taken) return { label: 'Dates no longer available', tone: 'danger' };
  if (stay.guestStatus === 'cancelled' && stay.declined) return { label: 'Declined', tone: 'danger' };
  return BADGE[stay.guestStatus];
}

/**
 * Can this stay still take a payment? Live (pending or confirmed) and, while
 * pending, its dates not taken by another stay. The database refuses the
 * rest anyway (submit_payment(), payments_refuse_taken); this only stops the
 * page offering a form that would be refused.
 */
function takesPayment(stay: Found): boolean {
  return stay.status === 'confirmed' || (stay.status === 'pending' && !stay.taken);
}

/**
 * Is this stay counting down to its payment deadline? Pending, not taken,
 * tracked, with a pay-by and no proof waiting: a proof sent in time stops the
 * clock (stay_is_due()), so the page stops it too. The same condition the
 * "Please pay by" sentence uses.
 */
function payDeadline(stay: Found): string | null {
  if (stay.guestStatus !== 'pending' || stay.taken || !stay.payBy) return null;
  if (stay.payment.open || stay.payment.status === 'not_tracked' || stay.payment.enough) return null;
  return stay.payBy;
}

/**
 * The time left to pay, live, to the second: "Expires in 23h 41m 05s". The sentence above it already names the date and time (nextStep()). The deadline is the database's; when it passes, the page says so and
 * the next look-up reads the stay as expired (guest_stay(), D-110). A
 * role="timer" region is not announced on every tick (its live default is
 * off), so a screen reader is not interrupted each second.
 */
function ExpiryCountdown({ payBy }: { payBy: string }) {
  const deadline = Date.parse(payBy);
  const [now, setNow] = useState(() => Date.now());
  const left = deadline - now;
  useEffect(() => {
    if (left <= 0) return;
    // Redraw on the next whole second of the deadline, so the seconds step evenly.
    const id = window.setTimeout(() => setNow(Date.now()), left % 1000 || 1000);
    return () => window.clearTimeout(id);
  }, [left]);
  if (left <= 0) {
    return (
      <p className="countdown passed" role="status">
        <strong>The time to pay has passed.</strong> This request will expire; look it up again to see its status.
      </p>
    );
  }
  return (
    <p className={`countdown${left <= 3_600_000 ? ' urgent' : ''}`}>
      <Icon name="clock" size={16} />
      <span>
        Expires in{' '}
        <strong role="timer" aria-label={`Time left to pay: ${timeLeft(left)}`}>
          {timeLeft(left)}
        </strong>
      </span>
    </p>
  );
}

function nextStep(stay: Found, businessName: string): string {
  if (stay.guestStatus === 'pending' && stay.taken) {
    return `${stay.taken} ${businessName} cannot confirm this request, so please do not pay for it. You can send a new request for other dates.`;
  }
  switch (stay.guestStatus) {
    case 'pending': {
      const held = stay.heldUntil ? ` Your dates are held for you until ${instantLabel(stay.heldUntil, stay.timezone)}.` : ' Until they do, the dates are not held, and someone else may book them.';
      const due = stay.payBy && !stay.payment.open && stay.payment.status !== 'not_tracked' ? ` Please pay by ${instantLabel(stay.payBy, stay.timezone)}, or the request expires.` : '';
      return `${businessName} has your request and will confirm it.${held}${due}`;
    }
    case 'confirmed':
      return `Your stay is confirmed. ${businessName} will contact you if anything changes.`;
    case 'completed':
      return 'This stay has ended. Thank you for staying.';
    case 'cancelled':
      return stay.declined
        ? `${businessName} declined this request. Please do not pay for it. You can send a new request from the booking page.`
        : `This booking was cancelled. Contact ${businessName} if you think this is a mistake.`;
    case 'expired':
      return `This request expired before it was confirmed, so it takes no payment. You can send a new one from the booking page.`;
  }
}

/** "Thu, 12 Nov" and "2026 · 14:00" in the tenant's zone: two short lines, so a date fits the summary's narrow column. */
function dayParts(iso: string, timezone: string): [string, string] {
  const d = new Date(iso);
  const day = d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: timezone });
  const year = d.toLocaleDateString('en-GB', { year: 'numeric', timeZone: timezone });
  return [day, `${year} · ${timeLabel(iso, timezone)}`];
}

/** "14:00" in the tenant's zone. */
function timeLabel(iso: string, timezone: string): string {
  return new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: timezone });
}

export function ManageBookingScreen({ slug, businessName, assistantName, logoUrl, bannerUrl, nav, initialReference, limits }: ManageBookingScreenProps) {
  const [reference, setReference] = useState(initialReference);
  const [contact, setContact] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stay, setStay] = useState<Found | null>(null);

  async function lookUp(event?: React.FormEvent) {
    event?.preventDefault();
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
    <BrandHeader businessName={businessName} logoUrl={logoUrl} bannerUrl={bannerUrl} hero="Manage booking">
      <TenantNav slug={slug} features={nav} current="manage" assistantName={assistantName} />
    </BrandHeader>
  );

  if (stay) {
    const badge = stayBadge(stay);
    const live = takesPayment(stay);
    // A stay that can take no payment and never took one has nothing for a
    // Payment tab or a payment badge ("Unpaid" on a declined stay misleads).
    const showPayment = stay.payment.status !== 'not_tracked' && (live || stay.payments.length > 0);
    // Why it ended: the staff's note, or "Not paid in time" for an expiry.
    const reason = !live && stay.decisionNote ? stay.decisionNote : null;
    const p = stay.price;
    // The page's cards (plan/manage-layout): the status first, then the stay
    // at a glance, then paying, then changing it. On a wide screen the stay
    // stands in its own column beside the rest, and stays in view while the
    // payment form scrolls; on a phone they stack in this same order, which
    // is the DOM order, so the reading and focus order is what is seen.
    return (
      <>
        {header}
        <main className="book-main">
          <div className="manage-layout">
            <section className="card manage-status" aria-labelledby="stay-title">
              <div className="manage-head">
                <h1 className="page-title" id="stay-title">
                  Your booking
                </h1>
                <div className="manage-badges">
                  <span className={`badge ${badge.tone}`}>
                    <span className="visually-hidden">Booking: </span>
                    {badge.label}
                  </span>
                  {showPayment && (
                    <span className={`badge ${PAYMENT_TONE[stay.payment.status]}`}>
                      <span className="visually-hidden">Payment: </span>
                      {PAYMENT_WORDS[stay.payment.status]}
                    </span>
                  )}
                </div>
              </div>
              <div className="receipt-reference">
                <span className="small muted">Reference</span>
                <strong className="reference">{stay.reference}</strong>
                <CopyButton text={stay.reference} what="reference" />
              </div>
              <div className={`notice manage-notice ${badge.tone === 'danger' ? 'error' : stay.guestStatus === 'pending' || stay.guestStatus === 'expired' ? 'warn' : ''}`}>
                <p>{nextStep(stay, businessName)}</p>
                {payDeadline(stay) && <ExpiryCountdown payBy={payDeadline(stay)!} />}
                {reason && (
                  <p>
                    <strong>Reason:</strong> {reason}
                  </p>
                )}
              </div>
            </section>

            <section className="card manage-summary" aria-labelledby="dates-title">
              <h2 id="dates-title">Your stay</h2>
              <div className="manage-dates">
                <div>
                  <span className="manage-label">Check-in</span>
                  <strong>{dayParts(stay.startsAt, stay.timezone)[0]}</strong>
                  <span className="small muted">{dayParts(stay.startsAt, stay.timezone)[1]}</span>
                </div>
                <Icon name="chevron-right" size={16} />
                <div>
                  <span className="manage-label">Check-out</span>
                  <strong>{dayParts(stay.endsAt, stay.timezone)[0]}</strong>
                  <span className="small muted">{dayParts(stay.endsAt, stay.timezone)[1]}</span>
                </div>
              </div>
              <dl className="manage-facts">
                <div>
                  <dt>Booked by</dt>
                  <dd>{stay.guestName}</dd>
                </div>
                {stay.nights > 0 && (
                  <div>
                    <dt>Length</dt>
                    <dd>
                      {stay.nights} {stay.nights === 1 ? 'night' : 'nights'}
                    </dd>
                  </div>
                )}
              </dl>
              <ul className="manage-rooms">
                {stay.rooms.map((r) => (
                  <li key={`${r.unit}-${r.slot}-${r.guests}`}>
                    <Icon name="bed" size={16} />
                    <span className="grow">
                      {r.unit} <span className="muted">· {r.slot}</span>
                    </span>
                    <span className="small muted">
                      {r.guests} {r.guests === 1 ? 'guest' : 'guests'}
                    </span>
                  </li>
                ))}
              </ul>
              {p.total !== null && (
                <div className="manage-price">
                  <h3 className="manage-label">Price</h3>
                  <div className="stay-lines">
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
                  </div>
                </div>
              )}
              <button type="button" className="ghost manage-another" onClick={another}>
                <Icon name="search" size={16} /> Look up another booking
              </button>
            </section>

            {showPayment && (
              <PaymentPanel
                key={stay.payments.length}
                slug={slug}
                stay={stay}
                live={live}
                businessName={businessName}
                reference={reference}
                contact={contact}
                limits={limits}
                onSent={() => void lookUp()}
              />
            )}
            <ChangePanel
              key={`change-${stay.changes.length}-${stay.changes.at(-1)?.status ?? ''}`}
              slug={slug}
              stay={stay}
              reference={reference}
              contact={contact}
              onChanged={() => void lookUp()}
            />
          </div>
        </main>
        <PublicFooter slug={slug} businessName={businessName} manage={false} book={nav.book} />
      </>
    );
  }

  return (
    <>
      {header}
      <main className="book-main">
        <section className="card receipt manage manage-lookup" aria-labelledby="manage-title">
          <span className="manage-lookup-mark" aria-hidden="true">
            <Icon name="calendar" size={22} />
          </span>
          <h1 className="page-title" id="manage-title">
            Manage your booking
          </h1>
          <p className="book-intro">
            See its status, pay for it, or ask to move or cancel it. Enter your booking reference and the email address or mobile
            number you booked with.
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
          <p className="manage-help small muted">
            <Icon name="info" size={16} />
            <span>Your reference was shown when you sent your booking request, like ABC-7KQ4MX: three letters, a dash, then six letters and numbers.</span>
          </p>
        </section>
      </main>
      <PublicFooter slug={slug} businessName={businessName} manage={false} book={nav.book} />
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

/** The payment's status in the guest's words. */
const PAYMENT_WORDS: Record<PaymentStatus, string> = {
  not_tracked: '',
  unpaid: 'Not paid yet',
  submitted: 'Proof sent, being checked',
  rejected: 'Proof not accepted',
  partially_paid: 'Partly paid',
  paid: 'Paid',
  refunded: 'Refunded',
};

/** The payment's tint; the word beside it always says the same. */
const PAYMENT_TONE: Record<PaymentStatus, string> = {
  not_tracked: '',
  unpaid: 'warn',
  submitted: 'accent',
  rejected: 'danger',
  partially_paid: 'warn',
  paid: 'ok',
  refunded: '',
};

/** The tenant's date today, YYYY-MM-DD, for the "date paid" default. */
function today(timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

/**
 * The stay's payment: what it needs, what was sent, and, when the stay can
 * take one, how to pay and the form for the proof. Re-mounted (by `key`)
 * after each proof, so the form starts clean with a new idempotency key.
 */
function PaymentPanel({
  slug,
  stay,
  live,
  businessName,
  reference,
  contact,
  limits,
  onSent,
}: {
  slug: string;
  stay: Found;
  /** takesPayment(stay): false for a cancelled, declined, expired or taken stay */
  live: boolean;
  businessName: string;
  reference: string;
  contact: string;
  limits: ManageBookingScreenProps['limits'];
  onSent: () => void;
}) {
  const pay = stay.payment;
  // What is still owed toward the confirmation amount, or toward the total
  // once that is met. Both are the database's numbers; this only picks one.
  const due = pay.required !== null && !pay.enough ? pay.required - pay.received : (pay.outstanding ?? 0);
  const canPay = live && stay.pay !== null && pay.status !== 'not_tracked' && !pay.open && due > 0;

  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const [method, setMethod] = useState(stay.pay?.methods[0]?.label ?? '');
  const [amount, setAmount] = useState(due > 0 ? centavosToInput(due) : '');
  const [paidOn, setPaidOn] = useState(() => today(stay.timezone));
  const [payerReference, setPayerReference] = useState('');
  const [file, setFile] = useState<File | null>(null);
  // The picked file, shown back before it is sent: a blob: URL from this
  // browser's memory (nothing is uploaded to show it), revoked when it changes.
  const preview = useMemo(() => (file ? URL.createObjectURL(file) : null), [file]);
  useEffect(() => () => {
    if (preview) URL.revokeObjectURL(preview);
  }, [preview]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (pay.status === 'not_tracked') return null;

  async function send(event: React.FormEvent) {
    event.preventDefault();
    if (!file) return;
    setSending(true);
    setError(null);
    try {
      let body: Blob = file;
      let name = file.name;
      if (/^image\/(jpeg|png|webp)$/.test(file.type)) {
        const resized = await resizeImage(file, limits.maxProofEdge);
        body = resized.blob;
        name = resized.blob.type === 'image/webp' ? 'proof.webp' : 'proof.jpg';
      } else if (file.type !== 'application/pdf') {
        setError('The proof must be a JPG, PNG or WebP photo, or a PDF.');
        return;
      }
      if (body.size > limits.maxProofBytes) {
        setError(`The file is ${(body.size / 1048576).toFixed(1)} MB; the limit is ${limits.maxProofBytes / 1048576} MB.`);
        return;
      }
      const form = new FormData();
      form.append('reference', reference);
      form.append('contact', contact);
      form.append('method', method);
      form.append('amount', amount);
      form.append('paidOn', paidOn);
      form.append('payerReference', payerReference);
      form.append('idempotencyKey', idempotencyKey);
      form.append('file', body, name);
      const response = await fetch(`/api/t/${slug}/manage/proof`, { method: 'POST', body: form });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) {
        setError(typeof result.error === 'string' ? result.error : 'The proof could not be sent. Please try again.');
        return;
      }
      onSent();
    } catch {
      setError('The proof could not be sent. Check your connection and try again.');
    } finally {
      setSending(false);
    }
  }

  const lastRejected = [...stay.payments].reverse().find((p) => p.kind === 'payment' && p.status === 'rejected');

  return (
    <section className="card manage-payment" aria-labelledby="payment-title">
      <h2 id="payment-title">Payment</h2>
      {!live && (
        // A stay that can no longer go ahead: what was received, and who to
        // ask about it, never a balance to pay.
        <p className="notice">
          This booking takes no payment.
          {pay.received > 0 ? ` For the ${formatMoney(pay.received, stay.currency)} already received, contact ${businessName}.` : ''}
        </p>
      )}
      {canPay && (
        <div className="pay-due">
          <span className="small muted">{pay.required !== null && !pay.enough ? 'To pay now' : 'Balance to pay'}</span>
          <strong>{formatMoney(due, stay.currency)}</strong>
          {stay.payBy && <span className="small muted">by {instantLabel(stay.payBy, stay.timezone)}</span>}
        </div>
      )}
      <div className="stay-lines">
        {live && pay.required !== null && pay.price !== null && pay.required < pay.price && (
          <div className="quote-line">
            <span>Needed to confirm</span>
            <span>{formatMoney(pay.required, stay.currency)}</span>
          </div>
        )}
        <div className="quote-line">
          <span>Received</span>
          <span>{formatMoney(pay.received, stay.currency)}</span>
        </div>
        {live && pay.outstanding !== null && (
          <div className="quote-line quote-total">
            <strong>Balance</strong>
            <strong>{formatMoney(pay.outstanding, stay.currency)}</strong>
          </div>
        )}
      </div>

      {pay.open && <p className="notice">Your proof of payment is being checked. You will see the result here.</p>}
      {live && pay.status === 'rejected' && lastRejected?.rejectionReason && (
        <p className="notice error">Your last proof was not accepted: {lastRejected.rejectionReason}</p>
      )}

      {canPay && stay.pay && (
        <>
          <h3 className="pay-step">
            <span className="pay-step-n">1</span> Pay by one of these
          </h3>
          <ul className="pay-methods">
            {stay.pay.methods.map((m) => (
              <li key={m.label} className="pay-method">
                <strong>{m.label}</strong>
                {m.accountName && <span>{m.accountName}</span>}
                {m.accountNumber && (
                  <span className="pay-account">
                    <span className="reference">{m.accountNumber}</span>
                    <CopyButton text={m.accountNumber} what={`${m.label} account number`} />
                  </span>
                )}
                {m.instructions && <span className="small muted">{m.instructions}</span>}
              </li>
            ))}
          </ul>
          {stay.pay.terms && <div className="instructions">{stay.pay.terms}</div>}

          <form onSubmit={send} className="proof-form" noValidate>
            <h3 className="pay-step">
              <span className="pay-step-n">2</span> Send a photo or PDF of the receipt
            </h3>
            <div className="field-row">
              <div className="field grow">
                <label htmlFor="pay-method">Paid by</label>
                <select id="pay-method" value={method} onChange={(e) => setMethod(e.target.value)}>
                  {stay.pay.methods.map((m) => (
                    <option key={m.label} value={m.label}>
                      {m.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label htmlFor="pay-amount">Amount paid</label>
                <input id="pay-amount" type="text" inputMode="decimal" required value={amount} onChange={(e) => setAmount(e.target.value)} />
              </div>
            </div>
            <div className="field-row">
              <div className="field">
                <label htmlFor="pay-date">Date paid</label>
                <input id="pay-date" type="date" required value={paidOn} onChange={(e) => setPaidOn(e.target.value)} />
              </div>
              <div className="field grow">
                <label htmlFor="pay-ref">
                  Transaction number <span className="muted">(optional)</span>
                </label>
                <input
                  id="pay-ref"
                  type="text"
                  autoComplete="off"
                  maxLength={limits.maxPayerReference}
                  value={payerReference}
                  onChange={(e) => setPayerReference(e.target.value)}
                />
              </div>
            </div>
            <div className="field">
              <label htmlFor="pay-file">Receipt (photo or PDF)</label>
              <input
                id="pay-file"
                type="file"
                required
                accept="image/jpeg,image/png,image/webp,application/pdf"
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                aria-describedby="pay-file-kept"
              />
              {/* D-129: what happens to the file, before it is sent. */}
              <p className="hint" id="pay-file-kept">
                Kept only to check your payment, and deleted {limits.proofRetentionDays} days after your stay. A photo&apos;s location
                data is removed before it is sent.
              </p>
              {file && preview && (
                <div className="proof-picked">
                  <ProofThumb src={preview} kind={proofKind(file.type)} label="Your proof of payment" />
                  <span className="small muted">
                    {file.name}
                    <br />
                    Check it shows the amount and the date before you send it.
                  </span>
                </div>
              )}
            </div>
            {error && (
              <div className="notice error" role="alert">
                {error}
              </div>
            )}
            <div className="form-footer">
              <button type="submit" className="primary" aria-busy={sending || undefined} disabled={sending || !file || !amount.trim() || !method}>
                {sending ? 'Sending…' : 'Send proof of payment'}
              </button>
            </div>
          </form>
        </>
      )}

      {stay.payments.length > 0 && (
        <>
          <h3>What you sent</h3>
          <ul className="pay-history">
            {stay.payments.map((p) => (
              <li key={p.createdAt}>
                <span>
                  {p.kind === 'refund' ? 'Refund' : p.method} · {p.paidOn}
                </span>
                <span>{formatMoney(p.verifiedAmount ?? p.claimedAmount, stay.currency)}</span>
                <span className={`badge ${p.status === 'verified' ? 'ok' : p.status === 'rejected' ? 'danger' : 'warn'}`}>
                  {p.status === 'verified' ? 'Verified' : p.status === 'rejected' ? 'Not accepted' : 'Being checked'}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

/**
 * Phase 6: ask to cancel or to move the stay. Every figure is the
 * database's: the refund the policy gives TODAY, or the new dates' price
 * and the difference, asked for with a dry run before anything is sent.
 * Nothing changes the stay until the resort approves (plan Rule 1).
 */
function ChangePanel({
  slug,
  stay,
  reference,
  contact,
  onChanged,
}: {
  slug: string;
  stay: Found;
  reference: string;
  contact: string;
  onChanged: () => void;
}) {
  const open = stay.changes.find((c) => c.status === 'pending') ?? null;
  const last = stay.changes.at(-1) ?? null;
  const [mode, setMode] = useState<'none' | 'cancel' | 'reschedule'>('none');
  const [newCheckIn, setNewCheckIn] = useState('');
  const [reason, setReason] = useState('');
  const [quote, setQuote] = useState<{ quotedPrice?: number; quotedDifference?: number; refundDue?: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open && !stay.change.canCancel && !stay.change.canReschedule && !(last && last.status === 'rejected')) {
    return null;
  }

  async function call(path: string, body: object): Promise<Record<string, unknown> | null> {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/t/${slug}/manage/${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reference, contact, ...body }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) {
        setError(typeof result.error === 'string' ? result.error : 'Something went wrong. Please try again.');
        return null;
      }
      return result;
    } catch {
      setError('Could not reach the server. Check your connection and try again.');
      return null;
    } finally {
      setBusy(false);
    }
  }

  const money = (n: number) => formatMoney(n, stay.currency);

  return (
    <section className="card manage-change" aria-labelledby="change-title">
      <h2 id="change-title">Change your booking</h2>
      {last?.status === 'rejected' && !open && last.decisionNote && (
        <p className="notice error">Your last request was not accepted: {last.decisionNote}</p>
      )}
      {open ? (
        <>
          <p className="notice">
            {open.kind === 'cancel'
              ? `You asked to cancel. ${open.refundDue ? `Under the policy you would get back ${money(open.refundDue)}.` : 'Under the policy no refund is due.'}`
              : `You asked to move your stay to ${open.newCheckIn}.${open.quotedDifference ? ` The price changes by ${open.quotedDifference > 0 ? '+' : '−'}${money(Math.abs(open.quotedDifference))}.` : ''}`}{' '}
            The resort will answer here. Your booking stays as it is until then.
          </p>
          <div className="form-footer">
            <button type="button" disabled={busy} onClick={async () => { if (await call('change/withdraw', {})) onChanged(); }}>
              Withdraw this request
            </button>
          </div>
        </>
      ) : mode === 'none' ? (
        <div className="form-footer manage-actions">
          {stay.change.canReschedule && (
            <button type="button" onClick={() => { setMode('reschedule'); setQuote(null); }}>
              Move to other dates
            </button>
          )}
          {stay.change.canCancel && (
            <button type="button" className="danger" onClick={async () => { setMode('cancel'); setQuote(await call('change', { kind: 'cancel', dryRun: true })); }}>
              Cancel this booking
            </button>
          )}
        </div>
      ) : (
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            const sent = await call('change', { kind: mode, newCheckIn: mode === 'reschedule' ? newCheckIn : null, reason: reason || null, dryRun: false });
            if (sent) onChanged();
          }}
        >
          {mode === 'cancel' ? (
            <p className="small">
              {stay.change.refundPercent > 0 && quote?.refundDue !== undefined
                ? `Cancelling today, ${stay.change.daysBefore} days before check-in, the policy refunds ${stay.change.refundPercent}% of what you paid: ${money(quote.refundDue)}. The resort pays it back after approving.`
                : 'Under the policy, no refund is due for a cancellation today.'}
            </p>
          ) : (
            <div className="field-row">
              <div className="field">
                <label htmlFor="new-check-in">New check-in date</label>
                <input id="new-check-in" type="date" required value={newCheckIn} onChange={(e) => { setNewCheckIn(e.target.value); setQuote(null); }} />
              </div>
              <div className="field">
                <span className="small muted">Same rooms, nights and guests.</span>
                <button type="button" disabled={busy || !newCheckIn} onClick={async () => setQuote(await call('change', { kind: 'reschedule', newCheckIn, dryRun: true }))}>
                  See the price
                </button>
              </div>
            </div>
          )}
          {mode === 'reschedule' && quote?.quotedPrice !== undefined && (
            <p className="small">
              New price {money(quote.quotedPrice)}
              {quote.quotedDifference ? ` (${quote.quotedDifference > 0 ? '+' : '−'}${money(Math.abs(quote.quotedDifference))}; any balance is paid as before)` : ' (no difference)'}.
              A promo used on the old dates does not carry over.
            </p>
          )}
          <div className="field">
            <label htmlFor="change-reason">
              Reason <span className="muted">(optional)</span>
            </label>
            <input id="change-reason" maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
          </div>
          {error && (
            <div className="notice error" role="alert">
              {error}
            </div>
          )}
          <div className="form-footer">
            <button type="button" disabled={busy} onClick={() => { setMode('none'); setError(null); }}>
              Back
            </button>
            <button type="submit" className="primary" disabled={busy || (mode === 'reschedule' && quote?.quotedPrice === undefined)}>
              {mode === 'cancel' ? 'Ask to cancel' : 'Ask to move'}
            </button>
          </div>
        </form>
      )}
      {mode === 'none' && error && (
        <div className="notice error" role="alert">
          {error}
        </div>
      )}
    </section>
  );
}
