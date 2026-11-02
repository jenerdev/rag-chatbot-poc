// missing.ts — D-155: what a form still needs, as data. Pure, browser-safe.
// components/missing-note.tsx draws it and takes the person to the field.

/** What a form still needs: one sentence, and the id of the field that takes it. */
export interface Missing {
  message: string;
  /** the element to focus: an input, select, textarea or a DateField's button */
  field?: string;
}

/** The first gap of a list of checks, in order; null when none. */
export function firstMissing(checks: ReadonlyArray<readonly [gap: boolean, message: string, field?: string]>): Missing | null {
  for (const [gap, message, field] of checks) if (gap) return field === undefined ? { message } : { message, field };
  return null;
}
