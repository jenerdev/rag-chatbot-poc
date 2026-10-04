import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ReplyText } from '../components/reply-text';

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
    // Each cell carries its column name for the phone layout.
    expect(html).toContain(
      '<tr><td data-label="Room">Garden Room</td><td data-label="Guests">up to 2</td><td data-label="Price" class="amount">₱3,500.00 (weekend rate)</td></tr>',
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
    expect(html).toContain('<td data-label="Room"><strong>Loft</strong></td>');
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
    expect(html).toContain('<div class="room-cards">');
    expect(html).toContain('<img src="https://x/garden-1.webp" alt="Garden Room" loading="lazy"/>');
    expect(html).toContain('<span class="room-card-count">2 photos</span>');
    expect(html).toContain('<div class="room-card-title"><strong>Garden Room</strong></div>');
    expect(html).toContain('<span class="room-card-label">Guests</span><span class="room-card-value">up to 2</span>');
    // The Loft has no photo: a card with no <img>, and its empty Details cell is left out.
    expect(html).not.toContain('alt="Loft"');
    expect(html).not.toContain('<table');
    expect(html).toContain('<span class="reply-text">Tell me a date.</span>');
  });

  it('in column view, a room table keeps its shape and gains a Photo column with a View button', () => {
    const cards = [
      { name: 'Garden Room', photos: ['https://x/g1.webp', 'https://x/g2.webp'] },
      { name: 'Loft', photos: [] },
    ];
    const text = '💰 Here are our rates:\n\n| Room | Slot | Weekday | Weekend | Holiday |\n|---|---|---|---|---|\n| Garden Room | Night | ₱3,500.00 | ₱4,500.00 | ₱4,500.00 |\n| Loft | Night | ₱4,800.00 | ₱5,800.00 | ₱5,800.00 |';
    const html = renderToStaticMarkup(createElement(ReplyText, { text, cards, view: 'column' }));
    expect(html).toContain('<table');
    expect(html).not.toContain('room-cards');
    expect(html).toContain('<th class="photo">Photo</th>');
    expect(html).toContain('<td data-label="Photo" class="photo"><button type="button" class="photo-link">View (2)</button></td>');
    // The Loft has no photo: an empty Photo cell.
    expect(html).toContain('<td data-label="Room">Loft</td>');
    expect(html).toContain('<td data-label="Photo" class="photo"></td>');
    // The amount columns are still found with the extra column in place.
    expect(html).toContain('<th class="amount">Weekday</th>');
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
