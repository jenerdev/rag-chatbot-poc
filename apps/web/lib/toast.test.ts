import { describe, expect, it } from 'vitest';
import { TOAST_LIMIT, pushToast, toastTimeout, type ToastItem } from './toast';

const ok = (id: number, message = `ok ${id}`): ToastItem => ({ id, message, kind: 'ok' });
const err = (id: number, message = `error ${id}`): ToastItem => ({ id, message, kind: 'error' });

describe('toastTimeout', () => {
  it('lets a success go by itself and keeps an error until closed', () => {
    expect(toastTimeout('ok')).toBeGreaterThan(0);
    expect(toastTimeout('error')).toBeNull();
  });
});

describe('pushToast', () => {
  it('adds the newest last', () => {
    expect(pushToast([ok(1)], err(2)).map((t) => t.id)).toEqual([1, 2]);
  });

  it(`keeps at most ${TOAST_LIMIT}, dropping the oldest`, () => {
    let items: ToastItem[] = [];
    for (let id = 1; id <= TOAST_LIMIT + 2; id++) items = pushToast(items, ok(id));
    expect(items.map((t) => t.id)).toEqual([3, 4, 5]);
  });

  it('replaces the same words instead of stacking a copy', () => {
    const items = pushToast([err(1, 'Could not cancel'), ok(2)], err(3, 'Could not cancel'));
    expect(items.map((t) => t.id)).toEqual([2, 3]);
  });

  it('keeps the same words of a different kind', () => {
    expect(pushToast([ok(1, 'Saved.')], err(2, 'Saved.'))).toHaveLength(2);
  });

  it('does not change the list it was given', () => {
    const items = [ok(1)];
    pushToast(items, ok(2));
    expect(items).toHaveLength(1);
  });
});
