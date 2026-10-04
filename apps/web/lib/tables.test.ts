import { describe, expect, it } from 'vitest';
import { parseSegments } from './tables';

const TABLE = ['| Room | Guests | Price |', '|---|---|---|', '| Garden Room | up to 2 | ₱3,500.00 (weekend rate) |', '| Loft | up to 3 | ₱4,800.00 (weekend rate) |'].join('\n');

describe('parseSegments', () => {
  it('returns a plain reply as one text segment, byte for byte', () => {
    const reply = 'Yes, the Overnight slot is open on 8 October 2026.\n\nOpen:\n- Overnight ₱16,000.00\n\nTaken: None.';
    expect(parseSegments(reply)).toEqual([{ kind: 'text', text: reply }]);
  });

  it('returns nothing for an empty string', () => {
    expect(parseSegments('')).toEqual([]);
  });

  it('parses a table alone', () => {
    expect(parseSegments(TABLE)).toEqual([
      {
        kind: 'table',
        header: ['Room', 'Guests', 'Price'],
        rows: [
          ['Garden Room', 'up to 2', '₱3,500.00 (weekend rate)'],
          ['Loft', 'up to 3', '₱4,800.00 (weekend rate)'],
        ],
      },
    ]);
  });

  it('keeps text before and after a table, dropping the one blank line at each edge', () => {
    const reply = `On 18 October 2026 these rooms are open:\n\n${TABLE}\n\nTaken: Sea View Suite.`;
    const segments = parseSegments(reply);
    expect(segments.map((s) => s.kind)).toEqual(['text', 'table', 'text']);
    expect(segments[0]).toEqual({ kind: 'text', text: 'On 18 October 2026 these rooms are open:' });
    expect(segments[2]).toEqual({ kind: 'text', text: 'Taken: Sea View Suite.' });
  });

  it('keeps a second blank line: only one is the table\'s spacing', () => {
    const segments = parseSegments(`Intro:\n\n\n${TABLE}\n\n\nAfter.`);
    expect(segments[0]).toEqual({ kind: 'text', text: 'Intro:\n' });
    expect(segments[2]).toEqual({ kind: 'text', text: '\nAfter.' });
  });

  it('is text without the separator line', () => {
    const reply = '| Room | Guests |\n| Garden Room | up to 2 |';
    expect(parseSegments(reply)).toEqual([{ kind: 'text', text: reply }]);
  });

  it('is text when the separator is the first line (no header)', () => {
    const reply = '|---|---|\n| Garden Room | up to 2 |';
    expect(parseSegments(reply)).toEqual([{ kind: 'text', text: reply }]);
  });

  it('accepts alignment colons and spaces in the separator', () => {
    const segments = parseSegments('| Room | Price |\n| :--- | ---: |\n| Loft | ₱4,800.00 |');
    expect(segments).toEqual([{ kind: 'table', header: ['Room', 'Price'], rows: [['Loft', '₱4,800.00']] }]);
  });

  it('pads a short row and cuts a long one to the header\'s width', () => {
    const segments = parseSegments('| Slot | Status | Price |\n|---|---|---|\n| Day Tour | taken |\n| Overnight | open | ₱16,000.00 | extra |');
    expect(segments).toEqual([
      { kind: 'table', header: ['Slot', 'Status', 'Price'], rows: [['Day Tour', 'taken', ''], ['Overnight', 'open', '₱16,000.00']] },
    ]);
  });

  it('leaves a row still being streamed (no closing pipe yet) as text under the table', () => {
    const segments = parseSegments(`${TABLE}\n| Family Room | up to 6`);
    expect(segments.map((s) => s.kind)).toEqual(['table', 'text']);
    expect(segments[1]).toEqual({ kind: 'text', text: '| Family Room | up to 6' });
    expect((segments[0] as { rows: string[][] }).rows).toHaveLength(2);
  });

  it('leaves a header whose separator has not arrived as text', () => {
    const reply = 'Here are our rooms:\n\n| Room | Guests |';
    expect(parseSegments(reply)).toEqual([{ kind: 'text', text: reply }]);
  });

  it('ignores a pipe in prose', () => {
    const reply = 'Check-in is 14:00 | check-out is 12:00.';
    expect(parseSegments(reply)).toEqual([{ kind: 'text', text: reply }]);
  });

  it('parses Tagalog headers like any other text', () => {
    const segments = parseSegments('| Kwarto | Bisita |\n|---|---|\n| Garden Room | hanggang 2 |');
    expect(segments).toEqual([{ kind: 'table', header: ['Kwarto', 'Bisita'], rows: [['Garden Room', 'hanggang 2']] }]);
  });

  it('parses two tables with text between them', () => {
    const segments = parseSegments(`18 October:\n\n${TABLE}\n\n19 October:\n\n${TABLE}`);
    expect(segments.map((s) => s.kind)).toEqual(['text', 'table', 'text', 'table']);
    expect(segments[2]).toEqual({ kind: 'text', text: '19 October:' });
  });

  it('tolerates Windows newlines inside a row', () => {
    const segments = parseSegments('| A | B |\r\n|---|---|\r\n| 1 | 2 |');
    expect(segments).toEqual([{ kind: 'table', header: ['A', 'B'], rows: [['1', '2']] }]);
  });
});
