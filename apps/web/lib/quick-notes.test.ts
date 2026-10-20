import { describe, expect, it } from 'vitest';
import { QUICK_NOTES, confirmQuickNotes, quickNotes, type QuickNoteStep } from './quick-notes';

const STEPS: QuickNoteStep[] = ['confirm', 'confirm-unpaid', 'decline', 'cancel', 'approve-cancel', 'approve-reschedule', 'reject-change', 'verify-proof', 'reject-proof', 'refund', 'move', 'staff-note'];

describe('quick notes', () => {
  it('has three to five short, distinct sentences for every step', () => {
    for (const step of STEPS) {
      const list = quickNotes(step);
      expect(list.length, step).toBeGreaterThanOrEqual(3);
      expect(list.length, step).toBeLessThanOrEqual(5);
      expect(new Set(list).size, step).toBe(list.length);
      for (const note of list) {
        // Short enough for a chip, and a sentence: the guest reads some of them.
        expect(note.length, note).toBeLessThanOrEqual(80);
        expect(note.trim(), note).toBe(note);
        expect(/[.!]$/.test(note), note).toBe(true);
      }
    }
    expect(Object.keys(QUICK_NOTES).sort()).toEqual([...STEPS].sort());
  });

  it("fits every server's bound: the shortest note limit is 500", () => {
    for (const list of Object.values(QUICK_NOTES)) for (const note of list) expect(note.length).toBeLessThan(500);
  });

  it('offers how the stay was paid when Confirm has nothing verified, and plain confirmations otherwise', () => {
    expect(confirmQuickNotes(true)).toBe(QUICK_NOTES['confirm-unpaid']);
    expect(confirmQuickNotes(false)).toBe(QUICK_NOTES.confirm);
    expect(confirmQuickNotes(true).some((n) => /cash/i.test(n))).toBe(true);
  });

  it('speaks to the guest on the notes the guest reads', () => {
    for (const step of ['decline', 'cancel', 'approve-cancel', 'approve-reschedule', 'reject-change', 'reject-proof'] as const) {
      // Never a staff-only word the guest should not see.
      for (const note of quickNotes(step)) expect(/desk|housekeeping|owner/i.test(note), `${step}: ${note}`).toBe(false);
    }
  });
});
