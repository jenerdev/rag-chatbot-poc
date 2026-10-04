// dates.ts — relative dates ("tomorrow", "bukas", "next Friday") turned into
// calendar dates, in code, before the model sees the question (D-046).
//
// The model already had today's date (the tools block's last line). It still
// answered "Which date do you mean?" to "Is the resort available tomorrow?"
// and to "Available ba kayo bukas?", six questions out of six, with no tool
// call (measured 2026-09-27). Knowing today and doing the arithmetic are two
// different jobs, and gpt-4o-mini did only the first. The same lesson as
// D-043: code decides, and the prompt carries the answer, not a rule.
//
// Pure: no clock, no I/O. `today` comes in as YYYY-MM-DD, already the
// TENANT'S today (localDate(timezone) in @rag/bookings, trap 9), so every
// test can pin it. Arithmetic is on UTC midnights, so "tomorrow" is the next
// calendar day, never "now + 24 hours", and no DST edge can shift it.
//
// THE WEEKDAY RULES, which the tests pin:
//   - "Friday", "sa Friday", "this Friday", "ngayong Biyernes": the next
//     Friday from today, today included (said on a Friday, it is today).
//   - "next Friday", "sa susunod na Friday": weeks run Monday to Sunday.
//     When this week's Friday is still ahead, "next Friday" could mean it or
//     the one after, and people split on that, so BOTH are returned and the
//     model asks. When this week's Friday has passed, both readings agree on
//     the coming one, and it is resolved.
//   - "this weekend": Saturday to Sunday of this week (from today, if today
//     is already Saturday or Sunday). "next weekend": the same rule as "next
//     Friday", applied to Saturday.
//   - "this week": today to Sunday. "next week": next Monday to Sunday.
//
// TAGALOG TRAPS:
//   - "bukas" is "tomorrow" AND "open". "Bukas ba ang pool?" is not a date.
//     It is treated as a date unless a question particle or subject follows
//     it ("bukas ba", "bukas pa", "bukas ang", "bukas kayo"), or another date
//     is in the same message ("Bukas po ba kayo sa Linggo?").
//   - "linggo" is "Sunday" AND "week". The week phrases ("susunod na
//     linggo", "ngayong linggo", "linggong ito", "isang linggo") are matched
//     first; what is left is Sunday.
//   - "may" is the English month AND Tagalog "there is" ("May 2 rooms ba?").
//     "may" counts as the month only as "5 May" or "May 5, 2027".
//
// RANGES (R-15, fixed 2026-09-28): two single dates joined by "to", "until",
// "till", "through", "hanggang", a dash, or "between … and" become ONE
// range, so "from 10 to 12 October" is checked as date_from/date_to, not as
// two separate days with the days between unasked. And a night count next
// to a single date ("10 October for 2 nights", "dalawang gabi mula 10
// October") extends it to the nights of the stay: 2 nights from the 10th is
// the 10th and the 11th, checking out on the 12th. Both are decided here,
// so the tool is called once for the whole span (planDates).

import type { LanguagePreference } from './language.js';
import { pipeTable } from './tables.js';

/** One date expression found in a message, and what it resolves to. */
export interface DateMention {
  /** The words as the user wrote them, lower-cased: `"bukas"`, `"next friday"`. */
  phrase: string;
  /** YYYY-MM-DD. For an ambiguous phrase, the first reading. */
  from: string;
  /** YYYY-MM-DD, the last day of a range; equal to `from` for a single day. */
  to: string;
  /**
   * Set when the phrase has two reasonable readings (only "next <day>" and
   * "next weekend"). The model is told to ask which one, not to pick.
   */
  alternative?: { from: string; to: string };
}

// --- calendar arithmetic, on YYYY-MM-DD strings ---------------------------------

/** YYYY-MM-DD plus n days, on UTC midnights: month ends, year ends and 29 February roll over correctly. */
export function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** 0 = Monday … 6 = Sunday. Weeks run Monday to Sunday here. */
function dayIndex(date: string): number {
  return (new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7;
}

/** "Monday" for a YYYY-MM-DD. */
export function weekdayName(date: string): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString('en-GB', { weekday: 'long', timeZone: 'UTC' });
}

/** Is y-m-d a real date? 30 February and 31 April are not. */
function realDate(y: number, m: number, d: number): string | null {
  const iso = `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  const parsed = new Date(`${iso}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === iso ? iso : null;
}

// --- vocabulary -----------------------------------------------------------------

