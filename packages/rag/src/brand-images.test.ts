import { describe, expect, it, vi } from 'vitest';

// platform.ts reaches @rag/db (server-only); the path rule needs none of it.
vi.mock('./platform.js', () => ({ getTenant: vi.fn(), updateTenant: vi.fn(), PlatformInputError: class extends Error {} }));
vi.mock('@rag/bookings', () => ({ sniffImageType: vi.fn() }));
const { brandObjectPath } = await import('./brand-images');

// D-123: only an object in OUR bucket, named as an upload names it, is ever
// removed. A pasted URL anywhere else, or a crafted one, is left alone.
const PREFIX = 'https://abc.supabase.co/storage/v1/object/public/brand-images/';
const uuid = '0f8b6c2e-4c1d-4e5a-9b7f-1a2b3c4d5e6f';

describe('brandObjectPath', () => {
  it('reads the path of an uploaded image', () => {
    expect(brandObjectPath(PREFIX, `${PREFIX}12/logo-${uuid}.webp`)).toBe(`12/logo-${uuid}.webp`);
    expect(brandObjectPath(PREFIX, `${PREFIX}3/banner-${uuid}.jpg`)).toBe(`3/banner-${uuid}.jpg`);
  });

  it('leaves alone a URL that is not ours, or nothing', () => {
    expect(brandObjectPath(PREFIX, 'https://cdn.example.com/logo.png')).toBeNull();
    expect(brandObjectPath(PREFIX, 'https://abc.supabase.co/storage/v1/object/public/unit-images/12/5/x.webp')).toBeNull();
    expect(brandObjectPath(PREFIX, null)).toBeNull();
    expect(brandObjectPath(PREFIX, '')).toBeNull();
  });

  it('refuses a crafted path in our bucket: another folder, a climb, a strange name', () => {
    expect(brandObjectPath(PREFIX, `${PREFIX}12/../13/logo-${uuid}.webp`)).toBeNull();
    expect(brandObjectPath(PREFIX, `${PREFIX}12%2F..%2F13%2Flogo-${uuid}.webp`)).toBeNull();
    expect(brandObjectPath(PREFIX, `${PREFIX}12/sub/logo-${uuid}.webp`)).toBeNull();
    expect(brandObjectPath(PREFIX, `${PREFIX}12/logo.webp`)).toBeNull();
    expect(brandObjectPath(PREFIX, `${PREFIX}12/logo-${uuid}.svg`)).toBeNull();
  });
});
