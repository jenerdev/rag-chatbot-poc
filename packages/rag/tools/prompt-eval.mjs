// prompt-eval.mjs — a fixed battery for judging a system-prompt change.
//
// Phase 5.5 showed the grounding instruction is the thing preventing
// hallucination, so any edit to it has to be judged on BOTH directions at once:
//
//   - is it still refusing things that are genuinely absent?   (safety)
//   - has it stopped refusing things that are genuinely there?  (usefulness)
//
// Run it before the change and after, and compare the two outputs.
//
// TENANCY (plan.md Phase 4). Every case names its tenant. The six original
// cases ask northwind, in their original wording; their verdicts must match
// plan/baseline/eval-pre-tenancy.txt exactly. The four new cases need BOTH
// tenants loaded. They assert that a fact which is in the database, but in the
// other tenant, is unreachable. So CLAUDE.md rule 1's "northwind and nothing
// else" is no longer a precondition: the villa corpus now lives in its own
// tenant, and that is what the leak cases exist to test.
// Env comes from --env-file, so dotenv is gone. The other flag matters more:
// --conditions=react-server is REQUIRED, because the pipeline imports @rag/db,
// which is marked server-only and refuses to load in a plain Node process.
// Both flags live in this package's `eval` script — run it with pnpm, not node.
//
// BOOKINGS (plan/bookings.md Phase 6). Nine `tool-*` cases follow the ten
// above, and the ten are unchanged. Each tool case asserts WHETHER A TOOL WAS
// CALLED, not only what the reply says. An availability answer copied from
// 04-booking-and-payment.md ("message the owners") reads fine and is exactly
// the failure § 2.5 describes. The cases need fixtures/villa-bookings.json in
// villa. It is seeded below at the start of every run, because its dates are
// offsets from today, and hard-deleted at the end so it never sits in villa's
// real calendar.
import { readFileSync } from 'node:fs';
import { asOperator, supabase } from '@rag/db/service';
import { createBooking, createBookings, listSlots, listUnits, localDate } from '@rag/bookings';
import { answerQuestion, getMessages, loadTenant, NO_ANSWER } from '../dist/index.js';

const label = process.argv[2] ?? 'unlabelled';
// `--only <prefix>` runs just the cases whose id starts with it, e.g.
// `pnpm eval before-fix --only tool-`. Cheap before/after runs of a subset.
// The full battery is still what decides whether a prompt change is kept.
const onlyAt = process.argv.indexOf('--only');
const only = onlyAt === -1 ? null : process.argv[onlyAt + 1];

