import { describe, expect, it } from 'vitest';
import { cardParts, FACT_MAX } from '@/components/room-cards';

// plan/room-cards.md: a card's short cells are fact chips, its long cells
// its text; an empty cell is left out.
describe('cardParts', () => {
  const header = ['Room', 'Guests', 'Rate', 'Details', 'Notes'];

  it('puts short cells in chips and sentences in the text, in column order', () => {
    const row = ['Casa Uno', 'up to 3', '₱3,500.00', 'On the reception level, has one queen bed and a folding bed.', ''];
    expect(cardParts(header, row)).toEqual({
      facts: [
        { label: 'Guests', value: 'up to 3' },
        { label: 'Rate', value: '₱3,500.00' },
      ],
      texts: [{ label: 'Details', value: 'On the reception level, has one queen bed and a folding bed.' }],
    });
  });

  it('measures without the bold markers, at the limit', () => {
    const exactly = 'x'.repeat(FACT_MAX);
    expect(cardParts(header, ['A', `**${exactly}**`]).facts).toHaveLength(1);
    expect(cardParts(header, ['A', `${exactly}y`]).texts).toHaveLength(1);
  });

  it('makes a sentence text however short, and keeps a short phrase with a full stop-free price a chip', () => {
    expect(cardParts(header, ['A', 'Opens onto the garden.']).texts).toHaveLength(1);
    expect(cardParts(header, ['A', 'Sea view']).facts).toHaveLength(1);
    expect(cardParts(header, ['A', 'No.']).facts).toHaveLength(1);
  });

  it('leaves out empty and blank cells', () => {
    expect(cardParts(header, ['A', '', '  '])).toEqual({ facts: [], texts: [] });
  });
});
