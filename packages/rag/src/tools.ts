// tools.ts — the tools a tenant's chatbot may call, and the one place they run.
//
// A tool is TEXT to the model: a name, a description and a JSON Schema. It
// asks for a call by writing arguments, and this file runs the call and hands
// back a result, which is pasted into the conversation as text, the same move
// as pasting retrieved chunks into the prompt (architecture.md § 6). The model
// never touches the database.
//
// Three rules, from plan/bookings.md § 0:
//
//   - The tenant comes from the SERVER (Rule 2). No tool's schema has a
//     tenant, unit or booking id in it, so a prompt that says "check tenant 1"
//     has nowhere to put it.
//   - A result carries nothing the chat user may not see (Rule 3). The only
//     booking function called here is checkAvailability, whose result type
//     has no guest fields.
//   - Enablement is checked AGAIN at call time. Being offered a tool is not
//     proof the tenant has it. The executor trusts the database, not the
//     model's claim about what it was given.

import type { ToolCall, ToolDefinition } from '@rag/openai';
import {
  BookingInputError,
  bookingsConfig,
  checkAvailability,
  checkPricedAvailability,
  checkRoomAvailability,
  hasBookingPage,
  listRooms,
  listSlots,
  localDate,
  MAX_AVAILABILITY_DAYS,
} from '@rag/bookings';
import type { BookingsConfig, SlotSummary } from '@rag/bookings';
import { APPLICATIONS, enabledApplications } from './applications.js';
import type { ApplicationKey } from './applications.js';
import type { TenantContext, ToolCallRecord } from './types.js';

/**
 * What buildPrompt() needs in order to describe the tools: the instructions
 * for each tool, and the date the model should treat as today.
 *
 * The model has no clock. Without today's date, "this Saturday" resolves
 * against its training data (plan/bookings.md § 2.3). The date is the
 * TENANT'S, from its timezone, not the server's.
 */
export interface PromptTools {
  instructions: string[];
  today: string;
  weekday: string;
  timezone: string;
  /**
   * This turn's relative dates, already resolved ("bukas" means 2026-09-28),
   * from dates.ts (D-046). Filled per message in answer.ts, because this
   * function never sees the message. Absent or [] adds nothing.
   */
  dates?: string[];
}

export interface TenantTools {
  definitions: ToolDefinition[];
  /** Null when there are no tools, so buildPrompt adds nothing. */
  prompt: PromptTools | null;
}

const NO_TOOLS: TenantTools = { definitions: [], prompt: null };

/** "Thursday" for a YYYY-MM-DD. Formatted as UTC, because it is a calendar date, not an instant. */
function weekdayOf(date: string): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString('en-GB', { weekday: 'long', timeZone: 'UTC' });
}

/** "22:00:00" → "22 hours". Anything else is passed through as Postgres wrote it. */
function hoursOf(duration: string): string {
  const match = /^(\d{2}):00:00$/.exec(duration);
  return match ? `${Number(match[1])} hours` : duration;
}

/**
 * The tools this tenant's chatbot is offered on this turn.
 *
 * Built per request, not once at start-up. The slot names are the tenant's
 * own, read from the database, so the description says "Overnight (from
 * 14:00, 22 hours)" rather than making the model guess what the slots are
 * called.
 *
 * A tenant with no applications, like Northwind, gets NO_TOOLS. The answer
 * path then takes exactly the route it took before tools existed.
 */
