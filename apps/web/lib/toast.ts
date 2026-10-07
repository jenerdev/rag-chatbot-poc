// The rules of the toast queue (plan/ui-components.md Phase 1), pure so they
// are tested without a browser. components/toast.tsx draws what these return.

export type ToastKind = 'ok' | 'error';

export interface ToastItem {
  id: number;
  message: string;
  kind: ToastKind;
}

/** At most this many on screen; a fourth pushes out the oldest. */
export const TOAST_LIMIT = 3;

/**
 * How long a toast stays, in ms, or null for "until closed". A success can
 * go by itself. An error stays, because it may need acting on, and WCAG
 * 2.2.1 says no timed reading of that.
 */
export function toastTimeout(kind: ToastKind): number | null {
  return kind === 'ok' ? 5000 : null;
}

/**
 * The queue with `item` added last. The same words again (a second click on
 * the same failing button) replace the old toast instead of stacking a copy,
 * so the newest one is the one on screen and its timer starts again.
 */
export function pushToast(items: readonly ToastItem[], item: ToastItem): ToastItem[] {
  const rest = items.filter((t) => !(t.message === item.message && t.kind === item.kind));
  return [...rest, item].slice(-TOAST_LIMIT);
}
