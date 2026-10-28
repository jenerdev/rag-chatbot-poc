import { z } from 'zod';
import { MAX_WELCOME_TEXT_LENGTH } from './welcome-text';
import { MAX_CONTENT_LENGTH, MAX_MESSAGE_LENGTH } from './limits';

// Validation at the route boundary (CLAUDE.md § Conventions): validate here,
// throw in the pipeline, map errors to status codes in one place.
//
// zod rather than the POC's hand-written `typeof` ladders. That ladder was the
// right call for a three-dependency learning build; with two clients, a
// streaming route and types to keep honest, a schema that produces the parsed
// TYPE as well as the check is worth one dependency. Logged as D-022.
//
// ⚠️ The MESSAGES ARE PART OF THE CONTRACT. The admin page renders whatever
// string comes back in `error`, so these are the POC's wordings character for
// character — including the counts, which tell a user pasting a long document
// how much they need to cut rather than just that it was too much.
//
// zod 4 (T-013, 2026-10-28; zod 3 had no fix for GHSA-mrhx-c7xc-m3w5). zod 3's
// `required_error` / `invalid_type_error` / `errorMap` are gone; these two
// helpers say the same thing, and `v3Words` (below) keeps zod 3's default
// wording for every issue no schema here names a message for. A 32,673-input
// corpus answered identically on both versions (whats-done.md, 2026-10-28).

/** zod 3's name for a value's type ("Expected string, received number"). */
function v3Type(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isNaN(value) ? 'nan' : 'number';
  return typeof value;
}

const quoted = (values: readonly unknown[], sep: string) =>
  values.map((v) => (typeof v === 'string' ? `'${v}'` : String(v))).join(sep);

/**
 * zod 3's default messages, for the issues no schema here words itself: a
 * client sending the wrong type, an unknown key, a bound with no message.
 * Lowest precedence in zod 4 (a schema's or a check's own words win).
 */
type V3Issue = {
  code?: string; input?: unknown; expected?: string; origin?: string; format?: string;
  minimum?: unknown; maximum?: unknown; inclusive?: boolean; exact?: boolean;
  keys?: string[]; values?: readonly unknown[]; inst?: unknown;
};
function v3Words(issue: V3Issue): string | undefined {
  const bound = (v: unknown) => String(v);
  switch (issue.code) {
    case 'invalid_type':
      if (issue.input === undefined) return 'Required';
      if (issue.expected === 'int') return 'Expected integer, received float';
      return `Expected ${issue.expected === 'record' ? 'object' : issue.expected}, received ${v3Type(issue.input)}`;
    case 'unrecognized_keys':
      return `Unrecognized key(s) in object: ${quoted(issue.keys ?? [], ', ')}`;
    case 'too_small': {
      const how = issue.exact ? 'exactly' : issue.inclusive ? 'at least' : 'more than';
      if (issue.origin === 'array') return `Array must contain ${how} ${bound(issue.minimum)} element(s)`;
      if (issue.origin === 'string') return `String must contain ${issue.exact ? 'exactly' : issue.inclusive ? 'at least' : 'over'} ${bound(issue.minimum)} character(s)`;
      return `Number must be ${issue.exact ? 'exactly equal to ' : issue.inclusive ? 'greater than or equal to ' : 'greater than '}${bound(issue.minimum)}`;
    }
    case 'too_big': {
      if (issue.origin === 'array') return `Array must contain ${issue.exact ? 'exactly' : issue.inclusive ? 'at most' : 'less than'} ${bound(issue.maximum)} element(s)`;
      if (issue.origin === 'string') return `String must contain ${issue.exact ? 'exactly' : issue.inclusive ? 'at most' : 'under'} ${bound(issue.maximum)} character(s)`;
      return `Number must be ${issue.exact ? 'exactly' : issue.inclusive ? 'less than or equal to' : 'less than'} ${bound(issue.maximum)}`;
    }
    case 'invalid_value': {
      const kind = (issue.inst as { _zod?: { def?: { type?: string } } } | undefined)?._zod?.def?.type;
      const values = issue.values ?? [];
      if (kind === 'literal') return `Invalid literal value, expected ${JSON.stringify(values[0])}`;
      return `Invalid enum value. Expected ${quoted(values, ' | ')}, received ${typeof issue.input === 'string' ? `'${issue.input}'` : String(issue.input)}`;
    }
    case 'invalid_format':
      if (issue.format === 'email' || issue.format === 'url' || issue.format === 'uuid') return `Invalid ${issue.format}`;
      return 'Invalid';
    case 'invalid_union':
    case 'custom':
      return 'Invalid input';
    default:
      return undefined;
  }
}
z.config({ customError: v3Words });

