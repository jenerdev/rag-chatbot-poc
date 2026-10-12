'use client';

// S-15 · One booking (D-114). The ONLY place a stay is acted on: the
// Bookings list and the Payments queue open this page. Everything about the
// stay on one screen: the nights and their stored prices, the guest, the
// payment and its proofs, the change requests, the history.
//
// An action is shown only when it applies to the stay now and the member's
// role may take it (lib/stay-actions.ts, tested): Confirm / Decline while
// pending, Cancel while confirmed and not over, Review a proof that waits,
// Approve / Reject a change request that waits, Record a refund when money
// is no longer owed. Postgres refuses the rest whatever this page shows.
//
// No money is computed here: every figure is a stored row's or
// stay_payment()'s. Amounts typed by staff are pesos, parsed by string on
// the server (lib/money.ts).

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import type { StayDetail } from '@rag/bookings';
import { LoginForm, describeFailure } from '@/components/admin-login';
import { fetchRole } from '@/components/tenant-nav';
import { StaffFrame } from '@/components/staff-frame';
import { Drawer, useConfirmDialog } from '@/components/dialogs';
import { useNotice } from '@/components/toast';
import { CopyButton, CopyText } from '@/components/copy-button';
import { Icon } from '@/components/icons';
import { StayLines } from '@/components/stay-lines';
import { ReviewProof, type ReviewDecision } from '@/components/review-proof';
import { EmptyState, LOADING, LoadState, failed, type Load } from '@/components/load-state';
import type { NavFeatures } from '@/lib/nav-items';
import { formatMoney } from '@/lib/money';
import { isRole, type Role } from '@/lib/permissions';
import { stayActions } from '@/lib/stay-actions';
import { STAY_PAYMENT, eventWords, pendingState, when } from '@/lib/stay-words';

export interface StayDetailScreenProps {
  slug: string;
  reference: string;
  businessName: string;
  logoUrl: string | null;
  bannerUrl: string | null;
  nav: NavFeatures;
}

type Auth = 'checking' | 'out' | 'in';
type PaymentRow = StayDetail['payments'][number];

/** "Mon 19 Oct 2026". A calendar date, so formatted as UTC. */
function dayLabel(date: string): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

/** "14:00" for an instant, in the tenant's zone. */
function timeLabel(iso: string, timezone: string): string {
  return new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: timezone });
}

/** The stay's status as staff read it: a confirmed stay is Staying, then Completed. */
function statusBadge(stay: StayDetail): { label: string; tone: string } {
  if (stay.status === 'pending') return pendingState(stay.payment);
  if (stay.status === 'confirmed') {
    if (stay.checkOut <= stay.today) return { label: 'Completed', tone: '' };
    return stay.checkIn <= stay.today ? { label: 'Staying', tone: 'ok' } : { label: 'Confirmed', tone: 'ok' };
  }
  if (stay.status === 'expired') return { label: 'Expired', tone: '' };
  return stay.declined ? { label: 'Declined', tone: 'danger' } : { label: 'Cancelled', tone: '' };
}

/** How a decided stay ended, for the head: what happened, when, and the note staff wrote. */
function outcome(stay: StayDetail): { words: string; tone: string } | null {
  if (stay.status !== 'cancelled' && stay.status !== 'expired') return null;
  const what = stay.status === 'expired' ? 'Expired' : stay.declined ? 'Declined' : 'Cancelled';
  const at = stay.statusAt ? ` on ${when(stay.statusAt, stay.timezone)}` : '';
  const note = stay.decisionNote ? `: “${stay.decisionNote}”` : '';
  return { words: `${what}${at}${note}`, tone: stay.status === 'expired' ? 'warn' : 'error' };
}

