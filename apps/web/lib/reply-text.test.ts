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
    expect(html).toContain('<div class="reply-table"><table><thead><tr><th>Room</th><th>Guests</th><th>Price</th></tr></thead>');
    expect(html).toContain('<tr><td>Garden Room</td><td>up to 2</td><td class="amount">₱3,500.00 (weekend rate)</td></tr>');
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
});