/** zod 3's `{ required_error, invalid_type_error }`: missing says `required`, the wrong type `invalid`; undefined = the default words. */
function typeError(required?: string, invalid?: string) {
  return {
    error: (issue: { code?: string; input?: unknown }) =>
      issue.code !== 'invalid_type' ? undefined : issue.input === undefined ? required : invalid,
  };
}

/** zod 3's `.refine(check, (value) => ({ message }))`: the message is built from the value that failed. */
function failedWith(words: (value: string) => string) {
  return { error: (issue: { input?: unknown }) => words(String(issue.input)) };
}

export const createDocumentSchema = z.object({
  title: z
    .string(typeError('A title is required', 'A title is required'))
    .trim()
    .min(1, 'A title is required'),
  source: z
    .string()
    .trim()
    .optional()
    .nullable()
    // An empty or whitespace-only source is stored as NULL, not as ''.
    .transform((value) => (value === undefined || value === '' ? null : value)),
  content: z
    .string(typeError('Document content is required', 'Document content is required'))
    .min(1, 'Document content is required')
    .refine((value) => value.trim() !== '', 'Document content is required')
    .refine(
      (value) => value.length <= MAX_CONTENT_LENGTH,
      failedWith((value) => `Document is ${value.length} characters; the limit is ${MAX_CONTENT_LENGTH}`),
    ),
});

/** POST voice/speak (D-134): a conversation, never text (plan/voice.md Rule 2). */
export const voiceSpeakSchema = z.object({
  conversationId: z.string(typeError('A conversation is required', 'A conversation is required')).uuid('That is not a conversation'),
});

export const chatSchema = z.object({
  // A uuid from a previous reply, or absent on the first message of a session.
  // Anything else is a client bug worth surfacing rather than ignoring.
  conversationId: z
    .string(typeError(undefined, 'conversationId must be a string'))
    .nullish()
    .transform((value) => value || null),
  message: z
    .string(typeError('A message is required', 'A message is required'))
    .min(1, 'A message is required')
    .refine((value) => value.trim() !== '', 'A message is required')
    .refine(
      (value) => value.length <= MAX_MESSAGE_LENGTH,
      failedWith((value) => `Question is ${value.length} characters; the limit is ${MAX_MESSAGE_LENGTH}`),
    ),
});

const email = z
  .string(typeError('An email is required', 'An email is required'))
  .trim()
  .min(1, 'An email is required')
  .max(320, 'That is not an email address')
  .email('That is not an email address');

// Supabase Auth's minimum is 6 by default. The cap stops a megabyte
// "password" from reaching Supabase at all.
const password = z
  .string(typeError('A password is required', 'A password is required'))
  .min(1, 'A password is required')
  .max(256, 'That password is too long');

/** A staff login (auth-rls Phase 5). Checked by Supabase Auth, then against `memberships`. */
export const adminLoginSchema = z.object({ email, password });

/** "Forgot password?" The same answer whether or not the email has an account. */
export const passwordResetSchema = z.object({ email });

/** A new password, with the access token from the reset (or invite) link. */
export const setPasswordSchema = z.object({
  accessToken: z
    .string(typeError('The reset link is incomplete', 'The reset link is incomplete'))
    .min(1, 'The reset link is incomplete')
    .max(8192, 'The reset link is not valid'),
  password: password.min(8, 'Use at least 8 characters'),
});

/**
 * A new room. Lengths and "positive" are @rag/bookings' to check, and so are
 * the defaults for anything left out (standard 2, maximum 4, ₱250;
 * plan/extra-guests.md). `maxCapacity` and `capacity` are the same thing.
 * The rate is CENTAVOS, like every price.
 */