/** Weekday names → 0 (Monday) … 6 (Sunday), English and Tagalog. */
const WEEKDAYS: Record<string, number> = {
  monday: 0, lunes: 0,
  tuesday: 1, martes: 1,
  wednesday: 2, miyerkules: 2, miyerkoles: 2, myerkules: 2,
  thursday: 3, huwebes: 3,
  friday: 4, biyernes: 4, byernes: 4,
  saturday: 5, sabado: 5,
  sunday: 6, linggo: 6,
};
const WEEKDAY = Object.keys(WEEKDAYS).join('|');

/** Month names → 1 … 12. "may" is handled apart (see the header). */
const MONTHS: Record<string, number> = {
  january: 1, jan: 1, enero: 1,
  february: 2, feb: 2, pebrero: 2,
  march: 3, mar: 3, marso: 3,
  april: 4, apr: 4, abril: 4,
  mayo: 5,
  june: 6, jun: 6, hunyo: 6,
  july: 7, jul: 7, hulyo: 7,
  august: 8, aug: 8, agosto: 8,
  september: 9, sept: 9, sep: 9, setyembre: 9, septyembre: 9,
  october: 10, oct: 10, oktubre: 10,
  november: 11, nov: 11, nobyembre: 11,
  december: 12, dec: 12, disyembre: 12,
};
const MONTH = Object.keys(MONTHS).join('|');

/**
 * Small numbers, as digits or words. Tagalog numbers take a linker before a
 * noun ("dalawang araw", "apat na araw"), so both forms are listed.
 */
const NUMBERS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  isa: 1, isang: 1, dalawa: 2, dalawang: 2, tatlo: 3, tatlong: 3, apat: 4, lima: 5, limang: 5,
  anim: 6, pito: 7, pitong: 7, walo: 8, walong: 8, siyam: 9, sampu: 10, sampung: 10,
};
const NUMBER = `\\d{1,2}|${Object.keys(NUMBERS).join('|')}`;
const toNumber = (word: string): number => NUMBERS[word] ?? Number(word);

/** What may stand between two dates to make them one range (R-15). */
const CONNECTOR = /^\s*(?:to|until|till|through|thru|hanggang|-|–|—)\s*$/;
/** "between <date> and <date>": "and" joins only after "between". */
const BETWEEN_BEFORE = /\b(?:between|sa\s+pagitan\s+ng)\s*$/;
const AND_BETWEEN = /^\s*(?:and|at)\s*$/;
/**
 * "… for 2 nights", "…, dalawang gabi", within three words after a date
 * ("10 October free for 2 nights"). Group 1 is the words skipped, group 2
 * the night count text, group 3 the number.
 */
const NIGHTS_AFTER = new RegExp(
  `^(\\s*(?:[\\p{L}\\d-]+\\s+){0,3}?)(,?\\s*(?:for\\s+|ng\\s+|na\\s+|x\\s*)?(${NUMBER})(?:\\s+na)?\\s*(?:nights?|gabi)\\b)`,
  'u',
);
/**
 * "2 nights from …", "dalawang gabi mula …", within three words before a
 * date. Group 1 is the night count text, group 2 the number, group 3 the
 * words skipped.
 */
const NIGHTS_BEFORE = new RegExp(
  `((${NUMBER})(?:\\s+na)?\\s*(?:nights?|gabi),?\\s*(?:from|starting|start|mula|simula|sa|ng|on)?\\s*(?:sa\\s+)?)((?:[\\p{L}\\d-]+\\s+){0,3}?)$`,
  'u',
);

// --- the rules --------------------------------------------------------------------

type Range = { from: string; to: string; alternative?: { from: string; to: string } };
type Rule = {
  pattern: RegExp;
  resolve: (m: RegExpExecArray, today: string) => Range | null;
  /** A bare weekday name: as the second end of a range it rolls forward past the first (R-15). */
  weekday?: true;
};

const day = (date: string): Range => ({ from: date, to: date });

/** The next <weekday> from today, today included. */
function coming(today: string, weekday: number): string {
  return addDays(today, (weekday - dayIndex(today) + 7) % 7);
}

/**
 * "next <weekday>": resolved when both readings agree, two readings when they
 * do not (see the header). `span` makes it serve "next weekend" too.
 */
function next(today: string, weekday: number, span = 0): Range {
  const first = coming(today, weekday);
  const sundayThisWeek = addDays(today, 6 - dayIndex(today));
  if (first <= sundayThisWeek && first !== today) {
    return {
      from: first,
      to: addDays(first, span),
      alternative: { from: addDays(first, 7), to: addDays(first, 7 + span) },
    };
  }
  // This week's has passed (or is today): the coming one is next week's, and
  // "next" said on the day itself means a week from today.
  const target = first === today ? addDays(first, 7) : first;
  return { from: target, to: addDays(target, span) };
}

