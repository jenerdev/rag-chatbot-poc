// speakable.ts — a reply as a person would SAY it (plan/voice.md Rule 3).
//
// The voice reads what the screen shows, never something a second model call
// wrote (Rule 1). But the screen shows things a voice must not read out: a
// pipe table (D-091), `**bold**` markers, emoji (D-092), web addresses. This
// turns the displayed reply into plain sentences.
//
// Shared on purpose: the speak route calls it before OpenAI's text-to-speech,
// and the browser calls it before its own voice when that route fails (Rule
// 6), so the two say the same words. Browser-safe and pure, like tables.ts,
// whose parser it reuses so a table is recognised exactly as it is drawn.
//
// It takes the reply as DISPLAYED. The stored refusal marker (D-047) is the
// route's to turn into the tenant's words first (`displayReply()`), so
// "NO_ANSWER" never reaches this file, let alone a speaker.

import { parseInline, parseSegments } from './tables';

/**
 * The most a reply speaks, in characters: about 40 seconds of `tts-1`
 * (Phase 0: 95 to 116 characters took 5.5 to 8.5 s). A longer answer is a
 * list or a table, which reads better on the screen.
 */
export const MAX_SPOKEN_CHARS = 600;

const SCREEN = 'The details are on your screen.';
const REST = 'The rest is on your screen.';

// Emoji, and the joiners and selectors that glue them together. \p{...}
// needs the `u` flag; every browser this app supports has it.
const EMOJI = /[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}\u{FE0F}\u{200D}\u{20E3}]/gu;
const URL = /\bhttps?:\/\/\S+/g;
// A list line's own marker: "- ", "* ", "• ", "1. ", "2) ".
const BULLET = /^\s*(?:[-*•]|\d+[.)])\s+/;

/** "A", "A and B", "A, B and C". */
function names(list: string[]): string {
  if (list.length <= 1) return list.join('');
  return `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
}

/** One line of prose: no bold markers, no emoji, no address, no bullet; a sentence's end added. */
function line(text: string): string {
  const plain = parseInline(text)
    .map((run) => run.text)
    .join('')
    .replace(URL, '')
    .replace(EMOJI, '')
    .replace(BULLET, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (plain === '') return '';
  // A list line has no full stop of its own; without one the voice runs the
  // items together.
  return /[.!?:;…]$/.test(plain) ? plain : `${plain}.`;
}

/** Cut at the last sentence that fits, and say where the rest is. */
function cap(text: string, max: number): string {
  if (text.length <= max) return text;
  const room = max - REST.length - 1;
  const cut = text.slice(0, room);
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('? '), cut.lastIndexOf('! '));
  const kept = end > 0 ? cut.slice(0, end + 1) : cut.slice(0, cut.lastIndexOf(' ')).concat('…');
  return `${kept} ${REST}`;
}

/**
 * The reply, spoken: text lines as sentences; a table as the names in its
 * first column and a pointer to the screen (§ 6 q3); at most `max`
 * characters, ending on a sentence.
 */
export function speakable(reply: string, max: number = MAX_SPOKEN_CHARS): string {
  const parts: string[] = [];
  for (const segment of parseSegments(reply)) {
    if (segment.kind === 'table') {
      const first = segment.rows.map((row) => line(row[0] ?? '').replace(/\.$/, '')).filter((cell) => cell !== '');
      parts.push(first.length > 0 ? `${names(first)}. ${SCREEN}` : SCREEN);
      continue;
    }
    for (const text of segment.text.split('\n')) {
      const spoken = line(text);
      if (spoken !== '') parts.push(spoken);
    }
  }
  return cap(parts.join(' '), max);
}
