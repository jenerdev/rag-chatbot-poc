// count-field.tsx — the party inputs (D-147 amended, the user: "improve the
// layout of number of guest inputs, including the children/free guest").
//
// One count is a CountField: a small label OVER a compact number input, so
// "Guests" and "Children aged 3 and below" read the same way instead of one
// as a placeholder inside the box and the other as a label beside it. A
// room's counts sit in ONE PartyRow, side by side, with the room's name
// over the row when the type is booked more than once. The booking page
// (S-6) and the staff form (S-3) both draw these, so a guest and a staff
// member see the same shape (D-111). The styles are `.party-row` and
// `.count-field` in screens.css; the inputs stay NATIVE (D-142).

import type { InputHTMLAttributes, ReactNode } from 'react';

/** A labelled number input. With an `id`, the label is tied to it; without one, it wraps it. */
export function CountField({ label, id, ...input }: { label: string } & InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className="count-field" htmlFor={id}>
      <span>{label}</span>
      <input type="number" step={1} id={id} {...input} />
    </label>
  );
}

/** One room's counts in a row; `name` ("Room 2") heads the row when there are several rooms of a type. */
export function PartyRow({ name, children }: { name?: string; children: ReactNode }) {
  return (
    <div className="party-row">
      {name && <span className="party-row-name">{name}</span>}
      {children}
    </div>
  );
}
