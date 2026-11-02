import { describe, expect, it } from 'vitest';
import { firstMissing } from './missing';

// D-155: a form's button stays on; this is what a click with a gap is told.
describe('firstMissing (D-155)', () => {
  it('names the FIRST gap, in the order the form is filled', () => {
    expect(
      firstMissing([
        [false, 'Choose the date.', 'day'],
        [true, 'Give it a name.', 'label'],
        [true, 'Enter the surcharge.', 'surcharge'],
      ]),
    ).toEqual({ message: 'Give it a name.', field: 'label' });
  });
  it('is null when nothing is missing', () => {
    expect(firstMissing([[false, 'Choose the date.', 'day']])).toBeNull();
    expect(firstMissing([])).toBeNull();
  });
  it('a gap with no field to point at is the sentence alone', () => {
    expect(firstMissing([[true, 'Choose a room.']])).toEqual({ message: 'Choose a room.' });
  });
});
