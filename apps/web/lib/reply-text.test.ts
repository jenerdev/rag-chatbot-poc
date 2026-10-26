import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { groupRows, ReplyText } from '../components/reply-text';

// The component rendered to static markup: what React makes of the segments,
// and above all that cell TEXT stays text (plan/tables.md Rule 1).
const render = (text: string) => renderToStaticMarkup(createElement(ReplyText, { text }));

describe('ReplyText', () => {
  it('renders a plain reply as one text span, escaped', () => {
    const html = render('Open:\n- Overnight <b>₱16,000.00</b>');
    expect(html).toBe('<span class="reply-text">Open:\n- Overnight &lt;b&gt;₱16,000.00&lt;/b&gt;</span>');
  });

  it('renders a pipe table as a <table> with the cells as text', () => {
    const html = render('Here are our rooms:\n\n| Room | Guests | Price |\n|---|---|---|\n| Garden Room | up to 2 | ₱3,500.00 (weekend rate) |\n\nTell me a date.');
    expect(html).toContain('<span class="reply-text">Here are our rooms:</span>');
    // The Price column is amounts, so its header carries the class too (centred by CSS).
    expect(html).toContain('<div class="reply-table"><table><thead><tr><th>Room</th><th>Guests</th><th class="amount">Price</th></tr></thead>');
    // Each cell carries its column name for the phone layout; the first is the row's key (its title there).
    expect(html).toContain(
      '<tbody><tr><td data-label="Room" class="key">Garden Room</td><td data-label="Guests">up to 2</td><td data-label="Price" class="amount">₱3,500.00 (weekend rate)</td></tr></tbody>',
    );
    expect(html).toContain('<span class="reply-text">Tell me a date.</span>');
  });

  it('never turns a cell into markup', () => {
    const html = render('| Room | Note |\n|---|---|\n| <img src=x onerror=alert(1)> | <script>x</script> |');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<script');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('renders nothing for an empty reply', () => {
    expect(render('')).toBe('');
  });

  it('renders **bold** as <strong> with a text child, in prose and in a cell', () => {
    expect(render('Our **Garden Room** sleeps 2.')).toBe('<span class="reply-text">Our <strong>Garden Room</strong> sleeps 2.</span>');
    const html = render('| Room | Guests |\n|---|---|\n| **Loft** | up to 3 |');
    expect(html).toContain('<td data-label="Room" class="key"><strong>Loft</strong></td>');
  });

  it('a bold run is still text, never markup', () => {
    expect(render('**<b>x</b>**')).toBe('<span class="reply-text"><strong>&lt;b&gt;x&lt;/b&gt;</strong></span>');
  });

  // D-094: with the rooms' photos, a room table is cards; a table that names
  // none of the rooms stays a table.
  it('draws a room table as cards with photos when the cards are given', () => {
    const cards = [
      { name: 'Garden Room', photos: ['https://x/garden-1.webp', 'https://x/garden-2.webp'] },
      { name: 'Loft', photos: [] },
    ];
    const text = 'Here are our rooms:\n\n| Room | Guests | Details |\n|---|---|---|\n| **Garden Room** | up to 2 | Opens onto the garden. |\n| Loft | up to 3 |  |\n\nTell me a date.';
    const html = renderToStaticMarkup(createElement(ReplyText, { text, cards, view: 'cards' }));
    expect(html).toContain('<div class="room-cards" role="region" aria-label="Rooms" tabindex="0">');
    expect(html).toContain('<img src="https://x/garden-1.webp" alt="Garden Room" loading="lazy"/>');
    expect(html).toMatch(/<span class="room-card-count"><svg[^>]*>.*?<\/svg>2 photos<\/span>/);
    expect(html).toContain('<div class="room-card-title"><strong>Garden Room</strong></div>');
    // plan/room-cards.md: a short cell is a fact chip; a sentence is the card's text, unlabelled when alone.
    expect(html).toContain('<li><span class="room-card-label">Guests</span><span class="room-card-value">up to 2</span></li>');
    expect(html).toContain('<p class="room-card-text">Opens onto the garden.</p>');
    // The Loft has no photo: a card with no <img>, and its empty Details cell is left out.
    expect(html).not.toContain('alt="Loft"');
    expect(html).not.toContain('<table');
    expect(html).toContain('<span class="reply-text">Tell me a date.</span>');
  });

  it('in column view, a room table keeps its shape and the photo button sits under the room name', () => {
    const cards = [
      { name: 'Garden Room', photos: ['https://x/g1.webp', 'https://x/g2.webp'] },
      { name: 'Loft', photos: [] },
    ];
    const text = '💰 Here are our rates:\n\n| Room | Slot | Weekday | Weekend | Holiday |\n|---|---|---|---|---|\n| Garden Room | Night | ₱3,500.00 | ₱4,500.00 | ₱4,500.00 |\n| Loft | Night | ₱4,800.00 | ₱5,800.00 | ₱5,800.00 |';
    const html = renderToStaticMarkup(createElement(ReplyText, { text, cards, view: 'column' }));
    expect(html).toContain('<table');
    expect(html).not.toContain('room-cards');
    // No Photo column (D-094 amended 2026-10-21): the header is the reply's own.
    expect(html).toContain('<thead><tr><th>Room</th><th>Slot</th><th class="amount">Weekday</th><th class="amount">Weekend</th><th class="amount">Holiday</th></tr></thead>');
    expect(html).not.toContain('Photo');
    // One <tbody class="group"> per room; the button names what it opens, and says "2 photos" like the cards' badge.
    expect(html).toMatch(
      /<tbody class="group"><tr><td data-label="Room" class="key">Garden Room<button type="button" class="photo-link" aria-label="See 2 photos of Garden Room"><svg[^>]*>.*?<\/svg>2 photos<\/button><\/td><td data-label="Slot">Night<\/td>/,
    );
    // The Loft has no photo: its name alone, no button.
    expect(html).toContain('<tbody class="group"><tr><td data-label="Room" class="key">Loft</td><td data-label="Slot">Night</td>');
    expect(html).not.toContain('of Loft');
    // Every room has one row, so no second cell is a sub-heading on a phone.
    expect(html).not.toContain('class="sub"');
  });

  // D-094 amended 2026-10-21: the rate card has a row per room AND slot, so
  // the room's rows are one group, the name drawn once across them.
  it('groups the rows of one room: the name and the photo button once, spanning its slots', () => {
    const cards = [{ name: 'Casa Uno', photos: ['https://x/c1.webp'] }, { name: 'Loft', photos: [] }];
    const text =
      '| Room | Slot | Weekday | Weekend |\n|---|---|---|---|\n| Casa Uno | Day Use | ₱2,500.00 | ₱3,200.00 |\n| **Casa Uno** | Overnight | ₱3,800.00 | ₱4,800.00 |\n| Loft | Overnight | ₱5,000.00 | ₱6,200.00 |';
    const html = renderToStaticMarkup(createElement(ReplyText, { text, cards, view: 'column' }));
    // Two groups: Casa Uno's two slots (the model's ** on the second does not split them), then the Loft's one.
    expect(html.match(/<tbody class="group">/g)).toHaveLength(2);
    expect(html).toMatch(
      /<td data-label="Room" class="key" rowSpan="2">Casa Uno<button type="button" class="photo-link" aria-label="See 1 photo of Casa Uno">.*?1 photo<\/button><\/td><td data-label="Slot" class="sub">Day Use<\/td>/,
    );
    // The second slot's row starts at the Slot cell: no second name, no second button.
    expect(html).toContain('</tr><tr><td data-label="Slot" class="sub">Overnight</td><td data-label="Weekday" class="amount">₱3,800.00</td>');
    expect(html.match(/photo-link/g)).toHaveLength(1);
    // A room with one row spans nothing.
    expect(html).toContain('<td data-label="Room" class="key">Loft</td>');
    expect(html).not.toContain('rowSpan="1"');
  });

  // 2026-10-26, the user: "price table is broken when the resort is villa".
  // A plain table (no cards: villa's rate card, one unit so no Room column)
  // is one group of every row, and the span was set on each row's first
  // cell, so the rows slid one column right in a staircase. A plain table
  // spans nothing: every row starts at its own key cell.
  it('a plain table of several rows spans nothing: each row starts at its own key cell', () => {
    const html = render(
      '💰 Here are our rates:\n\n| Slot | Weekday | Weekend | Holiday |\n|---|---|---|---|\n' +
        '| 22-Hour Whole Day | ₱22,000.00 | ₱27,000.00 | ₱27,000.00 |\n| Day Tour | ₱9,500.00 | ₱12,000.00 | ₱12,000.00 |\n| Overnight | ₱16,000.00 | ₱20,000.00 | ₱20,000.00 |',
    );
    expect(html).not.toContain('rowSpan');
    expect(html).not.toContain('class="group"');
    expect(html.match(/<tr><td data-label="Slot" class="key">/g)).toHaveLength(3);
    expect(html).toContain('<tr><td data-label="Slot" class="key">Day Tour</td><td data-label="Weekday" class="amount">₱9,500.00</td>');
    expect(html).toContain('<tr><td data-label="Slot" class="key">Overnight</td><td data-label="Weekday" class="amount">₱16,000.00</td>');
  });

  it('groupRows merges neighbours only, ignoring case and **', () => {
    const rows = [['Kubo A', '1'], ['**kubo a**', '2'], ['Kubo B', '3'], ['Kubo A', '4']];
    expect(groupRows(rows).map((g) => g.length)).toEqual([2, 1, 1]);
    expect(groupRows([])).toEqual([]);
  });

  it('a table that names none of the rooms is still a table, cards or not', () => {
    const cards = [{ name: 'Garden Room', photos: ['https://x/g.webp'] }];
    const html = renderToStaticMarkup(createElement(ReplyText, { text: '| Slot | Price |\n|---|---|\n| Overnight | ₱20,000.00 |', cards }));
    expect(html).toContain('<table');
    expect(html).not.toContain('room-cards');
  });

  it('a price with an emoji in front is still an amount column', () => {
    const html = render('| Slot | Price |\n|---|---|\n| Overnight | 💰 ₱20,000.00 |');
    expect(html).toContain('<th>Slot</th><th class="amount">Price</th>');
  });
});