export const createAccommodationSchema = z.object({
  name: z.string(typeError('A room name is required', 'A room name is required')),
  description: z.string(typeError(undefined, 'Description must be text')).nullish(),
  capacity: z.number(typeError(undefined, 'Maximum guests must be a number')).nullish(),
  maxCapacity: z.number(typeError(undefined, 'Maximum guests must be a number')).nullish(),
  standardCapacity: z.number(typeError(undefined, 'Standard guests must be a number')).nullish(),
  extraPersonRate: z.number(typeError(undefined, 'The extra guest rate must be a number')).nullish(),
  sortOrder: z.number(typeError(undefined, 'Order must be a number')).optional(),
});

/** A change to a room: any subset, including `active: false` to retire it. */
export const updateAccommodationSchema = createAccommodationSchema.partial().extend({
  active: z.boolean(typeError(undefined, 'Active must be true or false')).optional(),
});

/** A room's rates, in CENTAVOS, one entry per slot being set. */
export const setRatesSchema = z.object({
  rates: z.array(
    z.object({
      slotId: z.number(typeError('A slot is required', 'A slot is required')),
      weekdayPrice: z.number(typeError('A weekday price is required', 'A weekday price is required')),
      weekendPrice: z.number(typeError('A weekend price is required', 'A weekend price is required')),
      // Optional (customer booking § 2.3): null = the weekend price on a
      // holiday. All rates or none is @rag/bookings' rule (setRates).
      holidayPrice: z.number(typeError(undefined, 'A holiday price must be a number')).nullish(),
    }),
    typeError('Rates are required', 'Rates must be a list'),
  )
    // GHSA-mrhx-c7xc-m3w5: a cap is what lets zod 4 refuse a huge list before
    // it parses one element. One rate per slot; no tenant has near 100 slots.
    .max(100, 'Send at most 100 rates at once.'),
});

/**
 * Move a photo: `{ move: -1 }` (left) or `{ move: 1 }` (right), which the
 * screen sends, or `{ sortOrder }` for a direct place. One of the two.
 */
export const imageOrderSchema = z
  .object({
    // The union's own `error`, not a type error: a union reports its own
    // "invalid_union" issue, which a type error never reaches (code review,
    // 2026-09-28; zod 3's errorMap, zod 4's error).
    move: z.union([z.literal(-1), z.literal(1)], { error: 'move is -1 or 1' }).optional(),
    sortOrder: z.number(typeError(undefined, 'Order must be a number')).optional(),
  })
  .refine((v) => (v.move === undefined) !== (v.sortOrder === undefined), { message: 'Send either move or sortOrder' });

// --- customer booking (plan/customer-booking.md) ------------------------------
// Types only, as above: every rule (dates, nights, phone and email shape,
// limits) is @rag/bookings' parseRequest() and, behind it, the SQL function
// request_booking(). No price and no status field exist to send: zod strips
// unknown keys, and the function would not take them anyway.

const requestRoom = z.object({
  unitId: z.number(typeError('Choose what to book', 'Choose what to book')),
  guests: z.number(typeError('Enter the number of guests', 'Enter the number of guests')),
  /** D-147: the children who stay free, counted apart from `guests`; absent = 0. The bound (0 to 50) is parseRequest()'s and request_booking()'s. */
  free: z.number(typeError(undefined, 'Free guests must be a number')).nullish(),
});

/** A price for a stay, before sending it. */
export const bookQuoteSchema = z.object({
  slotId: z.number(typeError('Choose a booking slot', 'Choose a booking slot')),
  // The cap (GHSA-mrhx-c7xc-m3w5: zod 4 refuses an over-long list before it
  // parses an element) is MAX_UNITS_PER_BOOKING, in parseRequest()'s own
  // words; this file reaches the browser, so it cannot import @rag/bookings.
  rooms: z.array(requestRoom, typeError('Choose what to book', 'Choose what to book')).max(10, 'One request holds at most 10 rooms.'),
  checkIn: z.string(typeError('Choose a date', 'Choose a date')),
  nights: z.number(typeError(undefined, 'Nights must be a number')).optional(),
  /**
   * D-097: a promo code the customer typed. Shape only (the database's
   * code shape); whether it exists, covers the dates or has uses left is
   * promo_for_request()'s answer, in words, on the quote.
   */
  promoCode: z.string(typeError(undefined, 'The promo code must be text')).max(32, 'That is not a promo code').nullish(),
});