export function StayDetailScreen({ slug, reference, businessName, logoUrl, bannerUrl, nav }: StayDetailScreenProps) {
  const api = `/api/t/${slug}`;
  const [auth, setAuth] = useState<Auth>('checking');
  const [role, setRole] = useState<Role | null>(null);
  const [stay, setStay] = useState<StayDetail | null | 'missing'>(null);
  const [loadState, setLoadState] = useState<Load>(LOADING);
  const [busy, setBusy] = useState(false);
  const { ask, dialog } = useConfirmDialog();

  // The proof drawer and the refund drawer.
  const [reviewing, setReviewing] = useState<PaymentRow | null>(null);
  const [proof, setProof] = useState<string | null>(null);
  const [refundOpen, setRefundOpen] = useState(false);
  const [refund, setRefund] = useState({ amount: '', method: '', note: '' });
  const { notice, setNotice } = useNotice(reviewing !== null || refundOpen);

  const unauthorized = useCallback(() => {
    setAuth('out');
    setStay(null);
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const body = await (await fetch(`${api}/admin/session`)).json();
        setAuth(body.admin === true ? 'in' : 'out');
        setRole(isRole(body.role) ? body.role : null);
      } catch {
        setAuth('out');
      }
    })();
  }, [api]);

  const load = useCallback(async () => {
    let response: Response | null = null;
    try {
      response = await fetch(`${api}/bookings/stay/${encodeURIComponent(reference)}`);
      if (response.status === 401) return unauthorized();
      if (response.status === 404) return setStay('missing');
      if (!response.ok) throw new Error('failed');
      setStay(await response.json());
    } catch (error) {
      setStay(null);
      setLoadState(failed(await describeFailure(error as Error, response)));
    }
  }, [api, reference, unauthorized]);

  useEffect(() => {
    if (auth === 'in') void load();
  }, [auth, load]);

  const logout = useCallback(async () => {
    await fetch(`${api}/admin/session`, { method: 'DELETE' }).catch(() => undefined);
    unauthorized();
  }, [api, unauthorized]);

  /** One write; on success, the message and a fresh read of the stay. Returns false on failure. */
  async function write(method: string, path: string, body: object, done: string): Promise<boolean> {
    setNotice(null);
    setBusy(true);
    let response: Response | null = null;
    try {
      response = await fetch(`${api}${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (response.status === 401) {
        unauthorized();
        return false;
      }
      if (!response.ok) throw new Error('failed');
      setNotice({ message: done, kind: 'ok' });
      void load();
      return true;
    } catch (error) {
      // A 409 or a refusal arrives with the server's own sentence, not rephrased.
      setNotice({ message: await describeFailure(error as Error, response), kind: 'error' });
      void load();
      return false;
    } finally {
      setBusy(false);
    }
  }

  const frame = {
    slug,
    businessName,
    logoUrl,
    bannerUrl,
    features: nav,
    current: 'bookings' as const,
    title: `Booking ${reference}`,
    session: { auth, role, onLogout: logout },
    mainClassName: 'stay-detail',
  };

  if (auth !== 'in') {
    return (
      <StaffFrame {...frame}>
        {auth === 'checking' ? (
          <div className="small muted">Checking your session…</div>
        ) : (
          <LoginForm
            api={api}
            slug={slug}
            onLoggedIn={() => {
              setAuth('in');
              void fetchRole(api).then(setRole);
            }}
          />
        )}
      </StaffFrame>
    );
  }

  const back = (
    <Link className="button" href={`/t/${slug}/admin/bookings`}>
      <Icon name="chevron-left" size={16} /> Bookings
    </Link>
  );

  if (stay === 'missing') {
    return (
      <StaffFrame {...frame} actions={back}>
        <section className="card">
          <EmptyState icon="search" title="No such booking">
            There is no booking {reference} here. Check the reference, or find it in the list.
          </EmptyState>
        </section>
      </StaffFrame>
    );
  }

  if (stay === null) {
    return (
      <StaffFrame {...frame} actions={back}>
        <LoadState load={loadState} what="booking" onRetry={() => { setLoadState(LOADING); void load(); }} />
      </StaffFrame>
    );
  }

  const actions = stayActions(stay, role);
  const badge = statusBadge(stay);
  const money = (n: number) => formatMoney(n, stay.currency);
  const stayWhen = `${stay.slot}, ${stay.nights > 1 ? `${stay.nights} nights from ` : ''}${dayLabel(stay.checkIn)}`;

  async function decide(action: 'confirm' | 'decline' | 'cancel') {
    if (stay === null || stay === 'missing') return;
    const s = stay;
    const answer = await ask(
      action === 'confirm'
        ? {
            title: `Confirm ${s.reference}?`,
            body: `${s.guestName}: ${stayWhen}. Confirming books the dates.`,
            noteLabel: actions.confirmNeedsNote ? 'Note: no payment is verified yet, e.g. "Paid cash at the desk"' : 'Note',
            noteRequired: true,
            actionLabel: 'Confirm',
          }
        : action === 'cancel'
          ? { title: `Cancel ${s.reference}?`, body: `${s.guestName}: ${stayWhen}. Every night is freed.`, noteLabel: 'Reason, shown to the guest', noteRequired: true, actionLabel: 'Cancel stay', backLabel: 'Keep it', danger: true }
          : { title: `Decline ${s.reference}?`, body: `${s.guestName}: ${stayWhen}.`, noteLabel: 'Reason, shown to the guest', noteRequired: true, actionLabel: 'Decline', danger: true },
    );
    if (answer === null) return;
    const done =
      action === 'confirm'
        ? `Confirmed ${s.reference}. The dates are booked; contact the guest at ${s.guestPhone ?? s.guestEmail}.`
        : action === 'cancel'
          ? `Cancelled ${s.reference}. Its nights are free again.`
          : `Declined ${s.reference}.`;
    await write('PATCH', `/bookings/requests/${s.groupId}`, { action, note: answer }, done);
  }

  async function decideChange(id: number, kind: 'cancel' | 'reschedule', newCheckIn: string | null, action: 'approve' | 'reject') {
    if (stay === null || stay === 'missing') return;
    const s = stay;
    const what = kind === 'cancel' ? 'cancel this stay' : `move this stay to ${newCheckIn ? dayLabel(newCheckIn) : 'another date'}`;
    const answer = await ask(
      action === 'approve'
        ? { title: `Approve the request to ${what}?`, body: kind === 'cancel' ? 'The stay is cancelled. Pay any refund due, then record it here.' : 'The stay moves to the new dates.', noteLabel: 'Note, shown to the guest', noteRequired: true, actionLabel: 'Approve' }
        : { title: `Reject the request to ${what}?`, body: 'The stay stays as it is.', noteLabel: 'Reason, shown to the guest', noteRequired: true, actionLabel: 'Reject', danger: true },
    );
    if (answer === null) return;
    await write(
      'PATCH',
      `/payments/changes/${id}`,
      { action, note: answer.trim() || null },
      action === 'reject' ? `Rejected the request. The guest sees your reason.` : kind === 'cancel' ? `Cancelled ${s.reference}. Record the refund once you have paid it.` : `Moved ${s.reference} to ${newCheckIn}.`,
    );
  }

  async function openReview(p: PaymentRow) {
    setReviewing(p);
    setProof(null);
    setNotice(null);
    if (p.hasProof) {
      const r = await fetch(`${api}/payments/${p.id}/proof`).catch(() => null);
      if (r?.ok) setProof(((await r.json()) as { url: string }).url);
    }
  }

  async function review(decision: ReviewDecision) {
    if (!reviewing || stay === null || stay === 'missing') return;
    const done =
      decision.action === 'reject'
        ? 'Rejected the proof. The guest sees your reason and can send another.'
        : decision.confirm
          ? `Verified and confirmed ${stay.reference}.`
          : 'Verified the payment.';
    if (await write('PATCH', `/payments/${reviewing.id}`, decision, done)) setReviewing(null);
  }

  async function saveRefund(event: React.FormEvent) {
    event.preventDefault();
    if (stay === null || stay === 'missing') return;
    if (await write('POST', '/payments/refund', { groupId: stay.groupId, ...refund }, `Recorded a refund on ${stay.reference}.`)) setRefundOpen(false);
  }

  const anyAction = actions.confirm || actions.decline || actions.cancel || actions.refund || actions.review.length > 0 || actions.decide.length > 0 || actions.confirmBlocked !== null;
  const waitingProof = stay.payments.find((p) => actions.review.includes(p.id));
  const ended = outcome(stay);
  const guests = stay.units.reduce((sum, u) => sum + (u.guests ?? 0), 0);
  const tracked = stay.payment.status !== 'not_tracked';
  // A bar for the eye only; the figures beside it are the server's, unchanged.
  const goal = stay.payment.required ?? stay.payment.price;
  const paidShare = tracked && goal ? Math.min(100, Math.round((stay.payment.received / goal) * 100)) : 0;

  // The title is the reference; Copy sits beside it, with the way back.
  const headActions = (
    <span className="stay-title-actions">
      <CopyButton text={stay.reference} what="reference" />
      {back}
    </span>
  );

  return (
    <StaffFrame {...frame} title={stay.reference} actions={headActions}>
      {dialog}

      {/* The head is the booking at a glance: who, its state, when they arrive and leave, what it costs. */}
      <section className="card stay-head">
        <div className="stay-head-top">
          <div className="stay-head-main">
            <div className="booking-badges">
              <span className={`badge ${badge.tone}`}>{badge.label}</span>
              <span className={stay.source === 'web' ? 'badge accent' : 'badge'}>{stay.source === 'web' ? 'Booking page' : 'By staff'}</span>
              {stay.walkIn && <span className="badge">Walk in</span>}
            </div>
            <h2>{stay.guestName}</h2>
            <p className="stay-head-sub">
              {stay.units.map((u) => u.unit).join(', ')} · {guests > 0 ? `${guests} guest${guests === 1 ? '' : 's'} · ` : ''}
              {stay.slot}
            </p>
          </div>
          {stay.total !== null && (
            <div className="stay-head-total">
              <span className="small muted">Total</span>
              <strong>{money(stay.total)}</strong>
              {tracked && <span className={`badge ${stay.payment.enough ? 'ok' : ''}`}>{STAY_PAYMENT[stay.payment.status] ?? stay.payment.status}</span>}
            </div>
          )}
        </div>

        <div className="stay-dates-strip">
          <div className="stay-date">
            <span className="small muted">Check-in</span>
            <strong>{dayLabel(stay.checkIn)}</strong>
            {stay.startsAt && <span className="small">{timeLabel(stay.startsAt, stay.timezone)}</span>}
          </div>
          <div className="stay-date-span" aria-hidden="true">
            <span>{stay.nights > 1 ? `${stay.nights} nights` : stay.checkOut !== stay.checkIn ? '1 night' : 'Day'}</span>
          </div>
          <div className="stay-date">
            <span className="small muted">Check-out</span>
            <strong>{stay.endsAt ? new Date(stay.endsAt).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: stay.timezone }) : dayLabel(stay.checkOut)}</strong>
            {stay.endsAt && <span className="small">{timeLabel(stay.endsAt, stay.timezone)}</span>}
          </div>
        </div>

        {ended && <p className={`stay-outcome ${ended.tone}`}>{ended.words}</p>}
        {/* A pending stay that waits for the guest says so, with the deadline. */}
        {stay.status === 'pending' && badge.label === 'Awaiting payment' && (
          <p className="stay-outcome warn">
            Waiting for the guest&rsquo;s payment{stay.payBy ? `, due by ${when(stay.payBy, stay.timezone)}` : ''}.
            {stay.payBy ? ' If nothing is paid by then, the request expires.' : ''}
          </p>
        )}
      </section>

      {/* What this stay needs now: every action that applies, one row each. Absent when nothing does. */}
      {anyAction && (
        <section className="card stay-actions" aria-labelledby="stay-actions-title">
          <h3 id="stay-actions-title">Next step</h3>
          {actions.confirmBlocked && <p className="notice error">{actions.confirmBlocked}</p>}
          {stay.status === 'pending' && (actions.confirm || actions.decline) && (
            <div className="stay-action">
              <div>
                <strong>{actions.confirm ? 'Confirm or decline this booking' : 'Decline this booking'}</strong>
                <p className="small muted">
                  {stay.payBy && !stay.payment.enough ? `The guest has until ${when(stay.payBy, stay.timezone)} to pay. ` : ''}
                  {actions.confirmNeedsNote ? 'No payment is verified yet, so confirming asks for a note.' : 'A pending booking does not hold its dates: the first one confirmed gets them.'}
                </p>
              </div>
              <span className="booking-actions">
                {actions.decline && (
                  <button type="button" disabled={busy} onClick={() => void decide('decline')}>
                    Decline
                  </button>
                )}
                {actions.confirm && (
                  <button type="button" className="primary" disabled={busy} onClick={() => void decide('confirm')}>
                    Confirm
                  </button>
                )}
              </span>
            </div>
          )}
          {waitingProof && (
            <div className="stay-action">
              <div>
                <strong>Check the proof of payment</strong>
                <p className="small muted">
                  {money(waitingProof.claimedAmount)} by {waitingProof.method}, sent {when(waitingProof.createdAt, stay.timezone)}.
                  {stay.reviewBy ? ` Review it by ${when(stay.reviewBy, stay.timezone)}.` : ''}
                </p>
              </div>
              <button type="button" className="primary" disabled={busy} onClick={() => void openReview(waitingProof)}>
                Review proof
              </button>
            </div>
          )}
          {stay.changes
            .filter((c) => actions.decide.includes(c.id))
            .map((c) => (
              <div key={c.id} className="stay-action">
                <div>
                  <strong>{c.kind === 'cancel' ? 'The guest asks to cancel' : `The guest asks to move to ${c.newCheckIn ? dayLabel(c.newCheckIn) : 'another date'}`}</strong>
                  <p className="small muted">
                    {c.kind === 'cancel'
                      ? `Refund due under your policy: ${money(c.refundDue ?? 0)}.`
                      : c.quotedDifference
                        ? `The new dates cost ${c.quotedDifference > 0 ? 'more' : 'less'}: ${c.quotedDifference > 0 ? '+' : '−'}${money(Math.abs(c.quotedDifference))}.`
                        : 'The new dates cost the same.'}
                    {c.guestReason ? ` “${c.guestReason}”` : ''}
                  </p>
                </div>
                <span className="booking-actions">
                  <button type="button" disabled={busy} onClick={() => void decideChange(c.id, c.kind, c.newCheckIn, 'reject')}>
                    Reject
                  </button>
                  <button type="button" className="primary" disabled={busy} onClick={() => void decideChange(c.id, c.kind, c.newCheckIn, 'approve')}>
                    Approve
                  </button>
                </span>
              </div>
            ))}
          {actions.refund && (
            <div className="stay-action">
              <div>
                <strong>Return the guest's money</strong>
                <p className="small muted">
                  {money(stay.payment.received)} was received for a booking that {stay.status === 'cancelled' || stay.status === 'expired' ? 'will not go ahead' : 'costs less'}. Return it, then record it here.
                </p>
              </div>
              <button type="button" disabled={busy} onClick={() => { setRefund({ amount: '', method: '', note: '' }); setNotice(null); setRefundOpen(true); }}>
                Record a refund
              </button>
            </div>
          )}
          {actions.cancel && (
            <div className="stay-action">
              <div>
                <strong>Cancel this booking</strong>
                <p className="small muted">Only if the guest is not coming. Every night is freed for others.</p>
              </div>
              <button type="button" className="danger" disabled={busy} onClick={() => void decide('cancel')}>
                Cancel stay
              </button>
            </div>
          )}
        </section>
      )}

      <div className="stay-layout">
        <div className="stay-main">
          <section className="card stay-card-price">
            <h3>Price</h3>
            {/* The stored rows, as they were saved: never re-priced here. */}
            {stay.total !== null ? (
              <div className="quote stay-price">
                <StayLines lines={stay.lines} currency={stay.currency} total={stay.total} discount={stay.lines.reduce((sum, l) => sum + l.discount, 0)} promoName={stay.promoName} />
              </div>
            ) : (
              <p className="small muted">This booking has no stored price.</p>
            )}
            {stay.notes && (
              <div className="stay-note">
                <span className="small muted">Notes</span>
                <p>{stay.notes}</p>
              </div>
            )}
          </section>

          {stay.changes.length > 0 && (
            <section className="card stay-card-changes">
              <h3>Change requests</h3>
              <ul className="stay-list">
                {stay.changes.map((c) => (
                  <li key={c.id}>
                    <span>
                      {c.kind === 'cancel' ? 'Cancel' : `Move to ${c.newCheckIn ? dayLabel(c.newCheckIn) : '?'}`}
                      <span className="small muted"> · asked {when(c.createdAt, stay.timezone)}{c.decisionNote ? ` · “${c.decisionNote}”` : ''}</span>
                    </span>
                    <span className={`badge ${c.status === 'pending' ? 'warn' : c.status === 'approved' ? 'ok' : ''}`}>
                      {c.status === 'pending' ? 'Waiting' : c.status === 'approved' ? 'Approved' : c.status === 'rejected' ? 'Rejected' : 'Withdrawn'}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section className="card stay-card-history">
            <h3>History</h3>
            {stay.history.length === 0 ? (
              <p className="small muted">No events recorded. Bookings older than manage booking have no history.</p>
            ) : (
              <ol className="timeline">
                {[...stay.history].reverse().map((e, i) => (
                  <li key={i}>
                    <span className="timeline-what">{eventWords(e, stay.currency)}</span>
                    <span className="small muted">
                      {when(e.at, stay.timezone)} · {e.actor === 'guest' ? 'the guest' : e.actor === 'system' ? 'automatic' : 'staff'}
                    </span>
                  </li>
                ))}
              </ol>
            )}
          </section>
        </div>

        <aside className="stay-side">
          <section className="card stay-card-contact">
            <h3>Contact</h3>
            <div className="stay-contact">
              {/* Call or write with the button; copy with the icon beside it. */}
              {stay.guestPhone && (
                <CopyText text={stay.guestPhone} what="mobile number" className="contact-row">
                  <a className="button sm" href={`tel:${stay.guestPhone}`}>
                    <Icon name="phone" size={14} /> {stay.guestPhone}
                  </a>
                </CopyText>
              )}
              {stay.guestEmail && (
                <CopyText text={stay.guestEmail} what="email" className="contact-row">
                  <a className="button sm" href={`mailto:${stay.guestEmail}`}>
                    <Icon name="mail" size={14} /> {stay.guestEmail}
                  </a>
                </CopyText>
              )}
            </div>
            <p className="small muted">Booked {when(stay.createdAt, stay.timezone)}{stay.promoName ? ` · promo ${stay.promoName}` : ''}</p>
          </section>

          <section className="card stay-card-payment">
            <h3>Payment</h3>
            {!tracked ? (
              <p className="small muted">Not tracked: this booking was made without payment terms.</p>
            ) : (
              <>
                <div className="pay-meter" role="img" aria-label={`Received ${money(stay.payment.received)} of ${goal !== null ? money(goal) : 'the total'}`}>
                  <span style={{ width: `${paidShare}%` }} />
                </div>
                <dl className="facts compact">
                  <div>
                    <dt>Received</dt>
                    <dd>{money(stay.payment.received)}</dd>
                  </div>
                  {stay.payment.required !== null && (
                    <div>
                      <dt>Needed to confirm</dt>
                      <dd>{money(stay.payment.required)}</dd>
                    </div>
                  )}
                  {stay.payment.outstanding !== null && stay.payment.outstanding > 0 && (
                    <div>
                      <dt>Balance</dt>
                      <dd>{money(stay.payment.outstanding)}</dd>
                    </div>
                  )}
                  {stay.status === 'pending' && stay.payBy && (
                    <div>
                      <dt>Pay by</dt>
                      <dd>{when(stay.payBy, stay.timezone)}</dd>
                    </div>
                  )}
                  {stay.heldUntil && (
                    <div>
                      <dt>Dates held until</dt>
                      <dd>{when(stay.heldUntil, stay.timezone)}</dd>
                    </div>
                  )}
                </dl>
              </>
            )}
            {stay.payments.length > 0 && (
              <ul className="stay-list">
                {stay.payments.map((p) => (
                  <li key={p.id}>
                    <span>
                      {p.kind === 'refund' ? 'Refund' : p.method} · {money(p.verifiedAmount ?? p.claimedAmount)}
                      <span className="small muted"> · {when(p.createdAt, stay.timezone)}</span>
                    </span>
                    <span className={`badge ${p.status === 'verified' ? 'ok' : p.status === 'rejected' ? 'danger' : 'warn'}`}>
                      {p.kind === 'refund' ? 'Recorded' : p.status === 'verified' ? 'Verified' : p.status === 'rejected' ? 'Rejected' : 'To check'}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </aside>
      </div>

      <Drawer open={reviewing !== null} title="Review the proof" onClose={() => setReviewing(null)}>
        {reviewing && (
          <ReviewProof
            key={reviewing.id}
            payment={reviewing}
            proofUrl={proof}
            stay={stay}
            busy={busy}
            error={notice?.kind === 'error' ? notice.message : null}
            onDecide={(decision) => void review(decision)}
            onCancel={() => setReviewing(null)}
          />
        )}
      </Drawer>

      <Drawer open={refundOpen} title="Record a refund" onClose={() => setRefundOpen(false)}>
        <form onSubmit={saveRefund}>
          <p className="small muted">For money you already returned. Nothing is sent from here. At most {money(stay.payment.received)}.</p>
          <div className="field-row">
            <div className="field narrow">
              <label htmlFor="refund-amount">Amount ({stay.currency})</label>
              <input id="refund-amount" required inputMode="decimal" value={refund.amount} onChange={(e) => setRefund({ ...refund, amount: e.target.value })} />
            </div>
            <div className="field grow">
              <label htmlFor="refund-method">Returned by</label>
              <input id="refund-method" required maxLength={40} placeholder="GCash" value={refund.method} onChange={(e) => setRefund({ ...refund, method: e.target.value })} />
            </div>
          </div>
          <div className="field">
            <label htmlFor="refund-note">Note</label>
            <input id="refund-note" required maxLength={500} value={refund.note} onChange={(e) => setRefund({ ...refund, note: e.target.value })} />
          </div>
          <div className="form-footer">
            <button type="submit" className="primary" disabled={busy}>
              Record refund
            </button>
          </div>
          {notice?.kind === 'error' && (
            <div className="notice error drawer-notice" role="alert">
              {notice.message}
            </div>
          )}
        </form>
      </Drawer>
    </StaffFrame>
  );
}
