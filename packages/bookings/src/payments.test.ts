// payments.ts's pure part (plan/manage-booking.md Phase 3): the checks a proof
// passes before anything is uploaded. submit_payment() checks again in SQL
// (rooms 51–55 prove that side).

import { describe, expect, it } from 'vitest';
import { BookingInputError } from './errors.js';
import { checkProof, MAX_PROOF_BYTES, sniffProofType, type ProofInput } from './payments.js';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const PDF = new TextEncoder().encode('%PDF-1.4\n%%EOF\n');

const valid: ProofInput = {
  reference: 'HAR-7KQ4MX',
  contact: 'maria@example.com',
  method: 'GCash',
  claimedAmount: 135000,
  paidOn: '2026-10-10',
  payerReference: '1234 5678 9012',
  idempotencyKey: '0b6c1b8e-2d1f-4f39-9a55-3c7b1f6d2e10',
  file: PNG,
};

describe('sniffProofType', () => {
  it('knows an image and a PDF by their first bytes, and nothing else', () => {
    expect(sniffProofType(PNG)?.ext).toBe('png');
    expect(sniffProofType(PDF)).toEqual({ ext: 'pdf', contentType: 'application/pdf' });
    expect(sniffProofType(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull();
    expect(sniffProofType(new TextEncoder().encode('<html>'))).toBeNull();
  });
});

describe('checkProof', () => {
  it('passes a proof, typed by its bytes: a PNG named ".pdf" is still a PNG', () => {
    expect(checkProof(valid).ext).toBe('png');
    expect(checkProof({ ...valid, file: PDF }).ext).toBe('pdf');
  });

  it('refuses, in words, what the database would refuse anyway', () => {
    const refused = (patch: Partial<ProofInput>) => () => checkProof({ ...valid, ...patch });
    expect(refused({ file: new Uint8Array(0) })).toThrow(/Attach a photo or PDF/);
    expect(refused({ file: new Uint8Array(MAX_PROOF_BYTES + 1).fill(0x89) })).toThrow(/too large/);
    expect(refused({ file: new TextEncoder().encode('GIF89a') })).toThrow(/JPG, PNG or WebP photo, or a PDF/);
    expect(refused({ claimedAmount: 0 })).toThrow(/amount you paid/);
    expect(refused({ claimedAmount: 12.5 })).toThrow(/amount you paid/);
    expect(refused({ paidOn: '10/10/2026' })).toThrow(/date you paid/);
    expect(refused({ method: '  ' })).toThrow(/how you paid/);
    expect(refused({ payerReference: 'x'.repeat(61) })).toThrow(/too long/);
    expect(refused({ idempotencyKey: 'abc' })).toThrow(/Reload the page/);
    expect(refused({ reference: '' })).toThrow(BookingInputError);
  });
});
