// Audit S-16 (D-171): an upload's size is judged from its declared length,
// BEFORE the body is read. Pure, so it is tested (upload-size.test.ts).
//
// The upload routes (voice, a payment proof, a room photo, a brand image)
// compared Content-Length with their limit, but read a MISSING header as 0
// and so let it through, and then buffered the whole body (formData())
// before the file's own size was known: a sender who leaves the header out
// (a chunked body) could make the server hold far more than the limit in
// memory. Voice did not look at the header at all. Now a missing or
// unreadable length is 411, and a declared length over the limit is refused
// in the route's own words, both before a byte of the body is read. A
// browser always sends the length of a FormData body, so no page of ours is
// refused. The file's real size is still checked after, as before.

/** The multipart envelope around the file: boundaries, headers, the other fields. */
export const ENVELOPE_BYTES = 64 * 1024;

export type SizeRefusal = { status: 400 | 411; error: string };

/**
 * Null when the declared length is present and within `maxFileBytes` plus
 * the envelope; otherwise the status and the sentence. `tooLarge` is the
 * route's own words for an oversized file (400, as the screens expect).
 */
export function declaredSizeRefusal(contentLength: string | null, maxFileBytes: number, tooLarge: string): SizeRefusal | null {
  const raw = contentLength?.trim() ?? '';
  if (!/^\d+$/.test(raw)) return { status: 411, error: 'Send the file with its size (a Content-Length header).' };
  if (Number(raw) > maxFileBytes + ENVELOPE_BYTES) return { status: 400, error: tooLarge };
  return null;
}