export async function toolsFor(tenant: TenantContext): Promise<TenantTools> {
  const enabled = await enabledApplications(tenant);
  if (!enabled.includes('bookings')) return NO_TOOLS;

  const [config, slots] = await Promise.all([bookingsConfig(tenant), listSlots(tenant)]);
  if (!config) return NO_TOOLS;

  // A per_room tenant gets its own description and instructions, below. The
  // whole-resort branch that follows was byte-identical to before booking
  // types (plan/booking-types.md Rule 1) until D-074: a whole-resort tenant
  // whose unit HAS a rate (villa, since customer booking) now gets a price
  // in each row, a `guests` argument and three price lines, and its
  // baseline is plan/baseline/villa-*-post-villa-prices.txt. One with no
  // rate gets the tool exactly as it was.
  if (config.bookingType === 'per_room') return roomTools(tenant, config, slots);
  const priced = await hasBookingPage(tenant);

  const today = localDate(config.timezone);
  const slotList = slots.map((s) => `${s.name} (from ${s.startTime}, ${hoursOf(s.duration)})`).join('; ');

  const checkAvailabilityTool: ToolDefinition = {
    type: 'function',
    function: {
      name: 'check_availability',
      description:
        `Check whether ${tenant.businessName}'s booking slots are open or taken${priced ? ', and what each costs' : ''}, for one date or a range of dates. ` +
        `The slots are: ${slotList}. A slot that runs past midnight can make the next day's slots taken. ` +
        `Dates are YYYY-MM-DD in ${config.timezone}. A range is at most ${MAX_AVAILABILITY_DAYS} days. ` +
        'Returns one row per date and slot, each "open" or "taken".' +
        (priced
          ? ` Each row also carries the slot's price for that date in ${config.currency}, how many guests that price includes, ` +
            'and the fee per guest above that, up to the most the property holds. Pass guests to get the total for that party.'
          : ''),
      parameters: {
        type: 'object',
        properties: {
          date_from: { type: 'string', description: 'The first date to check, YYYY-MM-DD.' },
          date_to: { type: 'string', description: 'The last date to check, YYYY-MM-DD. Omit it to check one date.' },
          ...(priced
            ? {
                guests: {
                  type: 'integer',
                  minimum: 1,
                  description: 'How many guests will come, when the user says. Each row then carries the total for that many guests.',
                },
              }
            : {}),
        },
        required: ['date_from'],
        additionalProperties: false,
      },
    },
  };

  return {
    definitions: [checkAvailabilityTool],
    prompt: {
      // Each sentence below answers a failure the battery MEASURED, not one
      // imagined. Change one, and re-run `pnpm eval` (CLAUDE.md rule 1).
      instructions: [
        'For whether a date or slot is open, ALWAYS call check_availability; the',
        'documents cannot know. Never state availability without a tool result',
        'from this turn.',
        // Phase 5: "the villa is available" when only Overnight was open.
        // Phase 6 (tool-partial): "the following slots are available:" above
        // a list with two taken slots in it.
        // The first wording of both rules below was a prohibition ("never
        // introduce a list as available", "do not add the I-don't-know
        // sentence"), and the battery showed gpt-4o-mini ignoring both. The
        // same shape as D-017: this model follows a concrete instruction
        // about what TO write better than a rule about what not to.
        // Then the fix above made replies bare "Open: … / Taken: …" lines with
        // no date in them, so the reader could not tell which day they were
        // about. Hence the first sentence, which names the date, and is again
        // an example of what to write, not a rule against what not to.
        //
        // SCOPED to availability answers, on purpose. The first version said
        // "Start with one sentence that answers the question and names the
        // date" for EVERY answer. leak-2's villa control ("What is
        // amihanpansol2019?", a Wi-Fi question with the chunk retrieved) then
        // refused in 2 runs of 3, where the previous wording answered 3 of 3.
        // A question with no date in it could not satisfy the instruction, so
        // the model fell back on the refusal. A tools-block sentence can
        // cost a documents answer.
        'When you answer about availability, start with one sentence that',
        'answers the question and names the date, for example "Yes, the',
        'Overnight slot is open on 8 October 2026." Then, for each date, write',
        'two lines: "Open:" followed by the open slots and "Taken:" followed by',
        'the taken ones. Never say a whole day is free unless every slot on it',
        'is open.',
        // Phase 6 (tool-ask): "I don't know based on the documents I have.
        // Please provide a specific date…", the refusal glued to the question.
        // D-046 tried "without giving any date or day at all" here. It did not
        // fix the relative-date case (the up-front check in answer.ts did),
        // and lang-tagalog-2 failed in 4 of 9 runs with it, 1 of 6 without; so it is
        // back to the wording the battery was measured with.
        'If the user asks about availability without giving a date, your whole',
        'reply is one question asking which date they mean. Call the tool once',
        'they give one.',
        // Phase 6 (tool-past): the tool said the date was in the past, and the
        // model answered with the bare refusal instead of saying so.
        'If a tool result has an "error", tell the user what it says, for',
        'example that the date is in the past. A tool error is an answer to',
        'pass on, not a reason to reply "I don\'t know".',
        ...(priced ? PRICE_LINES : []),
      ],
      today,
      weekday: weekdayOf(today),
      timezone: config.timezone,
    },
  };
}

