// dates.ts's tests (D-046). No model, no database, no clock: `today` is
// pinned in every call, so these give the same answer on any day they run.
//
// 2026-09-27 is a Sunday and 2026-09-30 a Wednesday. The weekday rules are
// tested from both, because "next Friday" means something different on each.

import { describe, expect, it } from 'vitest';
import { addDays, asksAvailability, asksUndatedPrice, dateInstructions, guestCount, isDateOnly, MAX_DATE_CHECKS, planDates, resolveDates } from './dates.js';

const SUNDAY = '2026-09-27';
const WEDNESDAY = '2026-09-30';

/** The single date a message resolves to, or what it found instead. */
const one = (message: string, today = SUNDAY) => {
  const found = resolveDates(message, today);
  return found.length === 1 && found[0]!.from === found[0]!.to && !found[0]!.alternative ? found[0]!.from : found;
};

describe('tomorrow and bukas, today and ngayon', () => {
  it.each([
    ['Is the resort available tomorrow?', '2026-09-28'],
    ['Available ba kayo bukas?', '2026-09-28'],
    ['Available ba kayo tomorrow?', '2026-09-28'],
    ['May available room ba bukas?', '2026-09-28'],
    ['May available room ba tomorrow?', '2026-09-28'],
    ['Mag-book kami bukas.', '2026-09-28'],
    ['Bukas, may bakante pa ba?', '2026-09-28'],
    ['Is it free today?', SUNDAY],
    ['Available ba ngayon?', SUNDAY],
    ['May slot pa ba ngayong gabi?', SUNDAY],
    ['What about yesterday?', '2026-09-26'],
    ['Available ba kahapon?', '2026-09-26'],
  ])('%s → %s', (message, date) => {
    expect(one(message)).toBe(date);
  });

  it('"tomorrow" and "bukas" are the same date', () => {
    expect(one('available tomorrow?')).toBe(one('available bukas?'));
  });
});

describe('the day after tomorrow and sa makalawa', () => {
  it.each([
    ['Available ba kayo sa makalawa?', '2026-09-29'],
    ['May vacant rooms ba kayo sa makalawa?', '2026-09-29'],
    ['How about the day after tomorrow?', '2026-09-29'],
    ['What about the day after tomorrow?', '2026-09-29'],
  ])('%s → %s', (message, date) => {
    expect(one(message)).toBe(date);
  });

  it('"day after tomorrow" is not also read as "tomorrow"', () => {
    expect(resolveDates('the day after tomorrow', SUNDAY)).toHaveLength(1);
  });

  it('"day after tomorrow" and "sa makalawa" are the same date', () => {
    expect(one('day after tomorrow')).toBe(one('sa makalawa'));
  });
});

describe('counted days', () => {
  it.each([
    ['Available in 2 days?', '2026-09-29'],
    ['after 2 days', '2026-09-29'],
    ['sa loob ng dalawang araw', '2026-09-29'],
    ['in three days', '2026-09-30'],
    ['sa loob ng tatlong araw', '2026-09-30'],
    ['pagkalipas ng apat na araw', '2026-10-01'],
    ['3 days from now', '2026-09-30'],
    ['in a week', '2026-10-04'],
  ])('%s → %s', (message, date) => {
    expect(one(message)).toBe(date);
  });
});

describe('weekdays, from a Sunday (2026-09-27)', () => {
  it.each([
    ['May available ba kayo sa Friday?', '2026-10-02'],
    ['Paano kung sa Friday?', '2026-10-02'],
    ['this Friday', '2026-10-02'],
    ['sa Friday na ito', '2026-10-02'],
    ['ngayong Biyernes', '2026-10-02'],
    ['Check availability for this Saturday.', '2026-10-03'],
    ['sa Lunes', '2026-09-28'],
    ['this Monday', '2026-09-28'],
    ['Huwebes po', '2026-10-01'],
    // Said on a Sunday, "Sunday" is today and "sa Linggo" is Sunday, not a week.
    ['sa Linggo', SUNDAY],
    // This week's Friday has passed (weeks run Monday to Sunday), so both
    // readings of "next Friday" agree on the coming one.
    ['next Friday', '2026-10-02'],
    ['sa susunod na Friday', '2026-10-02'],
    // "next Sunday" said on a Sunday is a week from today.
    ['May available cottage ba next Sunday?', '2026-10-04'],
  ])('%s → %s', (message, date) => {
    expect(one(message)).toBe(date);
  });
});

