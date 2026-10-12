// When a slot ends, from its start ("HH:MM") and length in minutes: the wall
// time and how many days later. Pure, browser-safe, tested (slot-span.test.ts).
// Wall-clock arithmetic only, for reading back what staff typed; Postgres
// turns a slot into instants (slot_range(), CLAUDE.md trap 9).

export interface SlotEnd {
  /** "15:00" */
  time: string;
  /** 0 the same day, 1 the next, … */
  days: number;
}

export function slotEnd(start: string, minutes: number): SlotEnd | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(start);
  if (!m || !Number.isFinite(minutes) || minutes <= 0) return null;
  const total = Number(m[1]) * 60 + Number(m[2]) + minutes;
  const days = Math.floor(total / 1440);
  const rest = total % 1440;
  return { time: `${String(Math.floor(rest / 60)).padStart(2, '0')}:${String(rest % 60).padStart(2, '0')}`, days };
}

/** "the same day", "the next day", "2 days later". */
export function dayWords(days: number): string {
  return days === 0 ? 'the same day' : days === 1 ? 'the next day' : `${days} days later`;
}