/**
 * The price lines for a whole-resort tenant whose unit has a rate (D-074).
 * The same three rules harbor's block has, in villa's slot vocabulary, and
 * in the shape the battery measured to work: what TO write, with an example
 * (D-017). Each answers a case: price-villa and price-villa-tl (R-23, a rate
 * from the documents or memory), price-villa-guests (R-37, a total the model
 * adds up), lang-tagalog (a price asked with no date).
 */
const PRICE_LINES = [
  'For what a slot costs on a date, ALWAYS call check_availability; the',
  'documents do not hold the rates. Quote a price only from the tool result,',
  "never from the documents or from memory. Write each open slot's price",
  'after it, for example "Open: Overnight ₱16,000.00; Day Tour ₱9,500.00".',
  'If the user says how many guests, pass it as guests, and quote the',
  '"total" from the result, naming the extra guest charge, for example',
  '"Overnight (32 guests): ₱16,000.00 + ₱500.00 for 2 extra guests =',
  '₱16,500.00". Never add up a total yourself.',
  'If the user asks a price without giving a date, your whole reply is one',
  'question asking which date they mean, because the rate depends on it.',
];

/** 350000 centavos → "₱3,500.00". The model reads prices as a person would, never as raw centavos. */
function money(centavos: number, currency: string): string {
  return new Intl.NumberFormat('en-PH', { style: 'currency', currency }).format(centavos / 100);
}

/**
 * The tools of a per_room tenant (plan/booking-types.md Phase 6).
 *
 * The SAME tool name, check_availability, and the same date arguments, so the
 * registry, D-046's up-front check for a resolved date, and the chat's
 * "Checked availability" panel all work unchanged. What differs is what it
 * checks (rooms, via check_room_availability) and what a row carries: the
 * room, how many guests it holds, and its price for that date. Three optional
 * arguments narrow it, because rooms × slots × days grows fast (§ 2.6).
 *
 * The room names and capacities go into the description, as the slot names
 * do, so the model can match "the Garden Room" to a name the tool accepts.
 * A NAME, not an id (plan/bookings.md Rule 2). Descriptions stay out: they
 * are tenant free text (Rule 4).
 */