describe('weekdays, from a Wednesday (2026-09-30)', () => {
  it('"Friday" is this week\'s', () => {
    expect(one('sa Friday', WEDNESDAY)).toBe('2026-10-02');
  });

  it('"Wednesday" said on a Wednesday is today', () => {
    expect(one('this Wednesday', WEDNESDAY)).toBe(WEDNESDAY);
  });

  it('"next Friday" is ambiguous while this week\'s Friday is ahead: both readings, and the model asks', () => {
    const [m] = resolveDates('Available ba next Friday?', WEDNESDAY);
    expect(m).toMatchObject({ from: '2026-10-02', to: '2026-10-02', alternative: { from: '2026-10-09', to: '2026-10-09' } });
    expect(dateInstructions([m!], WEDNESDAY)[0]).toMatch(/could mean 2026-10-02 \(Friday\) or 2026-10-09 \(Friday\)\. Ask which/);
  });

  it('"next Wednesday" said on a Wednesday is a week from today, not ambiguous', () => {
    expect(one('next Wednesday', WEDNESDAY)).toBe('2026-10-07');
  });
});

describe('weeks and weekends', () => {
  it('"next week" and "sa susunod na linggo" are next Monday to Sunday', () => {
    for (const message of ['Available ba kayo next week?', 'Available ba kayo sa susunod na linggo?']) {
      expect(resolveDates(message, SUNDAY)).toMatchObject([{ from: '2026-09-28', to: '2026-10-04' }]);
      expect(resolveDates(message, WEDNESDAY)).toMatchObject([{ from: '2026-10-05', to: '2026-10-11' }]);
    }
  });

  it('"this weekend" is Saturday to Sunday, from today once it has started', () => {
    expect(resolveDates('this weekend', WEDNESDAY)).toMatchObject([{ from: '2026-10-03', to: '2026-10-04' }]);
    expect(resolveDates('sa weekend na ito', WEDNESDAY)).toMatchObject([{ from: '2026-10-03', to: '2026-10-04' }]);
    expect(resolveDates('this weekend', SUNDAY)).toMatchObject([{ from: SUNDAY, to: SUNDAY }]);
  });

  it('"next weekend" follows the "next <day>" rule', () => {
    expect(resolveDates('next weekend', SUNDAY)).toMatchObject([{ from: '2026-10-03', to: '2026-10-04' }]);
    expect(resolveDates('next weekend', WEDNESDAY)[0]!.alternative).toEqual({ from: '2026-10-10', to: '2026-10-11' });
  });

  it('"this week" and "ngayong linggo" run from today to Sunday', () => {
    expect(resolveDates('this week', WEDNESDAY)).toMatchObject([{ from: WEDNESDAY, to: '2026-10-04' }]);
    expect(resolveDates('ngayong linggo', WEDNESDAY)).toMatchObject([{ from: WEDNESDAY, to: '2026-10-04' }]);
  });
});

describe('explicit dates', () => {
  it.each([
    ['Check availability for September 30, 2026.', '2026-09-30'],
    ['Sept 30', '2026-09-30'],
    ['30 September', '2026-09-30'],
    ['sa 30 ng Setyembre', '2026-09-30'],
    ['2026-10-08', '2026-10-08'],
    // No year, and already past this year: next year's.
    ['5 May', '2027-05-05'],
    ['May 5, 2027', '2027-05-05'],
  ])('%s → %s', (message, date) => {
    expect(one(message)).toBe(date);
  });

  it('an impossible date is not a date', () => {
    expect(resolveDates('2026-02-30', SUNDAY)).toEqual([]);
    expect(resolveDates('February 30', SUNDAY)).toEqual([]);
  });
});

