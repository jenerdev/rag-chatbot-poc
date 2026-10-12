'use client';

// The Review proof panel, inside a booking's drawer (S-15, D-114). One
// decision, made in order:
//
//   1. look at the proof: large, at the top; click it for the popup
//   2. read what the guest says beside what the booking needs
//   3. choose: Verify (the money is in the account) or Reject (it is not)
//   4. the chosen side's fields only: the amount found and "I checked the
//      account", or the reason the guest will read (with quick picks)
//
// The footer stays in view with the decision's button(s) and, while one is
// not ready, the reason in words. review_payment() checks everything again:
// the amount's range, the box, a reason to reject (R-46).
//
// No money is computed here: the amount found is pesos as typed, parsed by
// string on the server (lib/money.ts); every other figure is the server's.

import { useState } from 'react';
import type { StayDetail } from '@rag/bookings';
import { ProofThumb, proofKind } from '@/components/proof-viewer';
import { CopyText } from '@/components/copy-button';
import { Icon } from '@/components/icons';
import { centavosToInput, formatMoney } from '@/lib/money';
import { when } from '@/lib/stay-words';

type PaymentRow = StayDetail['payments'][number];

export interface ReviewDecision {
  action: 'verify' | 'reject';
  amount: string;
  accountChecked: boolean;
  note: string | null;
  confirm: boolean;
}

/** Reasons staff give most; one click fills the reason, which stays editable. */
const QUICK_REASONS = [
  'The money is not in the account.',
  'The amount received is different from the amount sent.',
  'The photo is unreadable. Please send a clearer one.',
  'This receipt is for another booking.',
];

/** "Mon 12 Oct 2026" for a YYYY-MM-DD date. */
function dateLabel(date: string): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

