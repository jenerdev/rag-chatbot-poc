import { describe, expect, it } from 'vitest';
import { pinsLightScheme, themeVars } from './theme';

// A theme that sets a surface colour keeps its page light in dark mode
// (D-101); a theme of the accent alone, or none, follows the system.
describe('pinsLightScheme', () => {
  it('follows the system with no theme, an empty one, or an accent alone', () => {
    expect(pinsLightScheme(undefined)).toBe(false);
    expect(pinsLightScheme(themeVars({}))).toBe(false);
    expect(pinsLightScheme(themeVars({ accent: '#0f766e' }))).toBe(false);
  });

  it('pins light for any surface key: villa sets bg and accentSoft', () => {
    expect(pinsLightScheme(themeVars({ bg: '#faf7f2', accent: '#0f766e', accentSoft: '#e7f5f2' }))).toBe(true);
    expect(pinsLightScheme(themeVars({ panel: '#fff' }))).toBe(true);
    expect(pinsLightScheme(themeVars({ ink: '#111' }))).toBe(true);
    expect(pinsLightScheme(themeVars({ accentSoft: '#eef' }))).toBe(true);
  });

  it('ignores a surface value that is not a colour, as themeVars drops it', () => {
    expect(pinsLightScheme(themeVars({ bg: 'url(x)' }))).toBe(false);
  });
});
