// The month view's grid (plan/calendar.md § 4.2–4.3, D-103). Pure: props in,
// no fetch, no state. A <table> (weekday headers a screen reader announces
// with each cell) with ONE button per date; the button's aria-label is what
// the cell shows, then the whole date in a sentence (buttonName(),
// calendar-labels.ts), so the colour, the short word and the markers inside
// it are for the eye and hidden from the accessibility tree. Tab moves through the dates; no arrow-key model (§ 7 q6).

import type { OccupancyDay } from '@rag/bookings';
import { Icon } from './icons';
import { buttonName, cellText, dayMarker } from '@/lib/calendar-labels';

const WEEKDAYS = [
  ['Mon', 'Monday'],
  ['Tue', 'Tuesday'],
  ['Wed', 'Wednesday'],
  ['Thu', 'Thursday'],
  ['Fri', 'Friday'],
  ['Sat', 'Saturday'],
  ['Sun', 'Sunday'],
] as const;

/** The classes a date's cell carries; shared with the week view's headers. */
export function dayClasses(day: OccupancyDay, today: string, extra = ''): string {
  return ['cal-day', day.state, day.day === today ? 'today' : '', !day.bookable && day.state !== 'closed' ? 'dim' : '', extra].filter(Boolean).join(' ');
}

/** What sits on top of a date's background: its holiday or peak, and its pending requests. */
export function DayMarkers({ day }: { day: OccupancyDay }) {
  const marker = dayMarker(day);
  return (
    <>
      {marker && (
        <span className={`cal-marker ${marker.kind}`}>
          <Icon name={marker.kind === 'holiday' ? 'star' : 'flame'} size={14} />
        </span>
      )}
      {day.pending > 0 && <span className="cal-pending">{day.pending}</span>}
    </>
  );
}

export function MonthGrid({
  days,
  month,
  today,
  caption,
  onPick,
}: {
  days: OccupancyDay[];
  /** "2026-10": dates outside it are the neighbouring months' (§ 2.6) */
  month: string;
  today: string;
  caption: string;
  onPick: (date: string) => void;
}) {
  const weeks: OccupancyDay[][] = [];
  for (let i = 0; i < days.length; i += 7) weeks.push(days.slice(i, i + 7));

  return (
    <table className="cal-month">
      <caption className="visually-hidden">{caption}</caption>
      <thead>
        <tr>
          {WEEKDAYS.map(([short, long]) => (
            <th key={short} scope="col" abbr={long}>
              {short}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {weeks.map((week) => (
          <tr key={week[0]?.day}>
            {week.map((day) => {
              const marker = dayMarker(day);
              return (
                <td key={day.day}>
                  <button
                    type="button"
                    className={dayClasses(day, today, day.day.startsWith(month) ? '' : 'other-month')}
                    aria-label={buttonName(
                      [Number(day.day.slice(8)), cellText(day), (marker || day.state === 'closed') && day.label ? day.label : null, day.pending > 0 ? day.pending : null],
                      day,
                      today,
                    )}
                    onClick={() => onPick(day.day)}
                  >
                    <span className="cal-num" aria-hidden="true">
                      {Number(day.day.slice(8))}
                    </span>
                    {/* The spaces between the parts make the visible text "16 Open", which the name leads with (buttonName). */}
                    {' '}
                    {cellText(day) && (
                      <span className="cal-word" aria-hidden="true">
                        {cellText(day)}
                      </span>
                    )}
                    {' '}
                    {(marker || day.state === 'closed') && (day.label ? <span className="cal-label" aria-hidden="true">{day.label}</span> : null)}{' '}
                    <span className="cal-markers" aria-hidden="true">
                      <DayMarkers day={day} />
                    </span>
                  </button>
                </td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