export function ReviewProof({
  payment,
  proofUrl,
  stay,
  busy,
  error,
  onDecide,
  onCancel,
}: {
  payment: PaymentRow;
  /** the 5-minute signed link, or null while it is asked for */
  proofUrl: string | null;
  stay: Pick<StayDetail, 'currency' | 'timezone' | 'payment' | 'status' | 'reviewBy'>;
  busy: boolean;
  /** the server's refusal, in its words, shown above the buttons */
  error: string | null;
  onDecide: (decision: ReviewDecision) => void;
  onCancel: () => void;
}) {
  const [mode, setMode] = useState<'verify' | 'reject'>('verify');
  const [amount, setAmount] = useState(centavosToInput(payment.claimedAmount));
  const [checked, setChecked] = useState(false);
  const [note, setNote] = useState('');
  const [reason, setReason] = useState('');
  const money = (n: number) => formatMoney(n, stay.currency);
  const pending = stay.status === 'pending';

  // Why the main button is not ready, in words; null when it is.
  const missing =
    mode === 'verify'
      ? amount.trim() === ''
        ? 'Enter the amount you found'
        : !checked
          ? 'Tick the box once you have seen the money'
          : note.trim() === ''
            ? 'Write a note'
            : null
      : reason.trim() === ''
        ? 'Write the reason the guest will read'
        : null;

  const decide = (action: 'verify' | 'reject', confirm = false) =>
    onDecide(
      action === 'verify'
        ? {
            action,
            amount,
            accountChecked: checked,
            note: note.trim(),
            confirm,
          }
        : {
            action,
            amount,
            accountChecked: false,
            note: reason.trim(),
            confirm: false,
          },
    );

  return (
    <form className="review-proof" onSubmit={(e) => e.preventDefault()}>
      {/* 1. The proof, large: it is what is being judged. */}
      <div className="review-proof-image">
        {payment.hasProof ? (
          proofUrl ? (
            <ProofThumb src={proofUrl} kind={proofKind(proofUrl)} label="Proof of payment" size="large" />
          ) : (
            <div className="quote-skeleton review-proof-loading" role="status" aria-label="Getting the proof">
              <span />
            </div>
          )
        ) : (
          <p className="small muted">The guest sent no file with this payment.</p>
        )}
      </div>

      {/* 2. What the guest says, beside what the booking needs. */}
      <div className="review-proof-facts">
        <div>
          <h4>The guest says</h4>
          <dl className="facts compact">
            <div>
              <dt>Amount</dt>
              <dd>
                <strong>{money(payment.claimedAmount)}</strong>
              </dd>
            </div>
            <div>
              <dt>Paid by</dt>
              <dd>{payment.method}</dd>
            </div>
            <div>
              <dt>Paid on</dt>
              <dd>{dateLabel(payment.paidOn)}</dd>
            </div>
            {payment.payerReference && (
              <div>
                <dt>Transaction</dt>
                <dd>
                  {/* Copied to search the bank or GCash history for it. */}
                  <CopyText text={payment.payerReference} what="transaction number" className="request-ref" />
                </dd>
              </div>
            )}
            <div>
              <dt>Sent</dt>
              <dd>{when(payment.createdAt, stay.timezone)}</dd>
            </div>
          </dl>
        </div>
        <div>
          <h4>This booking</h4>
          <dl className="facts compact">
            {stay.payment.required !== null && (
              <div>
                <dt>Needed to confirm</dt>
                <dd>{money(stay.payment.required)}</dd>
              </div>
            )}
            <div>
              <dt>Received so far</dt>
              <dd>{money(stay.payment.received)}</dd>
            </div>
            {stay.payment.price !== null && (
              <div>
                <dt>Total</dt>
                <dd>{money(stay.payment.price)}</dd>
              </div>
            )}
            {stay.reviewBy && (
              <div>
                <dt>Decide by</dt>
                <dd>{when(stay.reviewBy, stay.timezone)}</dd>
              </div>
            )}
          </dl>
        </div>
      </div>

      {/* 3. The choice. Radios, so the keyboard and a screen reader know it is one of two. */}
      <fieldset className="review-choice">
        <legend>Is the money in the account?</legend>
        <div className="review-options">
          <label className={`review-option${mode === 'verify' ? ' picked' : ''}`}>
            <input type="radio" name="review-mode" checked={mode === 'verify'} onChange={() => setMode('verify')} />
            <span>
              <strong>Yes, verify it</strong>
              <span className="small muted">I found the money in the account.</span>
            </span>
          </label>
          <label className={`review-option danger${mode === 'reject' ? ' picked' : ''}`}>
            <input type="radio" name="review-mode" checked={mode === 'reject'} onChange={() => setMode('reject')} />
            <span>
              <strong>No, reject it</strong>
              <span className="small muted">The guest is told why and can send another.</span>
            </span>
          </label>
        </div>
      </fieldset>

      {/* 4. Only the chosen side's fields. */}
      {mode === 'verify' ? (
        <div className="review-fields">
          <div className="field">
            <label htmlFor="verified-amount">Amount you found in the account</label>
            <div className="input-prefix">
              <span aria-hidden="true">{stay.currency === 'PHP' ? '₱' : stay.currency}</span>
              <input id="verified-amount" inputMode="decimal" autoComplete="off" value={amount} onChange={(e) => setAmount(e.target.value)} />
            </div>
            <p className="hint">Prefilled with what the guest says. Change it if the account shows a different amount.</p>
          </div>
          <label className={`option-card${checked ? ' picked' : ''}`}>
            <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} />
            <span className="room-pick-text">
              <span className="room-pick-name">I checked the account and the money is there</span>
              <span className="small muted">A screenshot proves nothing by itself.</span>
            </span>
          </label>
          <div className="field">
            <label htmlFor="review-note">
              Note <span className="muted">(required)</span>
            </label>
            <input id="review-note" required maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
          </div>
        </div>
      ) : (
        <div className="review-fields">
          <div className="field">
            <label htmlFor="reject-reason">Reason, shown to the guest</label>
            <div className="chip-picks" role="group" aria-label="Common reasons">
              {QUICK_REASONS.map((r) => (
                <button key={r} type="button" className={`chip${reason === r ? ' picked' : ''}`} aria-pressed={reason === r} onClick={() => setReason(r)}>
                  {r}
                </button>
              ))}
            </div>
            <textarea id="reject-reason" required rows={3} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
          </div>
        </div>
      )}

      {error && (
        <div className="notice error drawer-notice" role="alert">
          {error}
        </div>
      )}

      <div className="drawer-footer">
        <div className="drawer-footer-total">
          {missing ? (
            <span className="small muted">{missing}</span>
          ) : mode === 'verify' ? (
            <span className="small muted">
              <Icon name="check" size={14} /> Ready to verify
            </span>
          ) : (
            <span className="small muted">The guest reads this reason</span>
          )}
        </div>
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
        {mode === 'verify' ? (
          <>
            {/* Verify and confirm does both in one transaction; offered only while the stay waits. */}
            <button type="button" className={pending ? '' : 'primary'} disabled={busy || missing !== null} onClick={() => decide('verify')}>
              Verify
            </button>
            {pending && (
              <button type="button" className="primary" disabled={busy || missing !== null} onClick={() => decide('verify', true)}>
                Verify and confirm
              </button>
            )}
          </>
        ) : (
          <button type="button" className="danger solid" disabled={busy || missing !== null} onClick={() => decide('reject')}>
            Reject proof
          </button>
        )}
      </div>
    </form>
  );
}