/**
 * A customer's booking request. `website` is a honeypot: a field the page
 * hides from people, so only a form-filling bot fills it (plan § 2.1).
 */
export const bookRequestSchema = bookQuoteSchema.extend({
  name: z.string(typeError('Your name is required', 'Your name is required')),
  phone: z.string(typeError('Your mobile number is required', 'Your mobile number is required')),
  email: z.string(typeError('Your email is required', 'Your email is required')),
  notes: z.string(typeError(undefined, 'Notes must be text')).nullish(),
  website: z.string().optional(),
  /** D-129: the box ticked, and the version of the policy it was ticked for. Postgres checks the version is current. */
  consent: z.literal(true, { error: 'Please read and agree to the Privacy Policy and Terms.' }),
  consentVersion: z.string(typeError('Please read and agree to the Privacy Policy and Terms.')).min(1).max(20),
});

/**
 * A price for a stay on the staff form (D-111): the booking page's quote
 * with the promo the staff member PICKED instead of a typed code. Types
 * only; every rule is parseRequest()'s, the page's own.
 */
export const staffQuoteSchema = bookQuoteSchema.omit({ promoCode: true }).extend({
  /** D-097: a promo the staff member picked; the trigger checks it and stores the discount */
  promoId: z.number(typeError(undefined, 'Promo must be a number')).nullish(),
});

/**
 * A stay booked by staff (D-111): the booking page's fields (name, mobile AND
 * email, check-in, nights, guests per unit), the picked promo, and Walk in.
 * No `status` (D-095: born pending; zod strips the key) and no `price`
 * (the trigger's, plan Rule 2).
 */
export const staffStaySchema = staffQuoteSchema.extend({
  name: z.string(typeError("The guest's name is required", "The guest's name is required")),
  phone: z.string(typeError("The guest's mobile number is required", "The guest's mobile number is required")),
  email: z.string(typeError("The guest's email is required", "The guest's email is required")),
  notes: z.string(typeError(undefined, 'Notes must be text')).nullish(),
  walkIn: z.boolean(typeError(undefined, 'Walk in is true or false')).optional(),
});

/**
 * The Manage booking lookup (plan/manage-booking.md Phase 2): a reference
 * and the email or mobile number the guest booked with. POST, so neither
 * reaches a URL or a log. guest_stay() normalises and decides; this only
 * refuses what is not text.
 */
export const manageLookupSchema = z.object({
  reference: z.string(typeError('Your booking reference is required', 'Your booking reference is required')),
  contact: z.string(typeError('Your email or mobile number is required', 'Your email or mobile number is required')),
});

/**
 * S-14 (plan/manage-booking.md Phase 4): verify or reject one proof. The
 * amount is pesos as typed, parsed by string (lib/money.ts); review_payment()
 * decides the rest in words (the range, "I checked the account", a reason).
 */
export const reviewPaymentSchema = z.object({
  action: z.enum(['verify', 'reject'], { error: 'The action is "verify" or "reject".' }),
  amount: z.string(typeError(undefined, 'The amount must be text, like 1500 or 1,500.00')).nullish(),
  accountChecked: z.boolean(typeError(undefined, '"I checked the account" is true or false')).optional(),
  note: z.string(typeError(undefined, 'The note must be text.')).max(500, 'The note is too long (500 characters at most).').nullish(),
  confirm: z.boolean(typeError(undefined, '"confirm" is true or false')).optional(),
});

/** A refund made elsewhere, recorded (record_refund() checks it against what was received). */
export const recordRefundSchema = z.object({
  groupId: z.string(typeError('Which booking?', 'Which booking?')),
  amount: z.string(typeError('The amount refunded is required', 'The amount must be text, like 1500')),
  method: z.string(typeError('How was it returned?', 'How was it returned?')),
  note: z.string(typeError('A note is required', 'The note must be text.')),
});

const payMethod = z.object({
  kind: z.enum(['gcash', 'bank', 'other'], { error: 'A way to pay is GCash, bank or other.' }),
  label: z.string(typeError('Each way to pay needs a label', 'Each way to pay needs a label')),
  accountName: z.string().nullish(),
  accountNumber: z.string().nullish(),
  instructions: z.string().nullish(),
});

