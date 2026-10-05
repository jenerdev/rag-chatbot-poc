import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Icon, ICON_NAMES } from '../components/icons';

// Every icon is a stroked SVG in currentColor, hidden from a screen reader
// unless it is given a label (plan/ui-refresh.md Phase 0, Rule 5).
const render = (props: Parameters<typeof Icon>[0]) => renderToStaticMarkup(createElement(Icon, props));

describe('Icon', () => {
  it('draws every icon on the 20 x 20 grid in currentColor', () => {
    for (const name of ICON_NAMES) {
      const html = render({ name });
      expect(html, name).toMatch(/^<svg class="icon" width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor"/);
      expect(html, name).toMatch(/<(path|circle|rect) /);
    }
  });

  it('is decorative by default', () => {
    expect(render({ name: 'menu' })).toContain('aria-hidden="true"');
    expect(render({ name: 'menu' })).not.toContain('role=');
  });

  it('becomes an image with a name when labelled', () => {
    const html = render({ name: 'close', label: 'Close', size: 16 });
    expect(html).toContain('role="img"');
    expect(html).toContain('aria-label="Close"');
    expect(html).not.toContain('aria-hidden');
    expect(html).toContain('width="16"');
  });
});
