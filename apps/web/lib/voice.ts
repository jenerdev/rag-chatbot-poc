// voice.ts — the voice feature's limits and its one byte check (plan/voice.md,
// D-134). Browser-safe and pure: the composer reads the recording cap from
// here, and the routes read every limit from here, so the two cannot differ.

/** The longest recording the composer makes (Rule 5); it stops itself at this. */
export const MAX_RECORDING_SECONDS = 30;
/** The largest upload the transcribe route takes. 30 s of Opus is well under; 1 MB stops a file that is not a question. */
export const MAX_AUDIO_BYTES = 1024 * 1024;
/** The voice every tenant's replies are read in (§ 6 q5: one voice, until a tenant asks). */
export const REPLY_VOICE = 'alloy';
/** The server gives up on OpenAI's speech after this (Phase 0: it stalled for minutes); the browser's own voice then reads the reply (Rule 6). */
export const SPEAK_TIMEOUT_MS = 15_000;
/** Each voice route, per IP per tenant per 10 minutes: one spoken turn is one of each, so this is 30 turns. Policy, not a measurement. */
export const VOICE_REQUESTS_PER_WINDOW = 30;

/**
 * The audio container, from the file's first bytes, never from the browser's
 * word or the file name (Rule 5; payments.ts does the same for proofs).
 * null: not a recording this feature takes.
 */
export function sniffAudio(bytes: Uint8Array): 'audio/webm' | 'audio/mp4' | 'audio/ogg' | 'audio/wav' | 'audio/mpeg' | null {
  const at = (offset: number, ...values: number[]) => values.every((v, i) => bytes[offset + i] === v);
  const ascii = (offset: number, text: string) => at(offset, ...[...text].map((c) => c.charCodeAt(0)));
  if (bytes.length < 12) return null;
  // Chrome, Edge and Firefox record WebM (an EBML header).
  if (at(0, 0x1a, 0x45, 0xdf, 0xa3)) return 'audio/webm';
  // Safari records MP4: a box whose type is `ftyp`, four bytes in.
  if (ascii(4, 'ftyp')) return 'audio/mp4';
  if (ascii(0, 'OggS')) return 'audio/ogg';
  if (ascii(0, 'RIFF') && ascii(8, 'WAVE')) return 'audio/wav';
  // MP3: an ID3 tag, or a frame sync.
  if (ascii(0, 'ID3') || (bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xe0) === 0xe0)) return 'audio/mpeg';
  return null;
}
