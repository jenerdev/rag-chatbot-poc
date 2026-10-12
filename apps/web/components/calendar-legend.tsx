// The staff calendar's legend (plan/calendar.md § 4.1, D-103): every swatch
// and marker the views draw, beside its word, in the same classes the cells
// use, so the legend cannot drift from the grid. A list, so a screen reader
// reads it as one. The cells say all of this in words too (Rule 4); the
// legend is for the eye.

import { Icon } from './icons';
import { Tip } from './tooltip';

const SWATCHES = [
  ['available', 'Available'],
  ['partial', 'Partly booked'],
  ['full', 'Fully booked'],
  ['closed', 'Closed'],
] as const;

export function CalendarLegend() {
  return (
    <div className="cal-legend-wrap">
      <ul className="cal-legend" aria-label="Legend">
        {SWATCHES.map(([state, word]) => (
          <li key={state}>
            <span className={`cal-swatch ${state}`} aria-hidden="true" />
            {word}
          </li>
        ))}
        <li>
          <span className="cal-marker holiday" aria-hidden="true">
            <Icon name="star" size={14} />
          </span>
          Holiday
        </li>
        <li>
          <span className="cal-marker peak" aria-hidden="true">
            <Icon name="flame" size={14} />
          </span>
          Peak
        </li>
        <li>
          <span className="cal-pending" aria-hidden="true">
            1
          </span>
          Pending requests
        </li>
        <li>
          <span className="cal-swatch today" aria-hidden="true" />
          Today
        </li>
        <li>
          <span className="cal-swatch dim" aria-hidden="true" />
          Past or not yet open
        </li>
        <li>
          {/* How a date is counted, on request: it was a sentence under the key on every visit. */}
          <Tip label="Counted over today’s rooms and slots. A stay that began the day before counts on this date too, booked or pending." describe>
            <button type="button" className="ghost sm cal-key-info" aria-label="How dates are counted">
              <Icon name="help" size={14} /> How it is counted
            </button>
          </Tip>
        </li>
      </ul>
    </div>
  );
}
