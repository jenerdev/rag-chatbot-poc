import { describe, expect, it } from 'vitest';
import { risen, titleWithCount, type Attention, type AttentionItem } from './attention';

const item = (id: number, read = false): AttentionItem => ({
  id,
  kind: 'request',
  reference: `VIL-${id}`,
  title: 'New booking request',
  body: `VIL-${id} · Fri 16 Oct`,
  path: `/t/villa/admin/bookings/VIL-${id}`,
  at: '2026-10-14T03:00:00Z',
  read,
});
const feed = (...items: AttentionItem[]): Attention => ({ unread: items.filter((i) => !i.read).length, latest: items });

describe('titleWithCount', () => {
  it('prefixes the count, and never stacks two', () => {
    expect(titleWithCount('Bookings · Villa', 3)).toBe('(3) Bookings · Villa');
    expect(titleWithCount('(3) Bookings · Villa', 4)).toBe('(4) Bookings · Villa');
  });

  it('gives the title back when nothing is unread', () => {
    expect(titleWithCount('(3) Bookings · Villa', 0)).toBe('Bookings · Villa');
    expect(titleWithCount('Bookings · Villa', 0)).toBe('Bookings · Villa');
  });
});

describe('risen', () => {
  it('says nothing on the first read: what was there on load is not news', () => {
    expect(risen(null, feed(item(2), item(1)))).toEqual([]);
  });

  it('names each notification that arrived, oldest first', () => {
    expect(risen(feed(item(1)), feed(item(3), item(2), item(1)))).toEqual(['New booking request · VIL-2 · Fri 16 Oct', 'New booking request · VIL-3 · Fri 16 Oct']);
    expect(risen(feed(), feed(item(1)))).toEqual(['New booking request · VIL-1 · Fri 16 Oct']);
  });

  it('says nothing when nothing new came, or what came is already read (a tap on another device)', () => {
    expect(risen(feed(item(2), item(1)), feed(item(2, true), item(1)))).toEqual([]);
    expect(risen(feed(item(1)), feed(item(2, true), item(1)))).toEqual([]);
  });
});