describe('calendar edges: tomorrow is the next calendar day', () => {
  it.each([
    ['2026-09-30', 'bukas', '2026-10-01'], // month end
    ['2026-12-31', 'tomorrow', '2027-01-01'], // year end
    ['2026-12-31', 'sa makalawa', '2027-01-02'],
    ['2028-02-28', 'bukas', '2028-02-29'], // leap year
    ['2027-02-28', 'bukas', '2027-03-01'], // not a leap year
    ['2028-02-29', 'tomorrow', '2028-03-01'],
  ])('from %s, "%s" → %s', (today, message, date) => {
    expect(one(message, today)).toBe(date);
  });

  it('addDays crosses a year backwards too', () => {
    expect(addDays('2027-01-01', -1)).toBe('2026-12-31');
  });
});

describe('Philippine time near midnight: "today" is the tenant\'s calendar date', () => {
  // The same arithmetic as localDate() in @rag/bookings, which answer.ts's
  // `today` comes from: an instant formatted into the tenant's zone.
  const manila = (instant: string) =>
    new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit' }).format(
      new Date(instant),
    );

  it('23:59 in Manila is still the 27th, so bukas is the 28th', () => {
    expect(one('bukas', manila('2026-09-27T15:59:00Z'))).toBe('2026-09-28');
  });

  it('00:30 in Manila is already the 28th (UTC is still the 27th), so bukas is the 29th', () => {
    expect(manila('2026-09-27T16:30:00Z')).toBe('2026-09-28');
    expect(one('bukas', manila('2026-09-27T16:30:00Z'))).toBe('2026-09-29');
  });
});

describe('what is NOT a date', () => {
  it.each([
    'Is it available?',
    'What time is check-in?',
    'How much is the Day Tour on weekends?',
    'Magkano po ang Overnight?',
    'Pwede po bang magdala ng aso?',
    // "bukas" as "open", not "tomorrow".
    'Bukas ba ang pool sa gabi?',
    'Bukas pa po ba kayo?',
    'Hindi bukas ang kitchen.',
    // "may" as Tagalog "there is", not the month.
    'May 2 rooms po ba kayo?',
    'May parking po ba?',
  ])('%s', (message) => {
    expect(resolveDates(message, SUNDAY)).toEqual([]);
  });

  it('"bukas" next to another date is "open": "Bukas po ba kayo sa Linggo?" is Sunday only', () => {
    expect(resolveDates('Bukas po ba kayo sa Linggo?', WEDNESDAY)).toMatchObject([{ phrase: 'sa linggo', from: '2026-10-04' }]);
  });
});

describe('several dates in one message, in the order written', () => {
  it('"Friday or Saturday"', () => {
    expect(resolveDates('Friday or Saturday?', SUNDAY).map((m) => m.from)).toEqual(['2026-10-02', '2026-10-03']);
  });
});

describe('dateInstructions', () => {
  it('no dates, no lines: a question with no date gets the prompt it had before', () => {
    expect(dateInstructions([], SUNDAY)).toEqual([]);
  });

  it('the date, its weekday, and "answer from the result" of the call already made', () => {
    expect(dateInstructions(resolveDates('Available ba kayo bukas?', SUNDAY), SUNDAY)).toEqual([
      'In the user\'s latest message, "bukas" means 2026-09-28 (Monday). ' +
        'check_availability was already called with date_from 2026-09-28; ' +
        'answer from its result, and name 28 September 2026 in your answer. Do not ask which date they mean.',
    ]);
  });

  it('a range: both ends, and both tool arguments', () => {
    const [line] = dateInstructions(resolveDates('next week', SUNDAY), SUNDAY);
    expect(line).toContain('2026-09-28 (Monday) to 2026-10-04 (Sunday)');
    expect(line).toContain('date_from 2026-09-28 and date_to 2026-10-04');
  });

  it('past: say it has passed', () => {
    expect(dateInstructions(resolveDates('Available ba kahapon?', SUNDAY), SUNDAY)[0]).toBe(
      'In the user\'s latest message, "kahapon" means 2026-09-26 (Saturday), which has already passed. ' +
        'Tell the user that 26 September 2026 is in the past, so it cannot be checked or booked.',
    );
  });
});

