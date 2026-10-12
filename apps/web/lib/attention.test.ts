import { describe, expect, it } from 'vitest';
import { attentionFor, risen, titleWithCount } from './attention';

const none = { requests: 0, proofs: 0, changes: 0 };

describe('attentionFor', () => {
  it('puts requests and changes on Bookings, proofs on Payments', () => {
    expect(attentionFor({ requests: 2, proofs: 1, changes: 1 }, 'admin')).toEqual({ bookings: 3, payments: 1, total: 4 });
    expect(attentionFor({ requests: 2, proofs: 1, changes: 1 }, 'staff')).toEqual({ bookings: 3, payments: 1, total: 4 });
  });

  it('tells nobody who is not signed in', () => {
    expect(attentionFor({ requests: 2, proofs: 1, changes: 1 }, null)).toEqual({ bookings: 0, payments: 0, total: 0 });
  });
});

describe('titleWithCount', () => {
  it('prefixes the count, and never stacks two', () => {
    expect(titleWithCount('Bookings · Villa', 3)).toBe('(3) Bookings · Villa');
    expect(titleWithCount('(3) Bookings · Villa', 4)).toBe('(4) Bookings · Villa');
  });

  it('gives the title back when nothing waits', () => {
    expect(titleWithCount('(3) Bookings · Villa', 0)).toBe('Bookings · Villa');
    expect(titleWithCount('Bookings · Villa', 0)).toBe('Bookings · Villa');
  });
});

describe('risen', () => {
  it('says nothing on the first read: what was there on load is not news', () => {
    expect(risen(null, { requests: 2, proofs: 1, changes: 0 }, 'owner')).toEqual([]);
  });

  it('names each kind that rose, one or several', () => {
    expect(risen(none, { requests: 1, proofs: 0, changes: 0 }, 'staff')).toEqual(['New booking request']);
    expect(risen(none, { requests: 2, proofs: 1, changes: 1 }, 'owner')).toEqual(['2 new booking requests', 'A guest asks to change a stay', 'A proof of payment to verify']);
  });

  it('says nothing when a count falls or holds', () => {
    expect(risen({ requests: 3, proofs: 1, changes: 0 }, { requests: 2, proofs: 1, changes: 0 }, 'owner')).toEqual([]);
  });
});