async function roomTools(tenant: TenantContext, config: BookingsConfig, slots: SlotSummary[]): Promise<TenantTools> {
  const today = localDate(config.timezone);
  const rooms = await listRooms(tenant);
  const slotList = slots.map((s) => `${s.name} (from ${s.startTime}, ${hoursOf(s.duration)})`).join('; ');
  const roomList = rooms.map((r) => (r.capacity === null ? r.name : `${r.name} (up to ${r.capacity} guests)`)).join('; ');

  const tool: ToolDefinition = {
    type: 'function',
    function: {
      name: 'check_availability',
      description:
        `Check which of ${tenant.businessName}'s rooms are open or taken, and what each costs, for one date or a range of dates. ` +
        `The rooms are: ${roomList || '(none yet)'}. The booking periods are: ${slotList}. ` +
        `Dates are YYYY-MM-DD in ${config.timezone}. A range is at most ${MAX_AVAILABILITY_DAYS} days. ` +
        'Returns one row per date, room and period: the room, how many guests it holds, "open" or "taken", ' +
        "and the room's base price for that date in " +
        `${config.currency}. The base price covers the room's included guests; each guest above that adds the room's ` +
        'extra guest fee, up to the most it holds. Pass guests to get the total for that party.',
      parameters: {
        type: 'object',
        properties: {
          date_from: { type: 'string', description: 'The first date to check, YYYY-MM-DD.' },
          date_to: { type: 'string', description: 'The last date to check, YYYY-MM-DD. Omit it to check one date.' },
          slot: {
            type: 'string',
            enum: slots.map((s) => s.name),
            description: 'Only this booking period. Omit it for every period.',
          },
          room: {
            type: 'string',
            enum: rooms.map((r) => r.name),
            description: 'Only this room, when the user names one. Omit it for every room.',
          },
          guests: {
            type: 'integer',
            minimum: 1,
            description:
              'How many guests will stay, when the user says. Only rooms that hold that many are returned, each with its total for that many guests.',
          },
        },
        required: ['date_from'],
        additionalProperties: false,
      },
    },
  };

  return {
    definitions: [tool],
    prompt: {
      // Written for rooms, in the shape the villa lines were MEASURED to work
      // in: say what TO write, with an example, rather than what not to
      // (D-017, plan/bookings.md Phase 6). Each line answers an rt-* case.
      // Change one, and re-run `pnpm eval` (CLAUDE.md rule 1).
      instructions: [
        // rt-list, rt-taken, and R-23 (a price from memory).
        'For which rooms are open, how many guests a room holds, or what a room',
        'costs on a date, ALWAYS call check_availability; the documents cannot',
        'know. Never state availability or a room price without a tool result',
        'from this turn.',
        // rt-list, rt-guests: open rooms first, each with capacity and price.
        'When you answer about rooms, start with one sentence that names the',
        'date. Then list each open room on its own line with how many guests it',
        'holds and its price, for example "Garden Room (up to 2 guests):',
        '₱3,500.00". Then one line "Taken:" with the taken rooms, if any.',
        // rt-price, rt-mix (plan § 2.7): the documents may hold an old or a
        // whole-venue rate.
        "Quote a room's price only from the tool result, never from the",
        'documents. The tool gives the base rate for that date.',
        // rt-guests, and plan/extra-guests.md (rt-extra, rt-standard, R-37):
        // the total is the TOOL's, never one the model adds up.
        'If the user says how many guests, pass it as guests, and quote each',
        'room\'s "total" from the result, naming its extra guest charge, for',
        'example "Loft (3 guests): ₱4,800.00 + ₱250.00 for 1 extra guest =',
        '₱5,050.00". Never add up a total yourself.',
        // rt-over: a room too small for the party is not in the result.
        'A room that holds fewer guests than asked is not in the result; say',
        'it holds fewer, and offer the rooms that are.',
        // rt-ask, the same rule as villa's.
        'If the user asks about rooms without giving a date, your whole reply is',
        'one question asking which date they mean. Call the tool once they give',
        'one.',
        // tool-past, for rooms.
        'If a tool result has an "error", tell the user what it says, for',
        'example that the date is in the past. A tool error is an answer to',
        'pass on, not a reason to reply "I don\'t know".',
      ],
      today,
      weekday: weekdayOf(today),
      timezone: config.timezone,
    },
  };
}

/** Which application owns a tool name, according to the registry. */
function ownerOf(toolName: string): ApplicationKey | null {
  for (const [key, app] of Object.entries(APPLICATIONS) as [ApplicationKey, (typeof APPLICATIONS)[ApplicationKey]][]) {
    if ((app.tools as readonly string[]).includes(toolName)) return key;
  }
  return null;
}

export interface ToolExecution {
  record: ToolCallRecord;
  /** The tool message's content: the result as JSON text, which is what the model reads. */
  content: string;
}

/**
 * Run one tool call for this tenant.
 *
 * Failures the MODEL can fix come back as a result, `{ "error": "…" }`, so it
 * can ask the user for a proper date:
 *
 *   - arguments that are not valid JSON;
 *   - a tool the tenant does not have, or that does not exist;
 *   - a BookingInputError (a date in the past, an impossible date, a range
 *     over the limit), whose message names what is wrong.
 *
 * Every OTHER error propagates: a database failure, a network error. Those are
 * not the model's to fix, and turning them into a tool result would let the
 * model paper over an outage with a confident sentence (architecture.md § 9).
 */