describe('which messages get check_availability run up front (planDates)', () => {
  const calls = (message: string, earlier: string[] = [], today = SUNDAY) => planDates(message, today, earlier).calls;

  it.each([
    ['Is the resort available tomorrow?', [{ date_from: '2026-09-28' }]],
    ['Available ba kayo bukas?', [{ date_from: '2026-09-28' }]],
    ['May available room ba bukas?', [{ date_from: '2026-09-28' }]],
    ['May vacant rooms ba kayo sa makalawa?', [{ date_from: '2026-09-29' }]],
    ['Mag-book kami bukas.', [{ date_from: '2026-09-28' }]],
    ['May bakante ba kayo next week?', [{ date_from: '2026-09-28', date_to: '2026-10-04' }]],
    ['Check availability for September 30, 2026.', [{ date_from: '2026-09-30' }]],
    ['Is Friday or Saturday free?', [{ date_from: '2026-10-02' }, { date_from: '2026-10-03' }]],
  ] as const)('%s', (message, expected) => {
    expect(calls(message)).toEqual(expected);
  });

  it('a documents question with a date gets NOTHING, no call and no prompt line: trap 10', () => {
    for (const message of ['What time is check-in bukas?', 'Is the pool open tomorrow?', 'Anong oras ang check-out sa Friday?']) {
      expect(planDates(message, SUNDAY, [])).toEqual({ lines: [], calls: [] });
    }
  });

  // D-074: villa's rates come from the tool, so a price asked for a date is
  // checked up front like an availability question. Before, "Magkano po ang
  // Day Tour sa Friday?" was a documents question (the rate was in them).
  it('a PRICE question with a date is checked up front (D-074)', () => {
    expect(calls('Magkano po ang Day Tour sa Friday?')).toEqual([{ date_from: '2026-10-02' }]);
    expect(calls('How much is the Overnight tomorrow?')).toEqual([{ date_from: '2026-09-28' }]);
  });

  it('no date, no call: the model asks, as before', () => {
    expect(calls('Is it available?')).toEqual([]);
  });

  it('an ambiguous date is never checked; its line tells the model to ask which one', () => {
    const plan = planDates('Available ba next Friday?', WEDNESDAY, []);
    expect(plan.calls).toEqual([]);
    expect(plan.lines[0]).toContain('Ask which of the two they mean.');
  });

  it('a past date is still passed on, so the tool can say it is in the past', () => {
    expect(calls('Available ba kahapon?')).toEqual([{ date_from: '2026-09-26' }]);
  });

  it('a bare date after an availability question is a follow-up, and is checked', () => {
    const earlier = ['Available ba kayo bukas?'];
    expect(calls('What about the day after tomorrow?', earlier)).toEqual([{ date_from: '2026-09-29' }]);
    expect(calls('Paano kung sa Friday naman po?', earlier)).toEqual([{ date_from: '2026-10-02' }]);
  });

  it('the same bare date after a pricing question is one too (D-074)', () => {
    expect(calls('Paano kung sa Friday?', ['Magkano po ang Day Tour?'])).toEqual([{ date_from: '2026-10-02' }]);
  });

  it('a bare date after a documents question is still nothing', () => {
    expect(calls('Paano kung sa Friday?', ['Anong oras ang check-in?'])).toEqual([]);
  });

  it('at most MAX_DATE_CHECKS dates', () => {
    expect(calls('Available ba Monday, Tuesday, Wednesday or Thursday?')).toHaveLength(MAX_DATE_CHECKS);
  });
});

