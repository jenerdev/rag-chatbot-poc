import { describe, expect, it } from 'vitest';
import { contrastProblems, contrastRatio, pinsLightScheme, themeVars } from './theme';

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

// The platform form's contrast advice (plan/ui-refresh.md Rule 5).
describe('contrastRatio', () => {
  it('is 21 for black on white and 1 for a colour on itself, either order', () => {
    expect(contrastRatio('#000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrastRatio('#ffffff', '#000000')).toBeCloseTo(21, 5);
    expect(contrastRatio('#2563eb', '#2563eb')).toBeCloseTo(1, 5);
  });
});

describe('contrastProblems', () => {
  it('passes the default look, and villa', () => {
    expect(contrastProblems({})).toEqual([]);
    expect(contrastProblems({ bg: '#faf7f2', accent: '#0f766e', accentSoft: '#e7f5f2' })).toEqual([]);
  });

  it('names a pale accent under white button text, with its ratio', () => {
    const problems = contrastProblems({ accent: '#ffd400' });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/^White button text on the accent is 1\.\d:1/);
  });

  it('names grey text on every surface it is drawn on', () => {
    expect(contrastProblems({ ink: '#aaaaaa' }).map((p) => p.split(' is ')[0])).toEqual(['Text on the background', 'Text on the panels', 'Text on the soft accent']);
  });

  it('judges an invalid value at its default, as the page draws it', () => {
    expect(contrastProblems({ ink: 'url(x)' })).toEqual([]);
  });
});