/** The Settings tab: the whole `payments` setting, or null to turn payments off. The SQL validator decides the limits. */
export const paymentSettingsSchema = z.object({
  settings: z
    .object({
      // The SQL validator's bound and words (schema-manage-booking.sql); a cap lets zod 4 refuse before parsing (GHSA-mrhx-c7xc-m3w5).
      methods: z.array(payMethod).max(5, 'config.payments.methods is a list of 1 to 5 ways to pay'),
      fee: z.union([
        z.object({ kind: z.literal('full') }),
        z.object({ kind: z.enum(['fixed', 'percent']), value: z.number(typeError(undefined, 'The fee is a number')) }),
      ]),
      payWithinHours: z.number().nullable(),
      reviewWithinHours: z.number().nullable(),
      terms: z.string().nullable(),
      // Absent = "none", so a caller written before Phase 5 keeps today's rule.
      hold: z.enum(['none', 'on_proof', 'on_request'], { error: 'The hold is "none", "on_proof" or "on_request".' }).default('none'),
      // Phase 6; absent = no refund tiers, no rescheduling on the page.
      cancellation: z
        .array(z.object({ daysBefore: z.number(), refundPercent: z.number() }))
        .max(5, 'config.payments.cancellation is up to 5 tiers of {"days_before": 0–365, "refund_percent": 0–100}, whole numbers')
        .default([]),
      rescheduleUntilDaysBefore: z.number().nullable().default(null),
    })
    .nullable(),
});

/** Phase 6: a guest's change request (or its quote, `dryRun`). request_change() decides the rest. */
export const changeRequestSchema = manageLookupSchema.extend({
  kind: z.enum(['cancel', 'reschedule'], { error: 'A change is "cancel" or "reschedule".' }),
  newCheckIn: z.string().nullish(),
  reason: z.string().max(500, 'The reason is too long (500 characters at most).').nullish(),
  dryRun: z.boolean().optional(),
});

/** Phase 6: staff decide a change request. */
export const decideChangeSchema = z.object({
  action: z.enum(['approve', 'reject'], { error: 'The action is "approve" or "reject".' }),
  note: z.string().max(500, 'The note is too long (500 characters at most).').nullish(),
});

/** The optional note on a decision (D-096): the package bounds it too. */
const decisionNote = z.string(typeError(undefined, 'The note must be text.')).max(500, 'The note is too long (500 characters at most).').nullish();

/**
 * A promo (D-097). `value` is an INTEGER: centavos for a fixed amount,
 * hundredths of a percent for a percentage (1250 = 12.50 %); the screen
 * turns what was typed into it by string (plan § 2.1). @rag/bookings
 * validates the rest in words (the range, the code shape, the limit).
 */
export const createPromoSchema = z.object({
  name: z.string(typeError('A name is required', 'A name is required')),
  kind: z.enum(['fixed', 'percent'], { error: 'Kind is "fixed" or "percent"' }),
  value: z.number(typeError('A value is required', 'The value must be a number')),
  validFrom: z.string(typeError('"Valid from" is required', '"Valid from" must be a date')),
  validTo: z.string(typeError('"Valid to" is required', '"Valid to" must be a date')),
  code: z.string(typeError(undefined, 'The code must be text')).nullish(),
  maxUses: z.number(typeError(undefined, 'The usage limit must be a number')).nullish(),
});

/** A change to a promo: any subset, including `active: false` to retire it. */
export const updatePromoSchema = createPromoSchema.partial().extend({
  active: z.boolean(typeError(undefined, 'Active must be true or false')).optional(),
});

/** Staff decide a request: the whole group, one action, an optional note. */
/** A staff note on a stay (D-132): POST /bookings/stay/[reference]/notes. Empty and too long are @rag/bookings' to say, in words. */
export const stayNoteSchema = z.object({
  body: z.string(typeError('Write the note first.', 'The note must be text.')),
});

export const decideRequestSchema = z.object({
  action: z.enum(['confirm', 'decline', 'cancel'], {
    error: 'action is "confirm", "decline" or "cancel"',
  }),
  note: decisionNote,
});

