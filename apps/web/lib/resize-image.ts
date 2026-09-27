// resize-image.ts — shrink and re-encode a photo in the browser, before upload
// (plan/booking-types.md § 2.8). Hand-written on <canvas>, no library (D-001).
//
// Why in the browser:
//   - Storage's image transformations are not on the Free plan, and a phone
//     photo is 3–8 MB; the bucket takes 2 MiB and the Free plan's egress is
//     5 GB a month (R-27);
//   - drawing a photo onto a canvas and encoding the canvas keeps ONLY the
//     pixels. EXIF, including the GPS position every phone writes, is not
//     carried over. The server does not rely on that (R-29): it checks size
//     and type again, and the route is staff-only.
//
// Browser only: it touches document, createImageBitmap and canvas.

export interface ResizedImage {
  blob: Blob;
  width: number;
  height: number;
  /** bytes before and after, which Phase 4 records to set the limits from measurement */
  before: number;
  after: number;
}

/**
 * Scale so the longer edge is at most `maxEdge` px (never up), and encode as
 * WebP at quality 0.82. A browser that cannot encode WebP returns PNG from
 * toBlob(); that is caught and JPEG is used instead, because a PNG of a photo
 * is several times larger.
 */
export async function resizeImage(file: File, maxEdge: number): Promise<ResizedImage> {
  // imageOrientation 'from-image' applies the EXIF rotation BEFORE the EXIF is
  // dropped, so a portrait phone photo stays upright.
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  try {
    const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('This browser cannot resize images');
    context.drawImage(bitmap, 0, 0, width, height);

    const encode = (type: string, quality: number) =>
      new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, quality));
    let blob = await encode('image/webp', 0.82);
    if (!blob || blob.type !== 'image/webp') blob = await encode('image/jpeg', 0.85);
    if (!blob) throw new Error('Could not encode the photo');

    return { blob, width, height, before: file.size, after: blob.size };
  } finally {
    bitmap.close();
  }
}
