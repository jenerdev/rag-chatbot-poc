import { describe, expect, it } from 'vitest';
import { eventWords, pendingState, statusWords } from './stay-words';

const ev = (over: Record<string, unknown>) => ({ at: '2026-10-12T04:25:00Z', actor: 'staff', actorUser: null, kind: 'status', from: null, to: null, amount: null, note: null, ...over }) as never;

describe('statusWords', () => {
  it('says a pending stay cancelled was declined, a confirmed one cancelled', () => {
    expect(statusWords('pending', 'cancelled')).toBe('Declined');
    expect(statusWords('confirmed', 'cancelled')).toBe('Cancelled');
    expect(statusWords('pending', 'confirmed')).toBe('Confirmed');
    expect(statusWords('pending', 'expired')).toBe('Expired');
  });
});

describe('pendingState', () => {
  it('names what a pending stay waits for', () => {
    expect(pendingState(null).label).toBe('Pending');
    expect(pendingState({ status: 'not_tracked', enough: false }).label).toBe('Pending');
    expect(pendingState({ status: 'unpaid', enough: false }).label).toBe('Awaiting payment');
    expect(pendingState({ status: 'rejected', enough: false }).label).toBe('Awaiting payment');
    expect(pendingState({ status: 'partially_paid', enough: false }).label).toBe('Awaiting payment');
    expect(pendingState({ status: 'submitted', enough: false }).label).toBe('Proof to check');
    expect(pendingState({ status: 'paid', enough: true })).toEqual({ label: 'Paid, to confirm', tone: 'ok' });
  });
});

describe('eventWords', () => {
  it('names the door a stay came through, and quotes a note', () => {
    expect(eventWords(ev({ kind: 'created', to: 'pending', note: 'web' }), 'PHP')).toBe('Booked on the booking page');
    expect(eventWords(ev({ kind: 'created', to: 'pending', note: 'staff' }), 'PHP')).toBe('Booked by staff');
    expect(eventWords(ev({ from: 'pending', to: 'cancelled', note: 'fully booked' }), 'PHP')).toBe('Declined: “fully booked”');
  });

  it('says a room move from where to where, and why (D-133)', () => {
    expect(eventWords(ev({ kind: 'room', from: 'Casa Uno 1', to: 'Casa Uno 2', note: 'by the pool' }), 'PHP')).toBe('Moved from Casa Uno 1 to Casa Uno 2: “by the pool”');
  });
});