describe('asksUndatedPrice (D-081)', () => {
  it('a price word and no date', () => {
    for (const m of ['room rates please', 'Magkano po?', 'How much is the Overnight?', 'presyo ng Day Tour', 'what are your prices']) {
      expect(asksUndatedPrice(m, WEDNESDAY)).toBe(true);
    }
  });

  it('a date makes it a priced availability turn instead (planDates)', () => {
    for (const m of ['room rates on Saturday', 'Magkano po bukas?', 'How much is the Overnight on 10 October?']) {
      expect(asksUndatedPrice(m, WEDNESDAY)).toBe(false);
    }
  });

  it('no price word, no price question', () => {
    for (const m of ['What time is check-in?', 'Is it available?', 'Pwede po bang magdala ng aso?']) {
      expect(asksUndatedPrice(m, WEDNESDAY)).toBe(false);
    }
  });
});

describe('asksAvailability and isDateOnly', () => {
  it('availability words, English and Tagalog', () => {
    for (const m of ['available?', 'may bakante?', 'fully booked na ba', 'pa-book po', 'reserve ko', 'any slots']) {
      expect(asksAvailability(m)).toBe(true);
    }
    for (const m of ['What time is check-in?', 'Is the pool open?', 'Anong oras ang check-out?']) {
      expect(asksAvailability(m)).toBe(false);
    }
    // D-074: price words count too, English and Tagalog.
    for (const m of ['Magkano po?', 'How much is the Overnight?', 'What is the rate?', 'presyo ng Day Tour']) {
      expect(asksAvailability(m)).toBe(true);
    }
  });

  // Found by rt-tagalog (plan/extra-guests.md Phase 4): Tagalog joins an
  // adjective to its noun with the linker "-ng", so "bakante" (vacant)
  // becomes "bakanteng kwarto" (a vacant room). `\bbakante\b` missed it, the
  // up-front check never ran, and the model asked for a date it had been given.
  it('the Tagalog linker: "bakanteng kwarto" and "may bakanteng slot" are availability questions', () => {
    for (const m of ['May bakanteng kwarto po ba kayo sa 12 October 2026?', 'may bakanteng slot ba bukas', 'Bakanteng kwarto para sa 3']) {
      expect(asksAvailability(m)).toBe(true);
    }
    expect(planDates('May bakanteng kwarto po ba kayo sa 12 October 2026?', SUNDAY, []).calls).toEqual([{ date_from: '2026-10-12' }]);
  });

  it('a date wrapped in filler is date-only; a date inside a question is not', () => {
    expect(isDateOnly('How about the day after tomorrow?', SUNDAY)).toBe(true);
    expect(isDateOnly('Paano kung bukas po?', SUNDAY)).toBe(true);
    expect(isDateOnly('What time is check-in bukas?', SUNDAY)).toBe(false);
    expect(isDateOnly('Hello', SUNDAY)).toBe(false);
  });
});