/** Staff confirm or cancel ONE booking (D-095, D-096): PATCH /bookings/[id]. */
/** A physical room of a room type (D-133): its name. @rag/bookings bounds it again. */
export const unitRoomSchema = z.object({
  name: z.string(typeError('Name the room.', 'The name must be text.')).trim().min(1, 'Name the room.').max(80, 'A room name is at most 80 characters.'),
});

/** Rename a room, or retire it / offer it again. */
export const unitRoomUpdateSchema = z
  .object({
    name: unitRoomSchema.shape.name.optional(),
    active: z.boolean(typeError(undefined, 'active must be true or false.')).optional(),
  })
  .refine((v) => v.name !== undefined || v.active !== undefined, { message: 'Nothing to change.' });

/** Move a stay to another room of its type (D-133): the room, and why (required, like every decision, D-096). */
export const roomMoveSchema = z.object({
  roomId: z.number(typeError('Choose a room.', 'roomId must be a number.')).int().positive('Choose a room.'),
  note: z.string(typeError('Write why the booking moves.', 'The note must be text.')).trim().min(1, 'Write why the booking moves.').max(500, 'The note is too long (500 characters at most).'),
});

export const bookingActionSchema = z.object({
  action: z.enum(['confirm', 'cancel'], {
    error: 'action is "confirm" or "cancel"',
  }),
  note: decisionNote,
});

/** A holiday, peak or closed day (D-080). Surcharge in CENTAVOS; a closed day has none. */
export const holidaySchema = z.object({
  day: z.string(typeError('A date is required', 'A date is required')),
  kind: z.enum(['holiday', 'peak', 'closed'], { error: 'kind is "holiday", "peak" or "closed"' }).optional(),
  label: z.string(typeError('A label is required', 'A label is required')),
  surcharge: z.number(typeError(undefined, 'The surcharge must be a number')).nullish(),
});

/** Copy chosen days to the same month and day of another year. */
export const copyHolidaysSchema = z.object({
  days: z.array(z.string(), typeError('Choose dates to copy', 'Choose dates to copy')).max(100, 'Copy at most 100 dates at once.'), // calendar.ts's cap, in its words (GHSA-mrhx-c7xc-m3w5)
  toYear: z.number(typeError('A year is required', 'A year is required')),
});

/**
 * The first error message from a failed parse.
 *
 * The POC returned one message per request, and the screens are built to render
 * one. Concatenating every complaint would change what the UI shows for no gain.
 */
export function firstError(error: z.ZodError): string {
  return error.issues[0]?.message ?? 'Invalid request';
}

// --- tenant management (plan/tenant-management.md Phase 4) ------------------
// Shape only, as everywhere in this file: the slug's reserved words, the
// theme's five keys, the fallback messages' 500 characters and every
// application config rule are Postgres's (schema-tenancy.sql, schema-auth.sql,
// schema-roles.sql), and the routes pass its message through. The regexes
// repeated here exist to say so FIRST, in the form, with the same rule.

import { CONFIGURABLE_PERMISSIONS, ROLES } from './permissions';
import { COLOUR, THEME_KEYS } from './theme';

/** The same shape as tenants_slug_shape: lower-case, digits and hyphens, 3–32, no hyphen at either end. */
export const SLUG = /^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/;

const httpsUrl = z
  .string()
  .trim()
  .max(2048, 'That URL is too long')
  .url('That is not a URL')
  .refine((value) => value.startsWith('https://'), 'Only an https:// URL is allowed')
  .nullable();

const themeSchema = z
  .object(Object.fromEntries(Object.keys(THEME_KEYS).map((key) => [key, z.string().regex(COLOUR, 'A colour is #rgb or #rrggbb').optional()])))
  .strict();

const fallbackText = z.string().trim().min(1, 'A fallback message cannot be empty').max(500, 'A fallback message is at most 500 characters');
const fallbackMessagesSchema = z
  .object({ english: fallbackText.optional(), taglish: fallbackText.optional(), tagalog: fallbackText.optional() })
  .strict()
  .nullable();

/**
 * D-090: a slot, as the Slots screen sends it. The length is in minutes; the
 * package turns it into an interval and the database checks it again
 * (slots_duration_positive, the triggers of schema-slots.sql).
 */