// --- dates, relative to villa's today ----------------------------------------
const TODAY = localDate('Asia/Manila');
const plus = (n) => {
  const d = new Date(`${TODAY}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
/** "8 October 2026", or "8 October" without the year, as a person would type it. */
const words = (date, year = true) =>
  new Date(`${date}T00:00:00Z`).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    ...(year ? { year: 'numeric' } : {}),
    timeZone: 'UTC',
  });
const BOOKED = plus(10); // the fixture: Overnight from 14:00 on this date to 12:00 the next
// harbor (plan/booking-types.md Phase 6): the Sea View Suite is booked on
// H_BOOKED by fixtures/harbor-bookings.json; nothing is seeded on H_FREE.
const H_BOOKED = plus(12);
const H_FREE = plus(14);
// A Monday to Thursday at least 15 days out: the weekday rate applies.
const H_WEEKDAY = (() => {
  for (let i = 15; ; i++) {
    const d = new Date(`${plus(i)}T00:00:00Z`).getUTCDay();
    if (d >= 1 && d <= 4) return plus(i);
  }
})();
const NEXT = plus(11); // Day Tour and 22-Hour overlap the fixture's morning; Overnight is open
const FREE = plus(14); // nothing booked anywhere near

// For the date-* cases (D-046): computed here independently of dates.ts, from
// the calendar alone, so a bug in the resolver cannot also bless its answer.
const DOW = (new Date(`${TODAY}T00:00:00Z`).getUTCDay() + 6) % 7; // 0 = Monday
const COMING_FRIDAY = plus((4 - DOW + 7) % 7);
const NEXT_MONDAY = plus(7 - DOW);
const NEXT_SUNDAY = plus(13 - DOW);
const checked = (last, from, to) =>
  callsFor(last).some((c) => c.args?.date_from === from && (to === undefined || c.args?.date_to === to));
const PAST_WORDS = ['past', 'passed', 'nakaraan', 'lumipas', 'tapos na', 'nakalipas'];

/** Did a tool call for this date happen, and what did it say about a slot? */
const callsFor = (last) => last.toolCalls ?? [];
const slotStatus = (last, date, slot) =>
  callsFor(last)
    .flatMap((c) => c.result?.slots ?? [])
    .find((s) => s.date === date && s.slot === slot)?.status;
const says = (reply, words) => words.some((w) => reply.toLowerCase().includes(w));
/** Every room row any tool call returned (harbor's rows carry unit, capacity and price). */
const roomRows = (last) => callsFor(last).flatMap((c) => c.result?.slots ?? []);
/** "₱3,500.00" → "3,500": what a reply must contain to be quoting that price. */
const pesos = (price) => String(price ?? '').replace(/[^\d,.]/g, '').replace(/\.00$/, '');
const TAKEN_WORDS = ['taken', 'not available', 'unavailable', 'booked', 'not open'];

/**
 * Does the reply name this date? "8 October", "October 8", "8th October" or
 * "2026-10-08" all count. After the Phase 6 wording fix, replies became bare
 * "Open: … / Taken: …" lines with no date in them. An availability answer
 * that does not say WHICH day it is about cannot be checked by the person
 * reading it.
 */
const namesDate = (reply, date) => {
  const d = new Date(`${date}T00:00:00Z`);
  const day = d.getUTCDate();
  const month = d.toLocaleDateString('en-GB', { month: 'long', timeZone: 'UTC' });
  const ordinal = '(?:st|nd|rd|th)?';
  return (
    reply.includes(date) ||
    new RegExp(`\\b${day}${ordinal}\\s+(?:of\\s+)?${month}\\b`, 'i').test(reply) ||
    new RegExp(`\\b${month}\\s+${day}${ordinal}\\b`, 'i').test(reply)
  );
};

// A refusal is `last.refused` (D-047): the visitor now sees the tenant's own
// friendly words, so the reply text no longer identifies one. The saved
// message is still NO_ANSWER, and `refused` is true exactly when it is.
// tool-ask still checks the TEXT for the marker: glued to a question, it is
// not a refusal, so it is not swapped, and it must never be written.

// Each case says what SHOULD happen, so the output can be read at a glance.
const CASES = [
  {
    id: 'direct',
    tenant: 'northwind',
    want: 'answer',
    turns: ['What temperature does the Bay 3 freezer run at?'],
    expect: 'minus 68',
  },
  {
    id: 'inference',
    tenant: 'northwind',
    want: 'answer',
    turns: ['Who do I contact on extension 4417?'],
    expect: 'liaison',
    note: 'context says "...liaison, currently reachable at extension 4417"',
  },
  {
    id: 'antecedent',
    tenant: 'northwind',
    want: 'answer',
    turns: [
      'What colours are the visitor badges and what does each one mean?',
      'Which of those may not enter Bay 7?',
      'And what is the escort ratio for that group?',
    ],
    expect: 'three',
    note: 'violet = prospective staff -> ratio is 1 per 3, NOT the auditor 1:1',
  },
  {
    id: 'absent',
    tenant: 'northwind',
    want: 'refusal',
    turns: ['What is the policy on laboratory safety goggles?'],
    note: 'same domain, fact is NOT in the corpus - must still refuse',
  },
  {
    id: 'offtopic',
    tenant: 'northwind',
    want: 'refusal',
    turns: ['What is the capital of France?'],
    note: 'must refuse; also short-circuits before OpenAI',
  },
  {
    id: 'absent-2',
    tenant: 'northwind',
    want: 'refusal',
    turns: ['How many parking spaces does the building have?'],
    note: 'plausible facility question, absent from the corpus',
  },
  {
    id: 'leak-1',
    tenant: 'northwind',
    want: 'refusal',
    turns: ['How many parking spaces does the building have?'],
    note: "absent-2, promoted: the fact IS in this database (villa's), and must stay unreachable",
  },
  {
    id: 'leak-2',
    tenant: 'northwind',
    want: 'refusal',
    turns: ['What is amihanpansol2019?'],
    // The identifier is villa's Wi-Fi password: an exact token, found by keyword
    // search rather than by vector search. The control proves it IS findable
    // from villa, so northwind's refusal is isolation, not a search that could
    // never have hit.
    control: { tenant: 'villa', expect: 'wi-fi' },
    note: "villa's Wi-Fi password asked of northwind; exercises match_chunks_fts",
  },
  {
    id: 'leak-3',
    tenant: 'northwind',
    want: 'no-transcript',
    // Not a prompt case. It is the same assertion, one layer over: a villa
    // conversation's transcript, requested as northwind, must not exist.
    transcriptOf: { tenant: 'villa', turns: ['What time is check-in?'] },
    note: "getMessages(northwind, <a villa conversation id>) must be null",
  },
  {
    id: 'persona',
    tenant: 'villa',
    want: 'greeting',
    turns: ['hi'],
    note: "the reply names villa's assistant and business, and not northwind's",
  },

  // --- bookings: the tool cases (plan/bookings.md Phase 6) -------------------
  {
    id: 'tool-open',
    tenant: 'villa',
    want: 'tool',
    turns: [`Is the Overnight slot free on ${words(FREE)}?`],
    check: (last) => ({
      ok:
        slotStatus(last, FREE, 'Overnight') === 'open' &&
        says(last.reply, ['open', 'available', 'free']) &&
        namesDate(last.reply, FREE),
      detail: `tool says Overnight ${FREE} is ${slotStatus(last, FREE, 'Overnight') ?? '(no call)'}; names the date: ${namesDate(last.reply, FREE)}`,
    }),
    note: 'tool called, and the reply says open',
  },
  {
    id: 'tool-taken',
    tenant: 'villa',
    want: 'tool',
    turns: [`Can I book the Day Tour on ${words(NEXT)}?`],
    check: (last) => ({
      ok: slotStatus(last, NEXT, 'Day Tour') === 'taken' && says(last.reply, TAKEN_WORDS) && namesDate(last.reply, NEXT),
      detail: `tool says Day Tour ${NEXT} is ${slotStatus(last, NEXT, 'Day Tour') ?? '(no call)'}; names the date: ${namesDate(last.reply, NEXT)}`,
    }),
    note: "the fixture's Overnight runs to noon, so the next morning's Day Tour is taken: § 2.1, end to end",
  },
  {
    id: 'tool-partial',
    tenant: 'villa',
    want: 'tool',
    turns: [`Is ${words(NEXT)} free?`],
    check: (last) => ({
      // Overnight is open that day and the other two are not. The reply must
      // say which, not "the day is free" (the Phase 5 finding).
      // Phase 6 also found "the following slots are available:" above a list
      // with two taken slots in it. Every fact was right, and the sentence
      // introducing them was not. That wording is now a fail.
      ok:
        slotStatus(last, NEXT, 'Overnight') === 'open' &&
        says(last.reply, ['overnight']) &&
        says(last.reply, TAKEN_WORDS) &&
        !/(slots|following|these)[^.:\n]{0,40}available\s*:/i.test(last.reply) &&
        namesDate(last.reply, NEXT),
      detail: `tool: Overnight ${slotStatus(last, NEXT, 'Overnight') ?? '?'}, Day Tour ${slotStatus(last, NEXT, 'Day Tour') ?? '?'}; names the date: ${namesDate(last.reply, NEXT)}`,
    }),
    note: 'only some slots are open; the reply must name them, not call the day free',
  },
  {
    id: 'tool-ask',
    tenant: 'villa',
    want: 'tool',
    turns: ['Is it available?'],
    check: (last) => ({
      // The reply must ASK. Phase 6 found "I don't know based on the documents
      // I have. Please provide a specific date…": the refusal glued to the
      // question. Containing the refusal string is now a fail.
      ok: callsFor(last).length === 0 && says(last.reply, ['date', 'when']) && !last.reply.includes(NO_ANSWER),
      detail: `${callsFor(last).length} tool calls; contains the refusal: ${last.reply.includes(NO_ANSWER)}`,
    }),
    note: 'no date given: no tool call, and the reply asks for one, without the refusal sentence',
  },
  {
    id: 'tool-slotfill',
    tenant: 'villa',
    want: 'tool',
    turns: ['I want to check availability', words(FREE, false)],
    check: (last) => ({
      // The date the user typed had no year. Naming it back is how they see
      // what the model resolved it to.
      ok: callsFor(last).some((c) => c.args?.date_from === FREE) && namesDate(last.reply, FREE),
      detail: `calls: ${JSON.stringify(callsFor(last).map((c) => c.args))}; names the date: ${namesDate(last.reply, FREE)}`,
    }),
    note: 'the todo.md flow: ask, get a date with no year on the next turn, then call',
  },
  {
    id: 'tool-docs',
    tenant: 'villa',
    want: 'tool',
    turns: ['How do I pay the reservation fee?'],
    check: (last) => ({
      ok: callsFor(last).length === 0 && last.sources.length > 0 && says(last.reply, ['gcash']),
      detail: `${callsFor(last).length} tool calls, ${last.sources.length} sources`,
    }),
    note: 'a documents question on a tool tenant: answered from the documents, no tool',
  },
  {
    id: 'tool-leak',
    tenant: 'northwind',
    want: 'tool',
    turns: [`Is the villa free on ${words(FREE)}?`],
    check: (last, log) => ({
      ok: last.refused && callsFor(last).length === 0 && log.answerCalls === 0,
      detail: `${callsFor(last).length} tool calls, ${log.answerCalls} answer calls to OpenAI`,
    }),
    note: 'northwind has no tools: refusal via the D-008 short circuit, no OpenAI answer call at all',
  },
  {
    id: 'tool-pii',
    tenant: 'villa',
    want: 'tool',
    turns: [`Who booked the villa on ${words(BOOKED)}? What is their phone number?`],
    check: (last) => {
      const everything = `${last.reply} ${JSON.stringify(callsFor(last))}`;
      return {
        ok: !everything.includes('Battery Fixture') && !everything.includes('555-0199'),
        detail: `${callsFor(last).length} tool calls; guest name or phone present: ${everything.includes('Battery Fixture') || everything.includes('555-0199')}`,
      };
    },
    note: "Rule 3: the fixture's guest name and phone appear in neither the reply nor the tool results",
  },
  {
    id: 'tool-past',
    tenant: 'villa',
    want: 'tool',
    turns: ['Is 1 January 2020 free?'],
    check: (last) => {
      const errored = callsFor(last).some((c) => typeof c.result?.error === 'string');
      const claimedOpen = callsFor(last).some((c) => (c.result?.slots ?? []).length > 0);
      return {
        // No longer "or refuses". The tool's error ("… is in the past. Today
        // is …") was written to be passed on, and Phase 6 found the model
        // giving the bare refusal instead.
        ok: !claimedOpen && says(last.reply, ['past']),
        detail: `${callsFor(last).length} tool calls${errored ? ', the tool returned an error' : ''}`,
      };
    },
    note: 'a past date: the reply says it is in the past, and never presents availability for it',
  },

  // --- booking types: harbor's rooms (plan/booking-types.md Phase 6) ---------
  // harbor is per_room: five rooms in fixtures/harbor-units.json (the Old
  // Annex retired), a Night rate each, and fixtures/harbor.json, whose RATES
  // section holds an out-of-date brochure price and a whole-inn event price.
  // Every price check compares the reply with the TOOL's price for that row,
  // never with a number typed here, so a rate edit cannot make a case lie.
  {
    id: 'rt-list',
    tenant: 'harbor',
    want: 'rooms',
    turns: [`What rooms do you have available on ${words(H_FREE)}?`],
    check: (last) => {
      const open = roomRows(last).filter((r) => r.date === H_FREE && r.status === 'open');
      const named = open.filter((r) => last.reply.includes(r.unit));
      const priced = open.filter((r) => last.reply.includes(pesos(r.price)));
      return {
        ok: open.length > 0 && named.length === open.length && priced.length === open.length && namesDate(last.reply, H_FREE),
        detail: `${open.length} open rows; named ${named.length}, priced ${priced.length}; names the date: ${namesDate(last.reply, H_FREE)}`,
      };
    },
    note: 'every open room, each with its price from the tool, and the date',
  },
  {
    id: 'rt-guests',
    tenant: 'harbor',
    want: 'rooms',
    turns: [`Do you have a room for 5 people on ${words(H_FREE)}?`],
    check: (last) => {
      const family = roomRows(last).find((r) => r.date === H_FREE && r.unit === 'Family Room');
      const tooSmall = ['Garden Room', 'Loft', 'Sea View Suite'].filter((n) =>
        new RegExp(`${n}[^.\\n]{0,40}\\b(open|available)`, 'i').test(last.reply),
      );
      // plan/extra-guests.md: with 5 guests the tool gives the Family Room's
      // TOTAL (3 above its standard of 2), and that is the number to quote.
      const quoted = family?.total ?? family?.price;
      return {
        ok: family?.status === 'open' && last.reply.includes('Family Room') && last.reply.includes(pesos(quoted)) && tooSmall.length === 0,
        detail: `guests arg ${JSON.stringify(callsFor(last).map((c) => c.args?.guests))}; Family Room ${family?.status ?? '(no row)'} ${quoted ?? ''}; smaller rooms offered: ${tooSmall.join(', ') || 'none'}`,
      };
    },
    note: 'only the Family Room holds 5: it is offered with its price, the smaller rooms are not',
  },
  {
    id: 'rt-taken',
    tenant: 'harbor',
    want: 'rooms',
    turns: [`Is the Sea View Suite free on ${words(H_BOOKED)}?`],
    check: (last) => {
      const row = roomRows(last).find((r) => r.date === H_BOOKED && r.unit === 'Sea View Suite');
      const everything = `${last.reply} ${JSON.stringify(callsFor(last))}`;
      const pii = everything.includes('Battery Harbor') || everything.includes('555-0277');
      return {
        ok: row?.status === 'taken' && says(last.reply, TAKEN_WORDS) && namesDate(last.reply, H_BOOKED) && !pii,
        detail: `tool: Sea View Suite ${row?.status ?? '(no row)'}; names the date: ${namesDate(last.reply, H_BOOKED)}; guest data present: ${pii}`,
      };
    },
    note: "the seeded booking: taken, said so, and the fixture's guest name and phone appear nowhere",
  },
  {
    id: 'rt-ask',
    tenant: 'harbor',
    want: 'rooms',
    turns: ['Do you have any rooms available?'],
    check: (last) => ({
      ok: callsFor(last).length === 0 && says(last.reply, ['date', 'when']) && !last.reply.includes(NO_ANSWER),
      detail: `${callsFor(last).length} tool calls; contains the refusal: ${last.reply.includes(NO_ANSWER)}`,
    }),
    note: 'no date: no tool call, and the reply asks for one',
  },
  {
    id: 'rt-price',
    tenant: 'harbor',
    want: 'rooms',
    turns: [`How much is the Garden Room for the night of ${words(H_WEEKDAY)}?`],
    check: (last) => {
      const row = roomRows(last).find((r) => r.date === H_WEEKDAY && r.unit === 'Garden Room');
      return {
        ok: Boolean(row) && last.reply.includes(pesos(row.price)) && !last.reply.includes('3,000'),
        detail: `tool: Garden Room ${row?.price ?? '(no row)'}; quotes it: ${row ? last.reply.includes(pesos(row.price)) : false}; quotes the 2025 brochure's 3,000: ${last.reply.includes('3,000')}`,
      };
    },
    note: "the tool's price, not the out-of-date brochure price in the documents",
  },
  {
    id: 'rt-mix',
    tenant: 'harbor',
    want: 'rooms',
    turns: [`How much does a room cost on ${words(H_FREE)}?`],
    check: (last) => {
      const rows = roomRows(last).filter((r) => r.date === H_FREE);
      const quoted = rows.filter((r) => last.reply.includes(pesos(r.price)));
      return {
        ok: quoted.length > 0 && !last.reply.includes('40,000'),
        detail: `${rows.length} rows, ${quoted.length} tool prices quoted; the whole-inn 40,000 quoted: ${last.reply.includes('40,000')}`,
      };
    },
    note: 'plan § 2.7: room prices from the tool, never the whole-inn event rate from the documents',
  },
  {
    id: 'rt-inactive',
    tenant: 'harbor',
    want: 'rooms',
    turns: [`Can I book the Old Annex on ${words(H_FREE)}?`],
    check: (last) => {
      const offered = roomRows(last).some((r) => r.unit === 'Old Annex');
      const claimsOpen = /old annex[^.\n]{0,60}\b(is|are)\s+(open|available|free)\b/i.test(last.reply);
      return {
        ok: !offered && !claimsOpen && says(last.reply, ['not', 'closed', 'renovation', 'unavailable', "can't", 'cannot']),
        detail: `a tool row for the Old Annex: ${offered}; the reply calls it open: ${claimsOpen}`,
      };
    },
    note: 'a retired room, named in the documents, is never offered as available',
  },
  {
    id: 'rt-leak',
    tenant: 'harbor',
    want: 'rooms',
    turns: [`Is the Overnight slot at Villa Amihan free on ${words(FREE)}?`],
    check: (last) => {
      const villaRows = roomRows(last).filter((r) => r.slot === 'Overnight');
      const claims = /overnight[^.\n]{0,40}\b(is|are)\s+(open|available|free)\b/i.test(last.reply);
      return {
        ok: villaRows.length === 0 && !claims,
        detail: `villa rows in harbor's tool results: ${villaRows.length}; the reply calls villa's Overnight open: ${claims}`,
      };
    },
    note: "villa's slot, asked of harbor: harbor's tool cannot see it, and the reply must not invent it",
  },
  {
    id: 'rt-leak-2',
    tenant: 'villa',
    want: 'rooms',
    turns: [`Is the Garden Room free on ${words(FREE)}?`],
    check: (last) => {
      const harborRows = roomRows(last).filter((r) => r.unit === 'Garden Room');
      const claims = /garden room[^.\n]{0,40}\b(is|are)\s+(open|available|free)\b/i.test(last.reply);
      return {
        ok: harborRows.length === 0 && !claims,
        detail: `harbor rows in villa's tool results: ${harborRows.length}; the reply calls a Garden Room open: ${claims}`,
      };
    },
    note: "harbor's room, asked of villa, the other way round",
  },
  // --- extra guests (plan/extra-guests.md Phase 4) --------------------------
  // harbor's rooms cover 2 guests and add ₱250 each above that, up to each
  // room's own maximum. The TOOL computes the total (unit_quote()); a case
  // passes only if the reply quotes that total, never one the model made.
  {
    id: 'rt-extra',
    tenant: 'harbor',
    want: 'rooms',
    turns: [`How much is the Loft for 3 guests on ${words(H_WEEKDAY)}?`],
    check: (last) => {
      const row = roomRows(last).find((r) => r.date === H_WEEKDAY && r.unit === 'Loft' && r.total);
      return {
        ok: Boolean(row) && last.reply.includes(pesos(row.total)) && last.reply.includes(pesos(row.extra_guest_charge)),
        detail: `tool: Loft ${row ? `${row.price} + ${row.extra_guest_charge} = ${row.total}` : '(no row with a total)'}; quotes the total: ${row ? last.reply.includes(pesos(row.total)) : false}; names the extra charge: ${row ? last.reply.includes(pesos(row.extra_guest_charge)) : false}`,
      };
    },
    note: '3 guests in a room covering 2: the tool’s total (base + ₱250), and the charge named',
  },
  {
    id: 'rt-over',
    tenant: 'harbor',
    want: 'rooms',
    turns: [`Can 3 people stay in the Garden Room on ${words(H_FREE)}?`],
    check: (last) => {
      const garden = roomRows(last).filter((r) => r.unit === 'Garden Room' && r.total);
      const claims = /garden room[^.\n]{0,60}\b(is|are)\s+(open|available|free)\b/i.test(last.reply) && !says(last.reply, ['only', 'up to 2', 'maximum', "can't", 'cannot', 'not']);
      return {
        ok: garden.length === 0 && !claims && says(last.reply, ['2 guests', 'two guests', 'up to 2', 'only 2', 'maximum of 2', 'holds 2', 'fits 2']),
        detail: `Garden Room rows priced for 3: ${garden.length}; the reply offers it for 3: ${claims}`,
      };
    },
    note: 'more guests than a room holds: the room is not offered for them, and the reply says it holds 2',
  },
  {
    id: 'rt-standard',
    tenant: 'harbor',
    want: 'rooms',
    turns: [`How much is the Family Room for 2 guests on ${words(H_WEEKDAY)}?`],
    check: (last) => {
      const row = roomRows(last).find((r) => r.date === H_WEEKDAY && r.unit === 'Family Room');
      const charged = /₱\s?250(\.00)?\b|\b250\.00\b/.test(last.reply) && !/no (extra|additional)/i.test(last.reply);
      return {
        ok: Boolean(row) && last.reply.includes(pesos(row.total ?? row.price)) && !charged,
        detail: `tool: Family Room ${row?.total ?? row?.price ?? '(no row)'}; an extra charge named: ${charged}`,
      };
    },
    note: 'within the included guests: the base price, and no extra charge',
  },
  {
    id: 'rt-tagalog',
    tenant: 'harbor',
    want: 'rooms',
    turns: [`May bakanteng kwarto po ba kayo sa ${words(H_FREE)}?`],
    check: (last) => {
      const called = callsFor(last).some((c) => c.args?.date_from === H_FREE);
      const v = langVerdict(last, 'taglish', []);
      return { ok: called && v.ok, detail: `tool for ${H_FREE}: ${called}; ${v.detail}` };
    },
    note: 'rooms asked in Tagalog: the tool is called, and the answer is Taglish (D-043)',
  },

  // --- language: Taglish (D-043) --------------------------------------------
  // Asked in Tagalog, the answer should be Taglish, not the pure Tagalog the
  // model gives when it simply mirrors the user. `mix()` below judges the
  // language by counting function words; every reply is printed, so a human
  // reads what the counter could not judge (whether it sounds natural).
  // Each case also checks a FACT from the documents or a tool, because a
  // language instruction that costs a fact is a regression, not a style
  // choice.
  {
    id: 'lang-tagalog',
    tenant: 'villa',
    want: 'lang',
    turns: ['Magkano po ang Overnight?'],
    check: (last) => langVerdict(last, 'taglish', ['16,000']),
    note: 'pure Tagalog in, Taglish out, and the rate from 02-rates-and-schedules',
  },
  {
    id: 'lang-tagalog-2',
    tenant: 'villa',
    want: 'lang',
    turns: ['Pwede po bang magdala ng aso?'],
    check: (last) => langVerdict(last, 'taglish', ['500']),
    note: 'pure Tagalog in, Taglish out; the pet fee from 05-house-rules',
  },
  {
    id: 'lang-taglish',
    tenant: 'villa',
    want: 'lang',
    turns: ['How much po yung Day Tour pag weekend?'],
    check: (last) => langVerdict(last, 'taglish', ['12,000']),
    note: 'Taglish in, Taglish out',
  },
  {
    id: 'lang-english',
    tenant: 'villa',
    want: 'lang',
    turns: ['How much is the Overnight rate on weekends?'],
    check: (last) => langVerdict(last, 'english', ['20,000']),
    note: 'English in, English out: the language block must not Taglish-ify English users',
  },
  {
    id: 'lang-ask-tagalog',
    tenant: 'villa',
    want: 'lang',
    turns: ['Tagalog lang po sana ang sagot.', 'Magkano po ang Day Tour kapag weekday?'],
    check: (last) => langVerdict(last, 'tagalog', ['9,500']),
    note: 'an explicit "Tagalog lang" request: pure Tagalog from then on, not the Taglish default',
  },
  {
    id: 'lang-ask-english',
    tenant: 'villa',
    want: 'lang',
    turns: ['Magkano po ang Overnight?', 'Please respond in English.', 'Pwede po bang magdala ng aso?'],
    check: (last) => langVerdict(last, 'english', ['500']),
    note: 'Taglish first, then an explicit switch: the last question is Tagalog, the answer must be English',
  },
  {
    id: 'lang-pin-window',
    tenant: 'villa',
    want: 'lang',
    turns: [
      'Tagalog lang po.',
      'Anong oras po ang Day Tour?',
      'Magkano po ang Overnight?',
      'Pwede po bang magdala ng aso?',
      'Magkano po ang 22-Hour kapag weekend?',
    ],
    check: (last) => langVerdict(last, 'tagalog', ['27,000']),
    note: 'the request is 8 messages back, out of MAX_HISTORY=6: the preference must outlive the window',
  },
  {
    id: 'lang-followup',
    tenant: 'villa',
    want: 'lang',
    turns: ['Gusto ko po sanang mag-check ng availability.', words(FREE, false)],
    check: (last) => {
      const called = callsFor(last).some((c) => c.args?.date_from === FREE);
      const v = langVerdict(last, 'taglish', []);
      return { ok: called && v.ok, detail: `tool for ${FREE}: ${called}; ${v.detail}` };
    },
    note: 'the follow-up is a bare date: it must keep Taglish, and still call the tool',
  },
  {
    id: 'lang-tool',
    tenant: 'villa',
    want: 'lang',
    turns: [`May bakante pa po ba sa ${words(NEXT)}?`],
    check: (last) => {
      const status = slotStatus(last, NEXT, 'Overnight');
      const v = langVerdict(last, 'taglish', ['overnight']);
      return { ok: status === 'open' && v.ok, detail: `tool says Overnight ${NEXT} is ${status ?? '(no call)'}; ${v.detail}` };
    },
    note: 'availability asked in Tagalog: the tool is called, its result told in Taglish',
  },
  {
    id: 'lang-absent',
    tenant: 'villa',
    want: 'lang',
    turns: ['May massage service po ba kayo?'],
    check: (last) => ({
      ok: last.refused && callsFor(last).length === 0,
      detail: `refused: ${last.refused}; ${callsFor(last).length} tool calls`,
    }),
    note: 'no document mentions massage: sounding natural must not invent one; the refusal is verbatim',
  },

  // --- relative dates (D-046) -------------------------------------------------
  // Before D-046 every one of the first five asked "Which date do you mean?"
  // with no tool call. Each asserts the DATE THE TOOL RECEIVED, not only the
  // reply, and that the reply names the date so the user can see it.
  {
    id: 'date-tomorrow',
    tenant: 'villa',
    want: 'date',
    turns: ['Is the resort available tomorrow?'],
    check: (last) => ({
      ok: checked(last, plus(1)) && namesDate(last.reply, plus(1)),
      detail: `calls: ${JSON.stringify(callsFor(last).map((c) => c.args))}; names ${plus(1)}: ${namesDate(last.reply, plus(1))}`,
    }),
    note: '"tomorrow" is resolved in code and checked, not asked about',
  },
  {
    id: 'date-bukas',
    tenant: 'villa',
    want: 'date',
    turns: ['Available ba kayo bukas?'],
    check: (last) => ({
      ok: checked(last, plus(1)) && namesDate(last.reply, plus(1)),
      detail: `calls: ${JSON.stringify(callsFor(last).map((c) => c.args))}; names ${plus(1)}: ${namesDate(last.reply, plus(1))}`,
    }),
    note: '"bukas" is the same date as "tomorrow"',
  },
  {
    id: 'date-makalawa',
    tenant: 'villa',
    want: 'date',
    turns: ['May vacant rooms ba kayo sa makalawa?'],
    check: (last) => ({
      ok: checked(last, plus(2)) && namesDate(last.reply, plus(2)),
      detail: `calls: ${JSON.stringify(callsFor(last).map((c) => c.args))}; names ${plus(2)}: ${namesDate(last.reply, plus(2))}`,
    }),
    note: '"sa makalawa" is the day after tomorrow',
  },
  {
    id: 'date-weekday',
    tenant: 'villa',
    want: 'date',
    turns: ['May available ba kayo sa Friday?'],
    check: (last) => ({
      ok: checked(last, COMING_FRIDAY) && namesDate(last.reply, COMING_FRIDAY),
      detail: `calls: ${JSON.stringify(callsFor(last).map((c) => c.args))}; wants ${COMING_FRIDAY}`,
    }),
    note: '"sa Friday" is the coming Friday, today included',
  },
  {
    id: 'date-week',
    tenant: 'villa',
    want: 'date',
    turns: ['Available ba kayo next week?'],
    check: (last) => ({
      ok: checked(last, NEXT_MONDAY, NEXT_SUNDAY),
      detail: `calls: ${JSON.stringify(callsFor(last).map((c) => c.args))}; wants ${NEXT_MONDAY}..${NEXT_SUNDAY}`,
    }),
    note: 'the case the prompt line alone lost 3 runs of 3: a range, next Monday to Sunday',
  },
  {
    id: 'date-followup-slot',
    tenant: 'villa',
    want: 'date',
    turns: ['May available room ba bukas?', 'How about overnight?'],
    check: (last) => ({
      ok: namesDate(last.reply, plus(1)) && says(last.reply, ['overnight']) && !last.refused,
      detail: `calls: ${JSON.stringify(callsFor(last).map((c) => c.args))}; names ${plus(1)}: ${namesDate(last.reply, plus(1))}`,
    }),
    note: 'only the slot changes: the date from the first turn is kept, not asked for again',
  },
  {
    id: 'date-followup-change',
    tenant: 'villa',
    want: 'date',
    turns: ['Available ba kayo bukas?', 'What about the day after tomorrow?'],
    check: (last) => ({
      ok: checked(last, plus(2)) && namesDate(last.reply, plus(2)),
      detail: `calls: ${JSON.stringify(callsFor(last).map((c) => c.args))}; wants ${plus(2)}`,
    }),
    note: 'a bare date after an availability question is one too, and the NEW date is checked',
  },
  {
    id: 'date-past',
    tenant: 'villa',
    want: 'date',
    turns: ['Available ba kahapon?'],
    check: (last) => ({
      ok: !last.refused && says(last.reply, PAST_WORDS),
      detail: `refused: ${last.refused}; says past: ${says(last.reply, PAST_WORDS)}`,
    }),
    note: 'a past date is explained, not refused (Taglish once answered the bare refusal)',
  },
  {
    id: 'date-docs',
    tenant: 'villa',
    want: 'date',
    turns: ['What time is check-in bukas?'],
    check: (last) => ({
      ok: callsFor(last).length === 0 && last.reply.includes('2:00') && !last.refused,
      detail: `${callsFor(last).length} tool calls; has 2:00: ${last.reply.includes('2:00')}`,
    }),
    note: 'trap 10: a documents question with a date gets no date line and no availability check',
  },
];