describe('ranges: two dates joined, and a night count (R-15)', () => {
  const range = (message: string, today = SUNDAY) => {
    const found = resolveDates(message, today);
    return found.length === 1 && !found[0]!.alternative ? `${found[0]!.from}..${found[0]!.to}` : found;
  };

  it.each([
    ['Is anything free from 10 October to 12 October?', '2026-10-10..2026-10-12'],
    ['Available from Oct 10 until Oct 12?', '2026-10-10..2026-10-12'],
    ['Available ba mula 10 Oktubre hanggang 12 Oktubre?', '2026-10-10..2026-10-12'],
    ['Free between 10 October and 12 October?', '2026-10-10..2026-10-12'],
    ['Oct 10 - Oct 12, may bakante?', '2026-10-10..2026-10-12'],
    ['Oct 10 – Oct 12, may bakante?', '2026-10-10..2026-10-12'],
    ['Free from Friday to Sunday?', '2026-10-02..2026-10-04'],
    ['Free from tomorrow through Wednesday?', '2026-09-28..2026-09-30'],
  ])('%s → %s', (message, expected) => {
    expect(range(message)).toBe(expected);
  });

  it.each([
    ['Is 10 October free for 2 nights?', '2026-10-10..2026-10-11'],
    ['Available ba 10 October, dalawang gabi?', '2026-10-10..2026-10-11'],
    ['2 nights from Oct 10, may bakante?', '2026-10-10..2026-10-11'],
    ['Two nights starting October 10?', '2026-10-10..2026-10-11'],
    ['3 days 2 nights from Oct 10?', '2026-10-10..2026-10-11'],
    ['Available bukas for 3 nights?', '2026-09-28..2026-09-30'],
    ['Free on Friday for 1 night?', '2026-10-02..2026-10-02'],
  ])('%s → %s', (message, expected) => {
    expect(range(message)).toBe(expected);
  });

  it('does not join what is not a range', () => {
    // Two dates with a plain "and" are two days, not everything between.
    expect(resolveDates('Free on Friday and Monday?', SUNDAY)).toHaveLength(2);
    // Out of order: not a span.
    expect(resolveDates('From 12 October to 10 October?', SUNDAY)).toHaveLength(2);
    // "next Friday" midweek is ambiguous, so it never joins.
    expect(resolveDates('From next Friday to Sunday?', WEDNESDAY)).toHaveLength(2);
    // Harbor's slot is called Night: no number, no nights.
    expect(range('Is the Night slot free on Oct 10?')).toBe('2026-10-10..2026-10-10');
  });

  it('the connector words are gone from the rest, so a bare range is date-only', () => {
    expect(isDateOnly('From 10 October to 12 October?', SUNDAY)).toBe(true);
    expect(isDateOnly('How about Oct 10 for 2 nights?', SUNDAY)).toBe(true);
    expect(isDateOnly('Is the pool open from 10 October to 12 October?', SUNDAY)).toBe(false);
  });

  it('planDates runs ONE call for the span, and the line names both ends', () => {
    const plan = planDates('Is anything free from 10 October to 12 October?', SUNDAY, []);
    expect(plan.calls).toEqual([{ date_from: '2026-10-10', date_to: '2026-10-12' }]);
    expect(plan.lines[0]).toContain('date_from 2026-10-10 and date_to 2026-10-12');
    expect(plan.lines[0]).toContain('10 October 2026 to 12 October 2026');
    const nights = planDates('Available ba 10 October for 2 nights?', SUNDAY, []);
    expect(nights.calls).toEqual([{ date_from: '2026-10-10', date_to: '2026-10-11' }]);
  });
});

describe('the guest count rides on the up-front call (D-074, R-37)', () => {
  it.each([
    ['How much is the Loft for 3 guests on 12 October 2026?', 3],
    ['Available ba kayo bukas, 32 kami?', 32],
    ['Kaming lima, may room ba sa Friday?', 5],
    ['Free on Oct 10 for 4 pax?', 4],
    ['Is 10 October free for 2 nights?', null],
    ['Available bukas?', null],
  ])('%s → %s', (message, guests) => {
    expect(guestCount(message)).toBe(guests);
  });

  it('planDates passes it, and the line names it', () => {
    const plan = planDates('How much is the Day Tour on 12 October 2026 for 32 guests?', SUNDAY, []);
    expect(plan.calls).toEqual([{ date_from: '2026-10-12', guests: 32 }]);
    expect(plan.lines[0]).toContain('date_from 2026-10-12 and guests 32');
    const stay = planDates('2 nights from Oct 10 for 4 guests, available?', SUNDAY, []);
    expect(stay.calls).toEqual([{ date_from: '2026-10-10', date_to: '2026-10-11', guests: 4 }]);
    expect(planDates('Is 10 October free?', SUNDAY, []).calls).toEqual([{ date_from: '2026-10-10' }]);
  });
});
