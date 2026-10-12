import { describe, expect, it } from 'vitest';
import type { OccupancyDay } from '@rag/bookings';
import { buttonName, cellText, dayMarker, sentence } from './calendar-labels';

const day = (patch: Partial<OccupancyDay>): OccupancyDay => ({
  day: '2026-10-16',
  state: 'available',
  taken: 0,
  sellable: 8,
  pending: 0,
  rateKind: 'weekday',
  label: null,
  bookable: true,
  ...patch,
});

describe('cellText', () => {
  it('says each state in words or a count', () => {
    expect(cellText(day({}))).toBe('Open');
    expect(cellText(day({ state: 'partial', taken: 3 }))).toBe('3 of 8');
    expect(cellText(day({ state: 'full', taken: 8 }))).toBe('Full');
    expect(cellText(day({ state: 'closed' }))).toBe('Closed');
    expect(cellText(day({ state: 'none', sellable: 0 }))).toBe('—');
  });

  it('says nothing on an available date that cannot be booked, but keeps a count', () => {
    expect(cellText(day({ bookable: false }))).toBe('');
    expect(cellText(day({ state: 'partial', taken: 3, bookable: false }))).toBe('3 of 8');
  });
});

describe('dayMarker', () => {
  it('marks a holiday and a peak date, with the label staff typed', () => {
    expect(dayMarker(day({ rateKind: 'holiday', label: 'All Saints' }))).toEqual({ kind: 'holiday', text: 'Holiday: All Saints' });
    expect(dayMarker(day({ rateKind: 'peak', label: null }))).toEqual({ kind: 'peak', text: 'Peak' });
  });

  it('leaves weekdays, weekends and closed dates unmarked', () => {
    expect(dayMarker(day({ rateKind: 'weekend' }))).toBeNull();
    expect(dayMarker(day({ rateKind: 'closed', label: 'Typhoon' }))).toBeNull();
  });
});

describe('sentence', () => {
  it('carries every fact of a busy date', () => {
    expect(sentence(day({ state: 'partial', taken: 3, pending: 1, rateKind: 'holiday', label: 'Araw ng mga Bayani' }), '2026-10-16')).toBe(
      'Friday 16 October 2026, today: partly booked, 3 of 8 taken, 1 pending request, holiday: Araw ng mga Bayani',
    );
  });

  it('names a closed date and why', () => {
    expect(sentence(day({ state: 'closed', rateKind: 'closed', label: 'Typhoon', bookable: false }), '2026-10-01')).toBe('Friday 16 October 2026: closed (Typhoon)');
  });

  it('tells the past from beyond the booking window', () => {
    expect(sentence(day({ bookable: false }), '2026-10-20')).toBe('Friday 16 October 2026: available, in the past');
    expect(sentence(day({ bookable: false }), '2025-01-01')).toBe('Friday 16 October 2026: available, beyond the booking window');
  });

  it('counts requests in the plural', () => {
    expect(sentence(day({ pending: 2 }), '2026-10-01')).toBe('Friday 16 October 2026: available, 2 pending requests');
  });
});

describe('buttonName', () => {
  it('leads with what the cell shows, so the visible words are in the name (WCAG 2.5.3)', () => {
    expect(buttonName([16, 'Open', null, null], day({}), '2026-10-01')).toBe('16 Open. Friday 16 October 2026: available');
    expect(buttonName(['Fri', '16', '3 of 8', 1], day({ state: 'partial', taken: 3, pending: 1 }), '2026-10-01')).toBe(
      'Fri 16 3 of 8 1. Friday 16 October 2026: partly booked, 3 of 8 taken, 1 pending request',
    );
  });
});