/** A month and day with no year: this year, or next year if it has passed. */
function monthDay(today: string, month: number, dayOfMonth: number, year?: number): Range | null {
  if (year !== undefined) {
    const iso = realDate(year, month, dayOfMonth);
    return iso ? day(iso) : null;
  }
  const thisYear = Number(today.slice(0, 4));
  const iso = realDate(thisYear, month, dayOfMonth);
  if (iso && iso >= today) return day(iso);
  const nextYear = realDate(thisYear + 1, month, dayOfMonth);
  return nextYear ? day(nextYear) : null;
}

/**
 * Ordered: longer phrases first, because a match is blanked out of the text
 * before the next rule runs. "day after tomorrow" must win over "tomorrow",
 * "next friday" over "friday", "susunod na linggo" (next week) over "linggo"
 * (Sunday).
 */
const RULES: Rule[] = [
  // Explicit dates. The model handles these already; resolving them in code
  // too means a "30 Sept" and a "bukas" in one question are treated alike.
  {
    pattern: /\b(\d{4})-(\d{2})-(\d{2})\b/g,
    resolve: (m) => {
      const iso = realDate(Number(m[1]), Number(m[2]), Number(m[3]));
      return iso ? day(iso) : null;
    },
  },
  {
    pattern: new RegExp(`\\b(${MONTH})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?:,?\\s*(\\d{4})\\b)?`, 'g'),
    resolve: (m, today) => monthDay(today, MONTHS[m[1]!]!, Number(m[2]), m[3] ? Number(m[3]) : undefined),
  },
  {
    // "May 5, 2027" only: without the year, "may 5" is Tagalog "there are 5".
    pattern: /\bmay\s+(\d{1,2})(?:st|nd|rd|th)?,?\s*(\d{4})\b/g,
    resolve: (m, today) => monthDay(today, 5, Number(m[1]), Number(m[2])),
  },
  {
    pattern: new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+|ng\\s+)?(${MONTH}|may)\\b(?:,?\\s*(\\d{4})\\b)?`, 'g'),
    resolve: (m, today) =>
      monthDay(today, m[2] === 'may' ? 5 : MONTHS[m[2]!]!, Number(m[1]), m[3] ? Number(m[3]) : undefined),
  },

  // Counted days: "in 2 days", "after three days", "3 days from now",
  // "sa loob ng dalawang araw", "pagkalipas ng tatlong araw".
  {
    pattern: new RegExp(`\\b(?:in|after)\\s+(${NUMBER})\\s+days?\\b`, 'g'),
    resolve: (m, today) => day(addDays(today, toNumber(m[1]!))),
  },
  {
    pattern: new RegExp(`\\b(${NUMBER})\\s+days?\\s+(?:from\\s+(?:now|today)|later)\\b`, 'g'),
    resolve: (m, today) => day(addDays(today, toNumber(m[1]!))),
  },
  {
    pattern: new RegExp(`\\b(?:sa\\s+loob\\s+ng|pagkalipas\\s+ng|makalipas\\s+ang|after)\\s+(${NUMBER})(?:\\s+na)?\\s+araw\\b`, 'g'),
    resolve: (m, today) => day(addDays(today, toNumber(m[1]!))),
  },
  {
    // A week from today. Before the "linggo" rules, which would read Sunday.
    pattern: /\b(?:in|after)\s+(?:a|one)\s+week\b|\b(?:pagkalipas|makalipas)\s+(?:ng|ang)\s+isang\s+linggo\b/g,
    resolve: (_m, today) => day(addDays(today, 7)),
  },

  // Named days.
  { pattern: /\b(?:the\s+)?day\s+after\s+tomorrow\b|\b(?:sa\s+)?makalawa\b/g, resolve: (_m, today) => day(addDays(today, 2)) },
  { pattern: /\b(?:tomorrow|tomorow|tmrw|tmr)\b/g, resolve: (_m, today) => day(addDays(today, 1)) },
  { pattern: /\byesterday\b|\bkahapon\b/g, resolve: (_m, today) => day(addDays(today, -1)) },

  // Weeks and weekends, before the weekday names ("linggo").
  {
    pattern: /\bnext\s+week(?:end)?\b|\b(?:sa\s+)?susunod\s+na\s+(?:linggo|week(?:end)?)\b/g,
    resolve: (m, today) => {
      if (/weekend/.test(m[0])) return next(today, 5, 1);
      const monday = addDays(today, 7 - dayIndex(today));
      return { from: monday, to: addDays(monday, 6) };
    },
  },
  {
    pattern: /\b(?:this|this\s+coming|ngayong)\s+(?:week(?:end)?|linggo)\b|\b(?:sa\s+)?(?:week(?:end)?|linggong)\s+(?:na\s+)?ito\b|\bsa\s+weekend\b/g,
    resolve: (m, today) => {
      const sunday = addDays(today, 6 - dayIndex(today));
      if (/weekend/.test(m[0])) {
        const saturday = addDays(sunday, -1);
        return { from: saturday > today ? saturday : today, to: sunday };
      }
      return { from: today, to: sunday };
    },
  },

  // Weekdays, "next" first.
  {
    pattern: new RegExp(`\\bnext\\s+(${WEEKDAY})\\b|\\b(?:sa\\s+)?susunod\\s+na\\s+(${WEEKDAY})\\b|\\b(${WEEKDAY})\\s+next\\s+week\\b`, 'g'),
    resolve: (m, today) => next(today, WEEKDAYS[(m[1] ?? m[2] ?? m[3])!]!),
  },
  {
    pattern: new RegExp(`\\b(?:this(?:\\s+coming)?|ngayong|on|sa)\\s+(${WEEKDAY})\\b(?:\\s+na\\s+ito)?|\\b(${WEEKDAY})\\b(?:\\s+na\\s+ito)?`, 'g'),
    resolve: (m, today) => day(coming(today, WEEKDAYS[(m[1] ?? m[2])!]!)),
    weekday: true,
  },

  // Today, after "ngayong <day|week|weekend>" had its turn.
  {
    pattern: /\b(?:today|tonight|this\s+(?:evening|afternoon|morning)|ngayong\s+(?:araw|gabi|hapon|umaga)|ngayon|mamaya)\b/g,
    resolve: (_m, today) => day(today),
  },
];

/**
 * "bukas" as tomorrow, unless it is "bukas" as open (see the header). Run
 * last, so it can see whether another date was already found.
 */
const BUKAS = /\bbukas\b(?!\s+(?:po\s+)?(?:ba|pa|na|ang|kayo|ka|sila|ninyo|nyo|niyo|lang|din|rin)\b)/g;
const OPEN_BEFORE = /\b(?:hindi|di|ay)\s+$/;

/**
 * Every date expression in a message, resolved against `today`, in the order
 * the rules found them. `[]` when there is none, which is most questions.
 */
export function resolveDates(message: string, today: string): DateMention[] {
  return scan(message, today).mentions;
}

/** The mentions, and the message with every one of them blanked out. */
function scan(message: string, today: string): { mentions: DateMention[]; rest: string } {
  // Lower-cased, and apostrophes and punctuation turned to spaces, but digits,
  // hyphens, dashes and commas kept for "2026-09-30", "10 – 12 Oct" and
  // "September 30, 2026".
  let text = message.toLowerCase().replace(/[^\p{L}\d,\-–—\s]/gu, ' ');
  const original = text;
  const found: { index: number; end: number; weekday?: true; mention: DateMention }[] = [];

  for (const rule of RULES) {
    rule.pattern.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = rule.pattern.exec(text)) !== null) {
      const range = rule.resolve(m, today);
      if (range) {
        found.push({ index: m.index, end: m.index + m[0].length, weekday: rule.weekday, mention: { phrase: m[0].trim(), ...range } });
      }
    }
    // Blank out what this rule matched, so a shorter rule cannot match inside
    // it ("tomorrow" inside "day after tomorrow").
    text = text.replace(rule.pattern, (s) => ' '.repeat(s.length));
  }

  if (found.length === 0) {
    BUKAS.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = BUKAS.exec(text)) !== null) {
      if (OPEN_BEFORE.test(text.slice(0, m.index))) continue;
      found.push({ index: m.index, end: m.index + 5, mention: { phrase: 'bukas', ...day(addDays(today, 1)) } });
      text = text.slice(0, m.index) + ' '.repeat(5) + text.slice(m.index + 5);
    }
  }
  found.sort((a, b) => a.index - b.index);
  const blank = (from: number, to: number) => {
    text = text.slice(0, from) + ' '.repeat(to - from) + text.slice(to);
  };

  // RANGES (R-15). Two unambiguous single days in order, with only a
  // connector between them, are one span from the first to the second. The
  // connector is blanked too, so a bare "from the 10th to the 12th?" reads
  // as date-only (isDateOnly).
  const joined: typeof found = [];
  for (let i = 0; i < found.length; i++) {
    const cur = found[i]!;
    const nxt = found[i + 1];
    if (nxt && !cur.mention.alternative && !nxt.mention.alternative && cur.mention.from === cur.mention.to && nxt.mention.from === nxt.mention.to) {
      const between = text.slice(cur.end, nxt.index);
      if (CONNECTOR.test(between) || (BETWEEN_BEFORE.test(text.slice(0, cur.index)) && AND_BETWEEN.test(between))) {
        // "Friday to Sunday" said on a Sunday: the coming Sunday is today,
        // before that Friday. The Sunday meant is the one after the Friday.
        let end = nxt.mention.from;
        if (nxt.weekday) while (end <= cur.mention.from) end = addDays(end, 7);
        if (cur.mention.from < end) {
          blank(cur.end, nxt.index);
          joined.push({
            index: cur.index,
            end: nxt.end,
            mention: { phrase: original.slice(cur.index, nxt.end).trim(), from: cur.mention.from, to: end },
          });
          i++;
          continue;
        }
      }
    }
    joined.push(cur);
  }

  // NIGHTS. "10 October for 2 nights" is the 10th and the 11th: the nights
  // slept, which are the rows a stay is made of (customer-booking D-073).
  for (let i = 0; i < joined.length; i++) {
    const cur = joined[i]!;
    if (cur.mention.alternative || cur.mention.from !== cur.mention.to) continue;
    const after = text.slice(cur.end, joined[i + 1]?.index ?? text.length);
    const before = text.slice(joined[i - 1]?.end ?? 0, cur.index);
    const a = NIGHTS_AFTER.exec(after);
    const b = a ? null : NIGHTS_BEFORE.exec(before);
    const m = a ?? b;
    if (!m) continue;
    const nights = toNumber(a ? a[3]! : b![2]!);
    if (nights < 1) continue;
    cur.mention.to = addDays(cur.mention.from, nights - 1);
    if (a) {
      cur.mention.phrase = `${cur.mention.phrase} ${a[2]!.trim()}`;
      blank(cur.end + a[1]!.length, cur.end + a[0].length);
    } else {
      const start = cur.index - b![0].length;
      cur.mention.phrase = `${b![1]!.trim()} ${cur.mention.phrase}`;
      blank(start, start + b![1]!.length);
    }
  }

  return { mentions: joined.map((f) => f.mention), rest: text };
}

// --- is this an availability question? ------------------------------------------

/**
 * Words that make a message about availability or booking. Checked only on a
 * message that ALSO has a date in it, so "free" and "slot" cannot fire on
 * their own. "check" and "open" are left out on purpose: "What time is
 * check-in bukas?" and "Is the pool open tomorrow?" are documents questions.
 *
 * "bakante(?:ng)?": Tagalog joins an adjective to its noun with the linker
 * "-ng", so "a vacant room" is "bakanteng kwarto". `\bbakante\b` missed that,
 * and the check never ran (found by rt-tagalog, plan/extra-guests.md Phase 4).
 *
 * PRICE words too (D-074): since villa's prices come from the tool, "How
 * much is the Overnight on Saturday?" needs the same up-front check as "Is
 * Saturday free?"; without a date the model asks for one, as before.
 */
const AVAILABILITY =
  /\b(?:available|availability|avail|vacant|vacancy|bakante(?:ng)?|free|fully\s+booked|booked|book|booking|mag-?book|magpa-?book|pa-?book|i-?book|reserve|reservation|reserba|slots?|taken|may\s+(?:room|kwarto|cottage)|how\s+much|magkano|price|rate|rates|cost|costs|presyo)\b/;

export function asksAvailability(message: string): boolean {
  return AVAILABILITY.test(message.toLowerCase());
}

// --- a price asked with no date (D-081) -----------------------------------------

/** The price words of AVAILABILITY, alone: "rates", "how much", "magkano". */
const PRICE = /\b(?:how\s+much|magkano|price|prices|pricing|rate|rates|cost|costs|presyo)\b/;

/**
 * "room rates please": a price, and no date to price. The rates are not in
 * the documents (D-074), so retrieval found nothing, the tool was never
 * called, and D-035 swapped the model's "which date?" for the refusal. The
 * visitor was told we have no information about our own prices.
 *
 * answer.ts uses this only on a reply that is ALREADY the refusal, so a price
 * the documents do answer ("Magkano po ang security deposit?") is untouched.
 */
export function asksUndatedPrice(message: string, today: string): boolean {
  const text = message.toLowerCase();
  return PRICE.test(text) && !NAMED_FEE.test(text) && !asksExtraGuest(message, today) && resolveDates(message, today).length === 0;
}

/**
 * A fee or payment by name is not the nightly rate (D-088). "How much is the
 * reservation fee?" at alteza is answered by its documents as "half of the
 * total", which holds no figure, so D-081 replaced it with "rates vary by
 * date"; at harbor, whose documents do not say, it turned an honest "I don't
 * know" into the same wrong answer. The reply to these is left alone.
 */
const NAMED_FEE =
  /\b(?:fees?|deposits?|down\s*payment|dp|charges?|surcharges?|corkage|bayad|reservation|cancell?ation|penalty|penalties)\b/;

// --- how far ahead can I book? (D-086) ------------------------------------------

/**
 * "How far in advance can I book?", "What is the latest date I can book?",
 * "Hanggang kailan pwede mag-book?". Bare "in advance" is left out: "Do I pay
 * in advance?" is a documents question about the deposit.
 */
const HORIZON =
  /\b(?:how\s+far\s+(?:in\s+advance|ahead)|book(?:ing)?\s+(?:\w+\s+){0,3}?(?:in\s+advance|ahead)|advance\s+booking|how\s+early\s+can|(?:latest|furthest|last)\s+(?:date|day)|how\s+many\s+(?:days|months)\s+(?:ahead|in\s+advance)|hanggang\s+kailan|gaano\s+kaaga)\b/;

/** A question about the booking horizon, with no date in it. */
export function asksHorizon(message: string, today: string): boolean {
  return HORIZON.test(message.toLowerCase()) && resolveDates(message, today).length === 0;
}

// --- the extra-guest fee (D-085) ------------------------------------------------

/** "extra guest", "additional person", "per head", "dagdag na tao". */
const EXTRA_GUEST =
  /\b(?:(?:extra|additional|excess|dagdag(?:\s+na)?)\s+(?:guests?|persons?|people|pax|heads?|tao)|per\s+(?:extra\s+)?(?:head|person|pax))\b/;

/**
 * "How much is per extra guest?" with no date. The fee is set per room
 * (units.extra_person_rate) and does not change with the date, so it needs
 * no date; D-081 had answered it "rates vary by date", 4 of 4. With a date
 * it is an availability turn: every row carries the fee already.
 */
export function asksExtraGuest(message: string, today: string): boolean {
  return EXTRA_GUEST.test(message.toLowerCase()) && resolveDates(message, today).length === 0;
}

/**
 * What an undated price question gets instead of the refusal. Fixed text, in
 * code, like the greetings (D-049): nothing is retrieved, so nothing could be
 * grounded, and every figure it could name would be one the tool owns.
 */
// --- which rooms are there? (D-084) ---------------------------------------------

/**
 * Rooms in the PLURAL, or "which/what room": a question about the rooms
 * there are. "Does the Garden Room have a balcony?" names one room and is a
 * documents question, so a bare singular "room" is left out. So is "May
 * kwarto ba kayo?": a yes/no availability question, which refused 3 of 3
 * with these lines and asks for a date without them.
 */
const ROOM_LIST =
  /\b(?:rooms|accommodations|mga\s+ku?warto|(?:anong|ano\s+ang|what|which)\s+(?:mga\s+)?(?:room|ku?warto))\b/;

/**
 * "What rooms do you have?", "What are the available rooms?": the rooms
 * there are, with no date and no price asked. Harbor's tools block tells the
 * model to ask for a date whenever availability is asked without one, and it
 * did, 5 questions in 5 (2026-09-30). A price word leaves it to D-081; a
 * date makes it an availability turn (planDates).
 *
 * A YES/NO availability question is not one: "Do you have any rooms
 * available?" asks whether something is free, and that needs a date. The
 * user decided so (2026-09-30), and rt-ask pins it: the reply asks for one.
 */
const YES_NO = /^\s*(?:do|does|are|is|any|got|may|meron|mayroon)\b/;

export function asksRoomList(message: string, today: string): boolean {
  const text = message.toLowerCase();
  if (YES_NO.test(text) && asksAvailability(text)) return false;
  return ROOM_LIST.test(text) && !PRICE.test(text) && resolveDates(message, today).length === 0;
}

/**
 * The lines for that turn, placed after the tools block like a date's
 * (buildPrompt's per-turn slot), so every other prompt is unchanged. The
 * rooms come from the tool description (the database's active rooms), the
 * details from the documents, and no price from either: the documents hold
 * an out-of-date brochure rate, and a price depends on a date the user has
 * not given.
 */
export const ROOM_LIST_LINES = [
  'The user is asking which rooms there are, and gives no date. Do not ask',
  'for a date and do not call check_availability. List every room named in',
  "check_availability's description as a table with the columns Room,",
  'Guests and Details, one row per room: how many guests it holds and what',
  'the documents say about it. Write no price and no rate.',
  "The rooms in the description are enough to answer, so never reply that",
  "you don't know.",
  'If they ask something else about the rooms too, answer it as well. End',
  'with one sentence saying that for which rooms are free and their rates,',
  'they can tell you a date.',
];

/**
 * The same question at a tenant booked as a WHOLE (villa, D-087): it has no
 * rooms in the database, only bedrooms in its documents, and with no line it
 * refused "What rooms are available?" 2 of 2.
 */
export const WHOLE_PROPERTY_ROOM_LINES = [
  'The user is asking which rooms there are, and gives no date. The property',
  'is booked as a whole, not room by room. Do not ask for a date and do not',
  'call check_availability. List the rooms and bedrooms the documents',
  'describe as a table with the columns Room and Details, one row per room,',
  'with what the documents say about each. Write no',
  'price and no rate. End with one sentence saying the whole property is',
  'booked together, and that for availability and rates they can tell you a',
  'date.',
];

/**
 * The room list written in code, for a per_room tenant (D-087): used when
 * the model, given ROOM_LIST_LINES, still answered "Which date do you mean?"
 * (harbor and alteza, "What rooms are available?", 4 of 4) instead of naming
 * the rooms. Names and maximum guests from the database; no price.
 *
 * A TABLE since plan/tables.md Phase 2 (D-091): the same two facts per
 * room, in the one block shape the chat draws (tables.ts). The sentence
 * before and after is unchanged.
 */
export function roomListReply(rooms: { name: string; capacity: number | null }[], language: LanguagePreference): string {
  const holds = (c: number | null) => {
    if (c === null) return '';
    if (language === 'tagalog') return `hanggang ${c} bisita`;
    return `up to ${c} guest${c === 1 ? '' : 's'}`;
  };
  const header = language === 'tagalog' ? ['Kwarto', 'Bisita'] : ['Room', 'Guests'];
  const table = pipeTable(header, rooms.map((r) => [r.name, holds(r.capacity)]));
  if (language === 'taglish') {
    return `Ito po ang mga kwarto namin:\n\n${table}\n\nPakisabi po ang date niyo para ma-check ko kung alin ang bakante at ang rates.`;
  }
  if (language === 'tagalog') {
    return `Narito po ang aming mga kuwarto:\n\n${table}\n\nPakisabi po ang petsa upang masuri ko kung alin ang bakante at ang presyo.`;
  }
  return `Here are our rooms:\n\n${table}\n\nTell me your dates and I can check which rooms are free and their rates.`;
}

export const PRICE_NEEDS_DATE: Record<LanguagePreference, string> = {
  english:
    'Our rates vary depending on whether your visit falls on a weekday, weekend, or holiday. ' +
    'Please provide your preferred date so I can check and share the correct rate with you.',
  taglish:
    'Nag-iiba po ang rates namin depende kung weekday, weekend, o holiday ang visit niyo. ' +
    'Pakisabi po ang preferred date niyo para ma-check ko at maibigay ang tamang rate.',
  tagalog:
    'Nag-iiba po ang aming presyo depende kung karaniwang araw, Sabado at Linggo, o pista opisyal ang inyong pagbisita. ' +
    'Pakisabi po ang nais ninyong petsa upang masuri ko at maibigay ang tamang presyo.',
};

/** Words a follow-up wraps around a date: "How about bukas?", "Paano kung sa Friday naman po?" */
const FILLER = new Set(
  (
    'how about what and or the on for then ok okay so paano kung naman po ba sa eh e yung ung ang sige pala na lang ' +
    'din rin pwede puwede ano if from mula simula between'
  ).split(' '),
);

/**
 * Is the message a date and nothing else, once the filler is gone? That is a
 * follow-up that leans on the previous turn: after an availability question,
 * "What about the day after tomorrow?" is another availability question.
 */
export function isDateOnly(message: string, today: string): boolean {
  const { mentions, rest } = scan(message, today);
  if (mentions.length === 0) return false;
  return rest
    .split(/[\s,]+/)
    .filter(Boolean)
    .every((word) => FILLER.has(word));
}

/** "2026-09-28 (Monday)", or "2026-10-05 (Monday) to 2026-10-11 (Sunday)". */
function describe(r: { from: string; to: string }): string {
  const one = (d: string) => `${d} (${weekdayName(d)})`;
  return r.from === r.to ? one(r.from) : `${one(r.from)} to ${one(r.to)}`;
}

/** "28 September 2026", as a person would read it back. */
function spoken(date: string): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/** At most this many dates are checked up front for one message. */
export const MAX_DATE_CHECKS = 3;

/** What answer.ts does about this turn's dates: the prompt lines, and the calls to run first. */
export interface DatePlan {
  /** Placed right after the tools block's "Today is …" line. */
  lines: string[];
  /** check_availability arguments, run before the model's first turn. */
  calls: { date_from: string; date_to?: string; guests?: number }[];
}

/**
 * A party size stated in the message: "for 3 guests", "32 pax", "kaming
 * lima", "30 kami". Since D-074 a price question with a date is checked up
 * front, and a check run WITHOUT the guests hands the model rows with no
 * total, which it then adds up itself (R-37: rt-extra and price-villa-guests
 * both failed that way on the first run). So the count rides on the call.
 * "2 nights" is not a party: nights are not in the list.
 */
const GUESTS = new RegExp(
  `\\b(${NUMBER})(?:\\s+na)?\\s*(?:guests?|people|persons?|pax|adults?|heads?|tao|katao)\\b|\\b(${NUMBER})\\s+kami\\b|\\bkami(?:ng)?\\s+(${NUMBER})\\b`,
);

export function guestCount(message: string): number | null {
  const m = GUESTS.exec(message.toLowerCase());
  if (!m) return null;
  const n = toNumber((m[1] ?? m[2] ?? m[3])!);
  return Number.isInteger(n) && n >= 1 ? n : null;
}

const NOTHING: DatePlan = { lines: [], calls: [] };

/**
 * The plan for one message (D-046). NOTHING unless it is an availability
 * turn with a date in it, so every other prompt is the string it was before.
 *
 * AN AVAILABILITY TURN: the message asks about availability or booking, or it
 * is a bare date ("What about the day after tomorrow?") after an earlier
 * availability question. Anything else, even with a date in it, gets nothing:
 * with only "bukas means 2026-09-28" added, "What time is check-in bukas?"
 * made the model check availability and open with "Yes po", where the
 * unchanged prompt answered from the documents (trap 10).
 *
 * THE CALLS, run in code: with the resolved date stated in the prompt,
 * gpt-4o-mini still answered "Anong date po?" to "Available ba kayo next
 * week?" 3 runs of 3, and to "Available ba kayo sa Friday?" once, while
 * calling the tool for the same dates asked in other words. A prompt line is
 * followed most of the time, and this has to happen every time. So every
 * unambiguous date is checked up front, a past one too, so the tool can say
 * it is past. An ambiguous one is not: the model asks which.
 */
export function planDates(message: string, today: string, earlierQuestions: string[]): DatePlan {
  const mentions = resolveDates(message, today).slice(0, MAX_DATE_CHECKS);
  if (mentions.length === 0) return NOTHING;
  const about =
    asksAvailability(message) || (isDateOnly(message, today) && earlierQuestions.some((q) => asksAvailability(q)));
  if (!about) return NOTHING;
  const guests = guestCount(message);
  return {
    lines: dateInstructions(mentions, today, guests),
    calls: mentions
      .filter((m) => !m.alternative)
      .map((m) => ({
        date_from: m.from,
        ...(m.from === m.to ? {} : { date_to: m.to }),
        ...(guests === null ? {} : { guests }),
      })),
  };
}

/**
 * The prompt lines for an availability turn's dates, one per mention.
 *
 * Worded as what to DO, the shape gpt-4o-mini follows (D-017). The first
 * wording ("That is the date they mean: use it") fixed five questions of
 * six. Replies also said "bukas" without the date, so the reader could not
 * check what was resolved; hence the spoken date to name.
 *
 * Three shapes, decided in code:
 *   - ambiguous ("next Friday" midweek): ask which of the two;
 *   - past ("kahapon"): say it has passed. The tool says so too, but in a
 *     Taglish conversation the model answered the refusal instead of passing
 *     the tool's error on;
 *   - otherwise: check_availability was already run for it (planDates), so
 *     answer from that result and name the date.
 */
export function dateInstructions(mentions: DateMention[], today: string, guests: number | null = null): string[] {
  return mentions.map((m) => {
    const lead = `In the user's latest message, "${m.phrase}"`;
    if (m.alternative) {
      return `${lead} could mean ${describe(m)} or ${describe(m.alternative)}. Ask which of the two they mean.`;
    }
    const named = m.from === m.to ? spoken(m.from) : `${spoken(m.from)} to ${spoken(m.to)}`;
    if (m.to < today) {
      return `${lead} means ${describe(m)}, which has already passed. Tell the user that ${named} is in the past, so it cannot be checked or booked.`;
    }
    const args =
      (m.from === m.to ? `date_from ${m.from}` : `date_from ${m.from} and date_to ${m.to}`) +
      (guests === null ? '' : ` and guests ${guests}`);
    return (
      `${lead} means ${describe(m)}. check_availability was already called with ${args}; ` +
      `answer from its result, and name ${named} in your answer. Do not ask which date they mean.`
    );
  });
}