const slotFields = {
  name: z.string().trim().min(1, 'A slot needs a name').max(60, 'A slot name is at most 60 characters'),
  startTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Start time is HH:MM, from 00:00 to 23:59'),
  minutes: z.number().int('The length is whole minutes').min(1, 'A slot lasts at least a minute').max(48 * 60, 'A slot is at most 48 hours long'),
  nightly: z.boolean(),
};
export const createSlotSchema = z.object({ ...slotFields, nightly: slotFields.nightly.optional() }).strict();
export const updateSlotSchema = z
  .object({
    name: slotFields.name.optional(),
    startTime: slotFields.startTime.optional(),
    minutes: slotFields.minutes.optional(),
    nightly: slotFields.nightly.optional(),
    active: z.boolean().optional(),
  })
  .strict()
  .refine((patch) => Object.keys(patch).length > 0, 'Nothing to change');

/** D-089: the same shape tenants_suggested_questions_shape enforces, said first in the form's words. */
export const MAX_SUGGESTED_QUESTIONS = 6;
export const MAX_SUGGESTED_QUESTION_LENGTH = 120;
const suggestedQuestionsSchema = z
  .array(
    z
      .string()
      .trim()
      .min(1, 'A suggested question cannot be empty')
      .max(MAX_SUGGESTED_QUESTION_LENGTH, `A suggested question is at most ${MAX_SUGGESTED_QUESTION_LENGTH} characters`),
  )
  .min(1, 'Send null for no suggested questions')
  .max(MAX_SUGGESTED_QUESTIONS, `At most ${MAX_SUGGESTED_QUESTIONS} suggested questions`)
  .nullable();

export const createTenantSchema = z.object({
  slug: z
    .string(typeError('A slug is required', 'A slug is required'))
    .trim()
    .regex(SLUG, 'A slug is 3–32 lower-case letters, digits and hyphens, not starting or ending with a hyphen'),
  businessName: z.string(typeError('A business name is required')).trim().min(1, 'A business name is required').max(100, 'A business name is at most 100 characters'),
  assistantName: z.string(typeError('An assistant name is required')).trim().min(1, 'An assistant name is required').max(50, 'An assistant name is at most 50 characters'),
});

/** D-139: the same bound as tenants_welcome_text_length, said first in the form's words. */
const welcomeTextSchema = z
  .string()
  .trim()
  .min(1, 'Send null for the default welcome line')
  .max(MAX_WELCOME_TEXT_LENGTH, `The welcome line is at most ${MAX_WELCOME_TEXT_LENGTH} characters`)
  .nullable();

export const updateTenantSchema = z
  .object({
    businessName: z.string().trim().min(1, 'A business name is required').max(100, 'A business name is at most 100 characters').optional(),
    assistantName: z.string().trim().min(1, 'An assistant name is required').max(50, 'An assistant name is at most 50 characters').optional(),
    logoUrl: httpsUrl.optional(),
    bannerUrl: httpsUrl.optional(),
    assistantAvatarUrl: httpsUrl.optional(),
    theme: themeSchema.optional(),
    fallbackMessages: fallbackMessagesSchema.optional(),
    suggestedQuestions: suggestedQuestionsSchema.optional(),
    welcomeText: welcomeTextSchema.optional(),
    // D-129–D-131, the Legal tab. The shapes are checked again by Postgres.
    privacyContactName: z.string().trim().min(1, 'The contact name is empty').max(100, 'The contact name is at most 100 characters').nullable().optional(),
    privacyContactEmail: z.string().trim().email('The privacy contact is an email address').max(254).nullable().optional(),
    dpaSignedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'The DPA date is YYYY-MM-DD').nullable().optional(),
    policyVersion: z.string().trim().regex(/^[A-Za-z0-9._-]{1,20}$/, 'The version is 1–20 letters, digits, dots, dashes or underscores').optional(),
    chatRetentionDays: z.number().int().min(30, 'Chats are kept at least 30 days').max(1825, 'Chats are kept at most 1,825 days').optional(),
    guestRetentionDays: z.number().int().min(180, 'Guest details are kept at least 180 days').max(3650, 'Guest details are kept at most 3,650 days').optional(),
    auditRetentionDays: z.number().int().min(90, 'Activity is kept at least 90 days').max(3650, 'Activity is kept at most 3,650 days').optional(),
  })
  .strict()
  .refine((patch) => Object.keys(patch).length > 0, 'Nothing to change');

