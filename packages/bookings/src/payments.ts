// payments.ts — a guest's proof of payment (plan/manage-booking.md Phase 3).
//
// ONE guest write, on a CHAT token, in three steps:
//   1. match the guest: guestStay(), the same reference + contact as the
//      page's lookup. A miss is null (the route's one 404 sentence), and it
//      is counted toward the lockout like any lookup. Nothing is uploaded
//      for a stranger (plan § 2.7, wall 1);
//   2. upload the file to the PRIVATE `payment-proofs` bucket under
//      `<tenant>/incoming/<uuid>.<ext>`. The chat token may insert there and
//      nowhere else, and may never read it back (wall 2, Phase 0's spike);
//   3. submit_payment(), security definer: matches the guest again, checks
//      the method, amount, date and the object, and inserts the row. It is
//      the guard; steps 1 and 2 only spare the database a stranger's file.
//
// The type is decided by the file's first bytes, never its name or the
// Content-Type the browser sent: a PNG named ".pdf" is a PNG, and an HTML
// file named ".jpg" is refused. No SVG: it can carry script.
//
// The amount the guest types is a CLAIM. It verifies nothing; staff type the
// amount they found in the account (Phase 4, plan Rule 3).

import { randomUUID } from 'node:crypto';
import { BookingConflictError, BookingInputError } from './errors.js';
import { guestStay, MAX_GUEST_CONTACT, MAX_GUEST_REFERENCE } from './guest.js';
import type { BookingTenant } from './types.js';
import { isIsoDate, sniffImageType } from './validate.js';

/** Matches the bucket's file_size_limit (schema-manage-booking.sql § 17). */
export const MAX_PROOF_BYTES = 5 * 1024 * 1024;
export const PROOF_BUCKET = 'payment-proofs';
export const MAX_PAYER_REFERENCE = 60;
/** The browser resizes a photo of a receipt to this longer edge: larger than a room photo, so small print stays readable. */
export const MAX_PROOF_EDGE = 2000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ProofType = { ext: 'jpg' | 'png' | 'webp' | 'pdf'; contentType: string };

/** An image (as for room photos) or a PDF, by its first bytes; null for anything else. */
export function sniffProofType(bytes: Uint8Array): ProofType | null {
  const image = sniffImageType(bytes);
  if (image) return image as ProofType;
  // "%PDF-"
  if (bytes.length >= 5 && [0x25, 0x50, 0x44, 0x46, 0x2d].every((v, i) => bytes[i] === v)) {
    return { ext: 'pdf', contentType: 'application/pdf' };
  }
  return null;
}

export interface ProofInput {
  reference: string;
  contact: string;
  /** one of the tenant's method labels, as shown on the page */
  method: string;
  /** what the guest says they paid, in centavos */
  claimedAmount: number;
  /** YYYY-MM-DD, the day they paid */
  paidOn: string;
  /** the transaction number on their receipt, if any */
  payerReference: string | null;
  /** made when the page loaded, so a double click is one payment */
  idempotencyKey: string;
  file: Uint8Array;
}

/** The checks that need no database, in the guest's words. Pure, tested. */
export function checkProof(input: ProofInput): ProofType {
  if (!input.reference.trim() || !input.contact.trim()) throw new BookingInputError('Look up your booking first.');
  if (input.reference.trim().length > MAX_GUEST_REFERENCE || input.contact.trim().length > MAX_GUEST_CONTACT) {
    throw new BookingInputError('That reference or contact is too long.');
  }
  if (!input.method.trim()) throw new BookingInputError('Choose how you paid.');
  if (!Number.isSafeInteger(input.claimedAmount) || input.claimedAmount < 1) {
    throw new BookingInputError('Enter the amount you paid.');
  }
  if (!isIsoDate(input.paidOn)) throw new BookingInputError('Enter the date you paid.');
  if (input.payerReference !== null && input.payerReference.length > MAX_PAYER_REFERENCE) {
    throw new BookingInputError(`The transaction reference is too long (${MAX_PAYER_REFERENCE} characters at most).`);
  }
  if (!UUID.test(input.idempotencyKey)) throw new BookingInputError('Reload the page and try again.');
  if (input.file.length === 0) throw new BookingInputError('Attach a photo or PDF of your receipt.');
  if (input.file.length > MAX_PROOF_BYTES) {
    throw new BookingInputError(`The file is too large; the limit is ${MAX_PROOF_BYTES / 1048576} MB.`);
  }
  const type = sniffProofType(input.file);
  if (!type) throw new BookingInputError('The proof must be a JPG, PNG or WebP photo, or a PDF.');
  return type;
}

/** submit_payment()'s refusals, in its own words. */
function submitError(error: { code?: string; message: string }): Error | null {
  if (error.code === 'P0002') return null;
  if (error.code === '22023') return new BookingInputError(error.message);
  if (error.code === '55000') return new BookingConflictError(error.message);
  // The one-open-proof index, reached by two submissions at once.
  if (error.code === '23505') return new BookingConflictError('A payment for this booking is already being checked. Please wait for the resort to review it.');
  return new Error(`Could not submit the payment: ${error.message}`);
}

/**
 * Send a proof. `{ paymentId }`, or null when the reference and contact
 * match no stay (the caller says so in the lookup's one sentence).
 */
export async function submitProof(tenant: BookingTenant, input: ProofInput): Promise<{ paymentId: number } | null> {
  const type = checkProof(input);
  const stay = await guestStay(tenant, input.reference, input.contact);
  if (!stay) return null;

  const args = {
    p_tenant_id: tenant.id,
    p_reference: input.reference.trim(),
    p_contact: input.contact.trim(),
    p_method: input.method.trim(),
    p_claimed_amount: input.claimedAmount,
    p_paid_on: input.paidOn,
    p_payer_reference: input.payerReference?.trim() || null,
    p_idempotency_key: input.idempotencyKey,
  };

  // A proof already under review: upload nothing. The function still
  // answers, because the SAME key (a double click) gets the first row back,
  // and any other key gets the refusal in words.
  if (stay.payment.open) {
    const { data, error } = await tenant.db.rpc('submit_payment', { ...args, p_proof_path: '' });
    if (error) throw submitError(error) ?? new Error('The booking disappeared while submitting');
    return { paymentId: data as number };
  }
  if (stay.payment.status === 'not_tracked' || (stay.status !== 'pending' && stay.status !== 'confirmed')) {
    // The function would refuse too; this spares the bucket a file.
    const { error } = await tenant.db.rpc('submit_payment', { ...args, p_proof_path: '' });
    throw (error && submitError(error)) ?? new BookingConflictError('This booking takes no payment on this page.');
  }

  const path = `${tenant.id}/incoming/${randomUUID()}.${type.ext}`;
  const uploaded = await tenant.db.storage
    .from(PROOF_BUCKET)
    .upload(path, input.file, { contentType: type.contentType, upsert: false });
  if (uploaded.error) throw new Error(`Could not store the proof: ${uploaded.error.message}`);

  const { data, error } = await tenant.db.rpc('submit_payment', { ...args, p_proof_path: path });
  if (error) throw submitError(error) ?? new Error('The booking disappeared while submitting');
  return { paymentId: data as number };
}