export async function executeTool(tenant: TenantContext, call: ToolCall): Promise<ToolExecution> {
  let args: Record<string, unknown> | null = null;
  const done = (result: unknown): ToolExecution => {
    console.log(`[tool] ${tenant.slug} ${call.name} ${call.arguments} -> ${summarise(result)}`);
    return { record: { name: call.name, args, result }, content: JSON.stringify(result) };
  };

  try {
    const parsed: unknown = JSON.parse(call.arguments);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      args = parsed as Record<string, unknown>;
    }
  } catch {
    // Handled below: args stays null.
  }
  if (args === null) return done({ error: `The arguments were not a JSON object: ${call.arguments}` });

  // Checked again here, against the database, whatever the model was offered.
  const owner = ownerOf(call.name);
  if (owner === null || !(await enabledApplications(tenant)).includes(owner)) {
    return done({ error: `There is no tool named "${call.name}".` });
  }

  if (call.name === 'check_availability') {
    try {
      // Which branch is decided HERE, from the database, not from which tool
      // text the model happened to be given (the enablement rule above).
      const config = await bookingsConfig(tenant);
      // D-074: a whole-resort tenant with a rate is priced the same way, from
      // the same function; its tool has no slot or room argument to pass.
      const perRoom = config?.bookingType === 'per_room';
      if (config && (perRoom || (await hasBookingPage(tenant)))) {
        const query = { from: args.date_from, to: args.date_to, slot: args.slot, unit: args.room, guests: args.guests };
        const rooms = perRoom ? await checkRoomAvailability(tenant, query) : await checkPricedAvailability(tenant, query);
        // Mapped field by field (Rule 3): the price becomes text a person
        // reads, and nothing else is added.
        // plan/extra-guests.md: what the base price covers, the fee per guest
        // above it, and, only when the guests are known, that party's extra
        // charge and total, all from unit_quote(). Without a guest count there
        // is no total to give, so none is given: the model is not handed a
        // number it could mistake for the party's price.
        const guests = args.guests !== undefined && args.guests !== null;
        return done({
          ...closedNote(rooms),
          slots: rooms.map((r) => ({
            date: r.date,
            unit: r.unit,
            capacity: r.capacity,
            included_guests: r.standardCapacity,
            extra_guest_fee: r.extraPersonRate === null ? null : money(r.extraPersonRate, config.currency),
            slot: r.slot,
            status: r.status,
            price: money(r.price, config.currency),
            ...(guests ? { extra_guest_charge: money(r.extraGuestPrice, config.currency), total: money(r.total, config.currency) } : {}),
          })),
        });
      }
      const slots = await checkAvailability(tenant, { from: args.date_from, to: args.date_to });
      return done({ ...closedNote(slots), slots });
    } catch (error) {
      if (error instanceof BookingInputError) return done({ error: error.message });
      throw error;
    }
  }

  // A name in the registry with no branch here is a code bug, not a model mistake.
  throw new Error(`Tool "${call.name}" is registered to ${owner} but has no executor`);
}

/**
 * Closed dates (D-080), said in the RESULT, and only when there are some.
 * The tool's description and instructions are unchanged on purpose: adding
 * "closed" there moved rt-leak-2 from 3 of 4 to 0 of 6 (the model began
 * calling a harbor room "part of the whole property"). Here it reaches the
 * model only when a row IS closed, which no battery case asks about. Without
 * it, the model listed a closed date's slots under "Taken:" (3 of 3).
 *
 * Dates only. The label staff typed is tenant-written free text, and does
 * not go into a prompt (Rule 3).
 */
function closedNote(rows: { date: string; status: string }[]): { closed?: { dates: string[]; meaning: string } } {
  const dates = [...new Set(rows.filter((r) => r.status === 'closed').map((r) => r.date))];
  if (dates.length === 0) return {};
  return {
    closed: {
      dates,
      meaning:
        'The business is closed on these dates, so nothing can be booked on them. Say that it is closed on that date, ' +
        'not that the slots are taken, and offer to check another date.',
    },
  };
}

/** One line for the log: "3 slots, 1 open" or "error: …". */
function summarise(result: unknown): string {
  const r = result as { slots?: { status: string }[]; error?: string };
  if (r.error) return `error: ${r.error}`;
  if (r.slots) return `${r.slots.length} slots, ${r.slots.filter((s) => s.status === 'open').length} open`;
  return JSON.stringify(result);
}