/** An application's config: an object. What it must hold is the trigger's to say. */
export const applicationConfigSchema = z.object({
  config: z.record(z.string(), z.unknown(), typeError('A config object is required', 'A config object is required')),
});

/**
 * PUT /api/platform/tenants/[id]/permissions (D-128): the rows where a
 * tenant differs from the default, all of them; [] = the default. Postgres
 * checks the same shapes (role_permissions_role, _configurable).
 */
export const rolePermissionsSchema = z.object({
  rows: z
    .array(
      z.object({
        role: z.enum(ROLES, { error: `The role is one of ${ROLES.join(', ')}` }),
        permission: z.enum(CONFIGURABLE_PERMISSIONS as [string, ...string[]], { error: 'That permission cannot be changed per tenant' }),
        allowed: z.boolean(typeError(undefined, 'allowed is true or false')),
      }),
      typeError('The rows are required', 'The rows are a list'),
    )
    .max(ROLES.length * CONFIGURABLE_PERMISSIONS.length, 'Too many rows'),
});

/** PUT /api/platform/tenants/[id]/features/[key] (D-127): on or off. The key is in the URL, checked against lib/features.ts. */
export const featureSwitchSchema = z.object({
  enabled: z.boolean(typeError('Say whether the feature is on (enabled: true or false)', 'enabled is true or false')),
});

const role = z.enum(ROLES, { error: `The role is one of ${ROLES.join(', ')}` });
const userId = z.string(typeError('A user id is required')).uuid('That is not a user id');

/** An existing account, by email (the form) or by user id (the platform adding itself). One of the two. */
export const addMemberSchema = z
  .object({ email: email.optional(), userId: userId.optional(), role })
  .refine((v) => (v.email ? 1 : 0) + (v.userId ? 1 : 0) === 1, 'Give an email or a user id, not both');
export const memberRoleSchema = z.object({ userId, role });
export const removeMemberSchema = z.object({ userId });

/** Several unanswered questions at once (S-4's checkboxes): their ids, at most `max` (the list's cap, UNANSWERED_LIMIT, from the route). */
export function unansweredIdsSchema(max: number) {
  return z.object({
    ids: z
      .array(z.number().int().positive(), typeError('Choose at least one question', 'Choose at least one question'))
      .min(1, 'Choose at least one question')
      .max(max, `At most ${max} questions at once`),
  });
}

/**
 * A push subscription, as PushSubscription.toJSON() gives it, plus the kinds
 * this device wants (plan/notifications.md Phase 4). The endpoint's HOST is
 * checked by the package (a known push service); the database checks the
 * keys' shapes again.
 */
const notifyKind = z.enum(['request', 'proof', 'change'], { error: 'A kind is request, proof or change' });
export const pushDeviceSchema = z.object({
  endpoint: z.string(typeError('An endpoint is required')).url('The endpoint must be a URL').max(1000, 'The endpoint is too long'),
  keys: z.object({
    p256dh: z.string().regex(/^[A-Za-z0-9_-]{86,88}=?$/, 'The device key is not a P-256 key'),
    auth: z.string().regex(/^[A-Za-z0-9_-]{21,24}={0,2}$/, 'The device secret is not 16 bytes'),
  }),
  kinds: z.array(notifyKind).min(1, 'Choose at least one kind').max(3).transform((k) => [...new Set(k)]),
});
export const pushEndpointSchema = z.object({ endpoint: z.string(typeError('An endpoint is required')).url('The endpoint must be a URL').max(1000) });
/** DELETE /admin/push: this device, or (R-51) every device of the member. */
export const pushRemoveSchema = z.union([pushEndpointSchema, z.object({ all: z.literal(true) })], { error: 'Send { endpoint } or { all: true }' });

/**
 * POST /admin/notifications (plan/notifications.md § 8): mark these read, or
 * `all`. Ids are the outbox's; one that is not the member's marks nothing.
 */
export const notificationsReadSchema = z.union([
  z.object({ ids: z.array(z.number().int().positive(), { error: 'ids is a list of notification ids' }).min(1, 'Name at least one notification').max(200) }),
  z.object({ all: z.literal(true) }),
], { error: 'Send { ids: [...] } or { all: true }' });
