// Quick notes for S-15 (D-135): the ONE table of the sentences staff write
// most at each step of a stay. Every decision on the booking page takes a
// note (D-096), and most of them are required, so each note field offers a
// few one-click sentences that fill it; the text stays editable, and the
// server still demands a note of its own (review_payment(), decide_change(),
// move_room(), the routes). Pure, browser-safe, tested (quick-notes.test.ts).
//
// Two kinds of note, and the sentences read differently:
//   - shown to the guest (decline, cancel, a change request's decision, a
//     rejected proof): written TO the guest, in full sentences;
//   - for staff (confirm, a verified proof, a refund, a move, a staff note):
//     the fact, short.

export type QuickNoteStep =
  | 'confirm' // the stay is confirmed and a payment is already verified
  | 'confirm-unpaid' // confirmed with nothing verified: the note says how it was paid (stay-actions' confirmNeedsNote)
  | 'decline'
  | 'cancel'
  | 'approve-cancel'
  | 'approve-reschedule'
  | 'reject-change'
  | 'verify-proof'
  | 'reject-proof'
  | 'refund'
  | 'move'
  | 'staff-note';

/** The table. Three to five per step; the first is the commonest. */
export const QUICK_NOTES: Record<QuickNoteStep, readonly string[]> = {
  confirm: ['Payment verified; the dates are booked.', 'Confirmed with the guest by phone.', 'Regular guest, confirmed on request.'],
  'confirm-unpaid': ['Paid cash at the desk.', 'Paid by GCash, seen in the account.', 'Paid by bank transfer, seen in the account.', 'Will pay on arrival.', "Owner's guest, no payment needed."],
  decline: ['Sorry, the dates are no longer available.', 'The property is closed on those dates.', 'We could not reach you to confirm the booking.', 'No payment was received by the deadline.', 'The group is larger than the room allows.'],
  cancel: ['Cancelled at your request.', 'No show on the check-in date.', 'Cancelled after we could not reach you.', 'Sorry, we cannot host the stay on those dates.'],
  'approve-cancel': ['Your stay is cancelled. Any refund due follows our policy.', 'Cancelled as you asked; the refund will be sent within 7 days.', 'Cancelled as you asked. No refund is due under our policy.'],
  'approve-reschedule': ['Moved to your new dates. See you then!', 'Moved as you asked; any price difference is settled on arrival.', 'Moved as you asked; the price difference has been refunded.'],
  'reject-change': ['Sorry, the new dates are fully booked.', 'Cancellation is no longer possible under our policy.', 'The request came too close to check-in.', 'Please call us to arrange this.'],
  'verify-proof': ['Found in the bank account.', 'Found in GCash.', 'Amount matches the proof.', 'Partial payment; the balance is due on arrival.'],
  'reject-proof': ['The money is not in the account.', 'The amount received is different from the amount sent.', 'The photo is unreadable. Please send a clearer one.', 'This receipt is for another booking.'],
  refund: ['Returned the deposit after the cancellation.', 'Returned the overpayment.', 'Returned by GCash to the guest’s number.', 'Returned by bank transfer.'],
  move: ['The guest asked for this room.', 'Maintenance in the room.', 'Upgraded the guest at no charge.', 'Rooms swapped to fit the group.'],
  'staff-note': ['Asked for an early check-in.', 'Asked for a late check-out.', 'Arriving late; leave the key at the desk.', 'Called to confirm the arrival time.', 'Special request passed to housekeeping.'],
};

/** The quick notes for a step: for Confirm, which list depends on whether a payment is verified. */
export function quickNotes(step: QuickNoteStep): readonly string[] {
  return QUICK_NOTES[step];
}

/** Confirm's list: with nothing verified the note must say how the stay was paid. */
export function confirmQuickNotes(needsPaymentNote: boolean): readonly string[] {
  return QUICK_NOTES[needsPaymentNote ? 'confirm-unpaid' : 'confirm'];
}
