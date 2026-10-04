import { describe, expect, it } from 'vitest';
import { pipeTable } from './tables.js';

describe('pipeTable', () => {
  it('writes a header, a separator and the rows', () => {
    expect(pipeTable(['Room', 'Guests'], [['Garden Room', 'up to 2'], ['Cottage', '']])).toBe(
      '| Room | Guests |\n|---|---|\n| Garden Room | up to 2 |\n| Cottage |  |',
    );
  });

  it('never lets a pipe or a newline into a cell', () => {
    expect(pipeTable(['Room'], [['Sea | View\nSuite']])).toBe('| Room |\n|---|\n| Sea View Suite |');
  });
});
