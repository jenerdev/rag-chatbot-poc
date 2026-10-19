import { describe, expect, it } from 'vitest';
import { sniffAudio, transcriptionHint } from './voice';

const bytes = (...parts: (number[] | string)[]) =>
  new Uint8Array([...parts.flatMap((p) => (typeof p === 'string' ? [...p].map((c) => c.charCodeAt(0)) : p)), ...new Array(16).fill(0)]);

describe('sniffAudio', () => {
  it('knows each container a browser records, by its first bytes', () => {
    expect(sniffAudio(bytes([0x1a, 0x45, 0xdf, 0xa3]))).toBe('audio/webm');
    expect(sniffAudio(bytes([0, 0, 0, 0x20], 'ftypM4A '))).toBe('audio/mp4');
    expect(sniffAudio(bytes('OggS'))).toBe('audio/ogg');
    expect(sniffAudio(bytes('RIFF', [0, 0, 0, 0], 'WAVE'))).toBe('audio/wav');
    expect(sniffAudio(bytes('ID3'))).toBe('audio/mpeg');
    expect(sniffAudio(bytes([0xff, 0xfb]))).toBe('audio/mpeg');
  });

  it('refuses text renamed .webm, an image, and a file too short to tell', () => {
    expect(sniffAudio(bytes('hello, this is not audio'))).toBeNull();
    expect(sniffAudio(bytes([0x89], 'PNG'))).toBeNull();
    expect(sniffAudio(new Uint8Array([0x1a, 0x45]))).toBeNull();
  });
});

describe('transcriptionHint', () => {
  it('names the business and the three ways a guest speaks, and forces none', () => {
    const hint = transcriptionHint('Alteza Hillside Resort');
    expect(hint).toContain('Alteza Hillside Resort');
    expect(hint).toMatch(/Filipino \(Tagalog\), English, or a mix of both \(Taglish\)/);
  });

  it('spells the names of the rooms and slots when it has them, and says nothing of names when it has none', () => {
    expect(transcriptionHint('Alteza Hillside Resort', ['Casa Uno', 'Loft Suite', 'Overnight'])).toMatch(/Names they may say: Casa Uno, Loft Suite, Overnight\.$/);
    expect(transcriptionHint('Northwind')).not.toMatch(/Names/);
  });
});