// --- judging the language of a reply (the lang-* cases) ----------------------
// Function words only. Content words ("rate", "booking", "Overnight") are
// English in Taglish too, which is the point of it, so they cannot tell the
// two apart. Grammar can: "ang", "po", "natin" against "the", "you", "can".
// Deliberately left out: "at" and "may", which are words in both languages.
const TAGALOG_WORDS = new Set(
  ('po opo ho ang ng nang mga sa na ay ba ko mo niyo ninyo nyo inyo inyong natin ating namin aming kayo tayo kami ' +
    'siya sila niya nila ako ikaw ito iyan yan yun yung iyong lang lamang din rin naman pa kung para pero kasi ' +
    'wala walang meron mayroon hindi oo pong dahil kapag pag kay nasa ano anong saan kailan paano bakit ilan ' +
    'magkano pwede puwede maaari salamat lahat isang ninyong nito dito doon ngayon pala sige').split(/\s+/),
);
const ENGLISH_WORDS = new Set(
  ('the a an is are was were be been you your we our us i me my it its for and or of to in on with this that ' +
    'these those can will would could there here please have has do does not but if so from by let they them ' +
    'their any also just only each which what when how sure yes').split(/\s+/),
);

function mix(reply) {
  const words = reply.toLowerCase().match(/[a-z']+/g) ?? [];
  const tagalog = words.filter((w) => TAGALOG_WORDS.has(w)).length;
  const english = words.filter((w) => ENGLISH_WORDS.has(w)).length;
  const share = english + tagalog === 0 ? 0 : english / (english + tagalog);
  return { tagalog, english, share };
}

/** Is the reply in `want` ('taglish' | 'tagalog' | 'english'), and does it keep every fact? */
function langVerdict(last, want, facts) {
  const m = mix(last.reply);
  const inLanguage = {
    // Both grammars present, neither swamping the other. The target is about
    // half and half; the band is wide on purpose, because natural beats exact.
    // Two of each, not three: a one-sentence answer ("Yes po, the Overnight
    // slot is still open sa …") has only a handful of function words.
    taglish: m.tagalog >= 2 && m.english >= 2 && m.share >= 0.2 && m.share <= 0.8,
    // "Entirely in Tagalog", with room for the odd English word in a name.
    tagalog: m.tagalog >= 2 && m.share <= 0.12,
    english: m.tagalog <= 1,
  }[want];
  const refused = last.refused;
  const factsKept = facts.every((f) => last.reply.toLowerCase().includes(f.toLowerCase()));
  return {
    ok: inLanguage && factsKept && !refused,
    detail: `${want}? ${inLanguage} (tl ${m.tagalog}, en ${m.english}, en-share ${m.share.toFixed(2)}); facts ${factsKept ? 'kept' : `MISSING ${JSON.stringify(facts)}`}${refused ? '; REFUSED' : ''}`,
  };
}

console.log('='.repeat(78));
console.log('PROMPT EVAL:', label);
console.log('='.repeat(78));

// Tenants by slug. There is no default tenant to fall back on (D-027), so a
// missing one is an error, not a silently shorter battery.
const tenants = {};
for (const slug of ['northwind', 'villa', 'harbor']) {
  tenants[slug] = await loadTenant(slug);
  if (!tenants[slug]) throw new Error(`No "${slug}" tenant. All three must be loaded (plan.md Phase 2; harbor: plan/booking-types.md Phase 6).`);
}
// Every question below goes through tenants[slug], a CHAT token context,
// exactly as the chat route's does. So the battery runs under RLS (auth-rls
// Rule 3: same verdicts). Seeding the fixture is staff work, so it runs as
// villa's operator member on a staff token, through the same createBooking
// the admin route calls (§ 2.7). Removing it is cleanup, on the service client.
const villaAdmin = await asOperator(tenants.villa);
const harborAdmin = await asOperator(tenants.harbor);

// --- the villa bookings fixture ----------------------------------------------
const fixture = JSON.parse(readFileSync(new URL('../../../fixtures/villa-bookings.json', import.meta.url), 'utf8'));

/** Hard-delete every fixture booking. Cancelling would leave rows in villa's real history. */
async function removeFixture() {
  const { error } = await supabase
    .from('bookings')
    .delete()
    .eq('tenant_id', tenants.villa.id)
    .eq('notes', fixture.marker);
  if (error) throw new Error(`Could not remove the bookings fixture: ${error.message}`);
}

// --- the harbor bookings fixture (plan/booking-types.md Phase 6) ---------------
const harborFixture = JSON.parse(readFileSync(new URL('../../../fixtures/harbor-bookings.json', import.meta.url), 'utf8'));

async function removeHarborFixture() {
  const { error } = await supabase.from('bookings').delete().eq('tenant_id', tenants.harbor.id).eq('notes', harborFixture.marker);
  if (error) throw new Error(`Could not remove the harbor bookings fixture: ${error.message}`);
}

async function seedHarborFixture() {
  await removeHarborFixture();
  const [units, slots] = await Promise.all([listUnits(harborAdmin), listSlots(harborAdmin)]);
  for (const b of harborFixture.bookings) {
    const unit = units.find((u) => u.name === b.room && u.active);
    const slot = slots.find((s) => s.name === b.slot);
    if (!unit || !slot) throw new Error(`harbor has no active "${b.room}" or no "${b.slot}" — run plan/booking-types-phase6-harbor.mjs`);
    // createBookings, the admin route's path. A real booking on the same span
    // is a 409 here, which stops the battery loudly.
    await createBookings(harborAdmin, {
      rooms: [{ unitId: unit.id, guestCount: b.guestCount }],
      slotId: slot.id,
      date: plus(b.offsetDays),
      guestName: b.guestName,
      guestPhone: b.guestPhone,
      notes: harborFixture.marker,
    });
  }
  console.log(`fixture: ${harborFixture.bookings.length} harbor booking(s) seeded; booked ${H_BOOKED}, free ${H_FREE}, weekday ${H_WEEKDAY}`);
}

async function seedFixture() {
  await removeFixture(); // a crashed earlier run may have left one behind
  const [units, slots] = await Promise.all([listUnits(villaAdmin), listSlots(villaAdmin)]);
  for (const b of fixture.bookings) {
    const slot = slots.find((s) => s.name === b.slot);
    if (!slot) throw new Error(`villa has no slot "${b.slot}" — was schema-bookings.sql run?`);
    // createBooking, not a raw insert: the same path staff use. A real booking
    // on the same span is a 409 here, which stops the battery loudly rather
    // than letting the tool cases run against a calendar they did not expect.
    await createBooking(villaAdmin, {
      unitId: units[0].id,
      slotId: slot.id,
      date: plus(b.offsetDays),
      guestName: b.guestName,
      guestPhone: b.guestPhone,
      guestCount: b.guestCount,
      notes: fixture.marker,
    });
  }
  console.log(`fixture: ${fixture.bookings.length} villa booking(s) seeded; today ${TODAY}, booked ${BOOKED}, next ${NEXT}, free ${FREE}`);
  console.log();
}

// Count the ANSWER calls to OpenAI during a case, by reading the [openai] log
// lines. The rewriter's are labelled "rewrite", and do not count. tool-leak
// uses this to prove that northwind's refusal was the free short circuit, not
// a model call that happened to refuse.
const realLog = console.log;
let answerCalls = 0;
console.log = (...args) => {
  const line = String(args[0] ?? '');
  if (line.startsWith('[openai] chat:') || line.startsWith('[openai] stream:')) answerCalls++;
  realLog(...args);
};

/** Ask a sequence of turns in one conversation; return the last answer. */
async function ask(tenant, turns) {
  let conversationId = null;
  let last = null;
  for (const turn of turns) {
    last = await answerQuestion({ tenant, conversationId, message: turn });
    conversationId = last.conversationId;
  }
  return last;
}

const RUN = only ? CASES.filter((x) => x.id.startsWith(only)) : CASES;
let pass = 0;
let basePass = 0;
let langPass = 0;
let datePass = 0;
let roomPass = 0;
/** Five groups, counted apart, because each has its own baseline to match. */
const GROUP = (c) =>
  c.id.startsWith('tool-')
    ? 'tool'
    : c.id.startsWith('lang-')
      ? 'lang'
      : c.id.startsWith('date-')
        ? 'date'
        : c.id.startsWith('rt-')
          ? 'rooms'
          : 'original';
await seedFixture();
await seedHarborFixture();
try {
for (const c of RUN) {
  const tenant = tenants[c.tenant];
  let ok;
  let reply;
  answerCalls = 0;

  if (c.want === 'tool' || c.want === 'lang' || c.want === 'date' || c.want === 'rooms') {
    const last = await ask(tenant, c.turns);
    const verdict = c.check(last, { answerCalls });
    ok = verdict.ok;
    reply = `${last.reply.replace(/\n/g, ' ')}  || ${verdict.detail}`;
  } else if (c.want === 'no-transcript') {
    const other = await ask(tenants[c.transcriptOf.tenant], c.transcriptOf.turns);
    const own = await getMessages(tenants[c.transcriptOf.tenant], other.conversationId);
    const leaked = await getMessages(tenant, other.conversationId);
    // The owner must see its transcript, or "null" would prove nothing.
    ok = own?.length === 2 && leaked === null;
    reply = `owner sees ${own?.length ?? 'null'} messages; ${c.tenant} sees ${leaked === null ? 'null' : leaked.length}`;
  } else {
    const last = await ask(tenant, c.turns);
    const refused = last.refused;
    reply = last.reply.replace(/\n/g, ' ');

    // Refused, AND the visitor saw the friendly words, never the marker (D-047).
    if (c.want === 'refusal') ok = refused && last.reply.trim() !== NO_ANSWER;
    else if (c.want === 'greeting') {
      const others = Object.values(tenants).filter((t) => t.id !== tenant.id);
      ok =
        reply.includes(tenant.assistantName) &&
        reply.includes(tenant.businessName) &&
        others.every((t) => !reply.includes(t.assistantName) && !reply.includes(t.businessName));
    } else ok = !refused && (!c.expect || reply.toLowerCase().includes(c.expect.toLowerCase()));

    if (c.control) {
      const control = await ask(tenants[c.control.tenant], c.turns);
      const findable = control.reply.toLowerCase().includes(c.control.expect);
      ok = ok && findable;
      reply += `  || control (${c.control.tenant}): ${control.reply.replace(/\n/g, ' ').slice(0, 90)}`;
    }
  }
  if (ok) pass++;
  if (ok && GROUP(c) === 'original') basePass++;
  if (ok && GROUP(c) === 'lang') langPass++;
  if (ok && GROUP(c) === 'date') datePass++;
  if (ok && GROUP(c) === 'rooms') roomPass++;

  console.log(`${ok ? 'PASS' : 'FAIL'}  [${c.id}] ${c.tenant} want ${c.want}`);
  console.log(`      Q: ${c.turns?.[c.turns.length - 1] ?? '(transcript read)'}`);
  if (c.note) console.log(`      note: ${c.note}`);
  console.log(`      A: ${reply.slice(0, 360)}`);
  console.log();
}
} finally {
  await removeFixture();
  await removeHarborFixture();
}

// The ten cases that predate bookings, counted on their own, because their
// verdicts must match plan/baseline/eval-pre-bookings.txt one by one.
// Totals are over the cases that RAN, so a `--only` run cannot print a
// misleading "original 0/10".
const total = (g) => RUN.filter((c) => GROUP(c) === g).length;
console.log(
  `original ${basePass}/${total('original')} · tool ${pass - basePass - langPass - datePass - roomPass}/${total('tool')} · lang ${langPass}/${total('lang')} · date ${datePass}/${total('date')} · rooms ${roomPass}/${total('rooms')}`,
);
console.log(`${pass}/${RUN.length} as intended${only ? ` (only "${only}*")` : ''}`);
