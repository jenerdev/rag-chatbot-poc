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
  listSlots,
  localDate,
  MAX_AVAILABILITY_DAYS,
} from '@rag/bookings';
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

  const today = localDate(config.timezone);
  const slotList = slots.map((s) => `${s.name} (from ${s.startTime}, ${hoursOf(s.duration)})`).join('; ');

  const checkAvailabilityTool: ToolDefinition = {
    type: 'function',
    function: {
      name: 'check_availability',
      description:
        `Check whether ${tenant.businessName}'s booking slots are open or taken, for one date or a range of dates. ` +
        `The slots are: ${slotList}. A slot that runs past midnight can make the next day's slots taken. ` +
        `Dates are YYYY-MM-DD in ${config.timezone}. A range is at most ${MAX_AVAILABILITY_DAYS} days. ` +
        'Returns one row per date and slot, each "open" or "taken".',
      parameters: {
        type: 'object',
        properties: {
          date_from: { type: 'string', description: 'The first date to check, YYYY-MM-DD.' },
          date_to: { type: 'string', description: 'The last date to check, YYYY-MM-DD. Omit it to check one date.' },
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
        'If the user asks about availability without giving a date, your whole',
        'reply is one question asking which date they mean. Call the tool once',
        'they give one.',
        // Phase 6 (tool-past): the tool said the date was in the past, and the
        // model answered with the bare refusal instead of saying so.
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
      const slots = await checkAvailability(tenant, { from: args.date_from, to: args.date_to });
      return done({ slots });
    } catch (error) {
      if (error instanceof BookingInputError) return done({ error: error.message });
      throw error;
    }
  }

  // A name in the registry with no branch here is a code bug, not a model mistake.
  throw new Error(`Tool "${call.name}" is registered to ${owner} but has no executor`);
}

/** One line for the log: "3 slots, 1 open" or "error: …". */
function summarise(result: unknown): string {
  const r = result as { slots?: { status: string }[]; error?: string };
  if (r.error) return `error: ${r.error}`;
  if (r.slots) return `${r.slots.length} slots, ${r.slots.filter((s) => s.status === 'open').length} open`;
  return JSON.stringify(result);
}
