import { describe, expect, it } from 'vitest';
import { eventWords, statusWords } from './stay-words';

const ev = (over: Record<string, unknown>) => ({ at: '2026-10-12T04:25:00Z', actor: 'staff', actorUser: null, kind: 'status', from: null, to: null, amount: null, note: null, ...over }) as never;

describe('statusWords', () => {
  it('says a pending stay cancelled was declined, a confirmed one cancelled', () => {
    expect(statusWords('pending', 'cancelled')).toBe('Declined');
    expect(statusWords('confirmed', 'cancelled')).toBe('Cancelled');
    expect(statusWords('pending', 'confirmed')).toBe('Confirmed');
    expect(statusWords('pending', 'expired')).toBe('Expired');
  });
});

describe('eventWords', () => {
  it('names the door a stay came through, and quotes a note', () => {
    expect(eventWords(ev({ kind: 'created', to: 'pending', note: 'web' }), 'PHP')).toBe('Booked on the booking page');
    expect(eventWords(ev({ kind: 'created', to: 'pending', note: 'staff' }), 'PHP')).toBe('Booked by staff');
    expect(eventWords(ev({ from: 'pending', to: 'cancelled', note: 'fully booked' }), 'PHP')).toBe('Declined: “fully booked”');
  });
});
