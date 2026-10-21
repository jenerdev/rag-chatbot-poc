import { describe, expect, it } from 'vitest';
import { fullReference, referenceCode, referencePrefix } from './reference';

describe('referencePrefix', () => {
  it('is the first three letters of the slug, upper case, padded with X, as booking_reference() writes it', () => {
    expect(referencePrefix('alteza')).toBe('ALT');
    expect(referencePrefix('villa')).toBe('VIL');
    expect(referencePrefix('harbor-view-2')).toBe('HAR');
    expect(referencePrefix('a1')).toBe('AXX');
    expect(referencePrefix('42')).toBe('XXX');
  });
});

describe('referenceCode', () => {
  it('keeps six letters and digits, upper-cased', () => {
    expect(referenceCode('7kq4mx', 'ALT')).toBe('7KQ4MX');
    expect(referenceCode(' 7kq 4mx ', 'ALT')).toBe('7KQ4MX');
    expect(referenceCode('7KQ4MXZZ', 'ALT')).toBe('7KQ4MX');
  });

  it('drops the tenant prefix when a whole reference is pasted', () => {
    expect(referenceCode('ALT-7KQ4MX', 'ALT')).toBe('7KQ4MX');
    expect(referenceCode('alt-7kq4mx', 'ALT')).toBe('7KQ4MX');
    expect(referenceCode('ALT7KQ4MX', 'ALT')).toBe('7KQ4MX');
  });

  it('does not drop letters that merely look like the prefix', () => {
    expect(referenceCode('ALT', 'ALT')).toBe('ALT'); // three typed letters, not yet a pasted reference
    expect(referenceCode('VIL-7KQ4MX', 'ALT')).toBe('VIL7KQ'); // another tenant's: left as typed, the lookup will miss
  });

  it('is empty for nothing', () => {
    expect(referenceCode('', 'ALT')).toBe('');
    expect(referenceCode('-', 'ALT')).toBe('');
  });
});

describe('fullReference', () => {
  it('joins the halves, and is empty while the code is', () => {
    expect(fullReference('ALT', '7KQ4MX')).toBe('ALT-7KQ4MX');
    expect(fullReference('ALT', '')).toBe('');
  });
});
