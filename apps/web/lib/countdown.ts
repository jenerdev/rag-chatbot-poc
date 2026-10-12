// The time left before a deadline, in words a guest reads at a glance.
// Pure, browser-safe, tested (countdown.test.ts). The deadline itself is the
// database's (stays.pay_by); this only says how far away it is.

/**
 * "2d 3h 41m 05s", "23h 41m 05s", "41m 05s", "0m 09s": always to the second,
 * from the largest unit that is not zero. Zero or less is "0m 00s";
 * the caller says what a passed deadline means.
 */
export function timeLeft(left: number): string {
  const total = Math.max(0, Math.floor(left / 1000));
  const days = Math.floor(total / 86_400);
  const hours = Math.floor((total % 86_400) / 3_600);
  const minutes = Math.floor((total % 3_600) / 60);
  const seconds = String(total % 60).padStart(2, '0');
  if (days > 0) return `${days}d ${hours}h ${minutes}m ${seconds}s`;
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  return `${minutes}m ${seconds}s`;
}
