import { z } from 'zod';
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

export const createDocumentSchema = z.object({
  title: z
    .string({ required_error: 'A title is required', invalid_type_error: 'A title is required' })
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
    .string({
      required_error: 'Document content is required',
      invalid_type_error: 'Document content is required',
    })
    .min(1, 'Document content is required')
    .refine((value) => value.trim() !== '', 'Document content is required')
    .refine(
      (value) => value.length <= MAX_CONTENT_LENGTH,
      (value) => ({
        message: `Document is ${value.length} characters; the limit is ${MAX_CONTENT_LENGTH}`,
      }),
    ),
});

export const chatSchema = z.object({
  // A uuid from a previous reply, or absent on the first message of a session.
  // Anything else is a client bug worth surfacing rather than ignoring.
  conversationId: z
    .string({ invalid_type_error: 'conversationId must be a string' })
    .nullish()
    .transform((value) => value || null),
  message: z
    .string({
      required_error: 'A message is required',
      invalid_type_error: 'A message is required',
    })
    .min(1, 'A message is required')
    .refine((value) => value.trim() !== '', 'A message is required')
    .refine(
      (value) => value.length <= MAX_MESSAGE_LENGTH,
      (value) => ({
        message: `Question is ${value.length} characters; the limit is ${MAX_MESSAGE_LENGTH}`,
      }),
    ),
});

const email = z
  .string({ required_error: 'An email is required', invalid_type_error: 'An email is required' })
  .trim()
  .min(1, 'An email is required')
  .max(320, 'That is not an email address')
  .email('That is not an email address');

// Supabase Auth's minimum is 6 by default. The cap stops a megabyte
// "password" from reaching Supabase at all.
const password = z
  .string({ required_error: 'A password is required', invalid_type_error: 'A password is required' })
  .min(1, 'A password is required')
  .max(256, 'That password is too long');

/** A staff login (auth-rls Phase 5). Checked by Supabase Auth, then against `memberships`. */
export const adminLoginSchema = z.object({ email, password });

/** "Forgot password?" The same answer whether or not the email has an account. */
export const passwordResetSchema = z.object({ email });

/** A new password, with the access token from the reset (or invite) link. */
export const setPasswordSchema = z.object({
  accessToken: z
    .string({ required_error: 'The reset link is incomplete', invalid_type_error: 'The reset link is incomplete' })
    .min(1, 'The reset link is incomplete')
    .max(8192, 'The reset link is not valid'),
  password: password.min(8, 'Use at least 8 characters'),
});

/**
 * A new booking, from the admin screen.
 *
 * Shape only. The meaning (a real date, not in the past, a non-blank name,
 * lengths) is checked by @rag/bookings. That package has a second caller, the
 * chatbot's tool executor, which has no zod schema in front of it. If the rules
 * lived here too they would be two copies free to drift, so they live in one
 * place and this only rejects the wrong TYPES.
 */
const room = z.object({
  unitId: z.number({ required_error: 'A room is required', invalid_type_error: 'A room is required' }),
  guestCount: z.number({ invalid_type_error: 'Guest count must be a number' }).nullish(),
});

// One unit (`unitId`, what the form has always sent) or several rooms
// (`rooms`, per_room only, plan/booking-types.md § 2.5). "Exactly one of the
// two" is @rag/bookings' rule (parseRooms), so both are optional here.
// There is deliberately no `price`: zod strips unknown keys, and the trigger
// would overwrite one anyway (plan Rule 2).
export const createBookingSchema = z.object({
  unitId: z.number({ invalid_type_error: 'A unit is required' }).optional(),
  rooms: z.array(room, { invalid_type_error: 'Rooms must be a list' }).optional(),
  slotId: z.number({ required_error: 'A slot is required', invalid_type_error: 'A slot is required' }),
  date: z.string({ required_error: 'A date is required', invalid_type_error: 'A date is required' }),
  guestName: z.string({ required_error: 'Guest name is required.', invalid_type_error: 'Guest name is required.' }),
  guestPhone: z.string({ invalid_type_error: 'Guest phone must be text.' }).nullish(),
  guestCount: z.number({ invalid_type_error: 'Guest count must be a number' }).nullish(),
  notes: z.string({ invalid_type_error: 'Notes must be text.' }).nullish(),
  status: z.enum(['pending', 'confirmed'], { invalid_type_error: 'Status must be "pending" or "confirmed".' }).optional(),
});

/** A price preview for one unit or several rooms (per_room only). */
export const quoteSchema = z.object({
  unitId: z.number({ invalid_type_error: 'A unit is required' }).optional(),
  // One unit's guests; with `rooms`, each room carries its own.
  guestCount: z.number({ invalid_type_error: 'Guest count must be a number' }).nullish(),
  rooms: z.array(room, { invalid_type_error: 'Rooms must be a list' }).optional(),
  slotId: z.number({ required_error: 'A slot is required', invalid_type_error: 'A slot is required' }),
  date: z.string({ required_error: 'A date is required', invalid_type_error: 'A date is required' }),
});

/**
 * A new room. Lengths and "positive" are @rag/bookings' to check, and so are
 * the defaults for anything left out (standard 2, maximum 4, ₱250;
 * plan/extra-guests.md). `maxCapacity` and `capacity` are the same thing.
 * The rate is CENTAVOS, like every price.
 */
export const createAccommodationSchema = z.object({
  name: z.string({ required_error: 'A room name is required', invalid_type_error: 'A room name is required' }),
  description: z.string({ invalid_type_error: 'Description must be text' }).nullish(),
  capacity: z.number({ invalid_type_error: 'Maximum guests must be a number' }).nullish(),
  maxCapacity: z.number({ invalid_type_error: 'Maximum guests must be a number' }).nullish(),
  standardCapacity: z.number({ invalid_type_error: 'Standard guests must be a number' }).nullish(),
  extraPersonRate: z.number({ invalid_type_error: 'The extra guest rate must be a number' }).nullish(),
  sortOrder: z.number({ invalid_type_error: 'Order must be a number' }).optional(),
});

/** A change to a room: any subset, including `active: false` to retire it. */
export const updateAccommodationSchema = createAccommodationSchema.partial().extend({
  active: z.boolean({ invalid_type_error: 'Active must be true or false' }).optional(),
});

/** A room's rates, in CENTAVOS, one entry per slot being set. */
export const setRatesSchema = z.object({
  rates: z.array(
    z.object({
      slotId: z.number({ required_error: 'A slot is required', invalid_type_error: 'A slot is required' }),
      weekdayPrice: z.number({ required_error: 'A weekday price is required', invalid_type_error: 'A weekday price is required' }),
      weekendPrice: z.number({ required_error: 'A weekend price is required', invalid_type_error: 'A weekend price is required' }),
      // Optional (customer booking § 2.3): null = the weekend price on a
      // holiday. All rates or none is @rag/bookings' rule (setRates).
      holidayPrice: z.number({ invalid_type_error: 'A holiday price must be a number' }).nullish(),
    }),
    { required_error: 'Rates are required', invalid_type_error: 'Rates must be a list' },
  ),
});

/**
 * Move a photo: `{ move: -1 }` (left) or `{ move: 1 }` (right), which the
 * screen sends, or `{ sortOrder }` for a direct place. One of the two.
 */
export const imageOrderSchema = z
  .object({
    // errorMap, not invalid_type_error: a union reports its own "invalid_union"
    // issue, which invalid_type_error never reaches (code review, 2026-09-28).
    move: z.union([z.literal(-1), z.literal(1)], { errorMap: () => ({ message: 'move is -1 or 1' }) }).optional(),
    sortOrder: z.number({ invalid_type_error: 'Order must be a number' }).optional(),
  })
  .refine((v) => (v.move === undefined) !== (v.sortOrder === undefined), { message: 'Send either move or sortOrder' });

// --- customer booking (plan/customer-booking.md) ------------------------------
// Types only, as above: every rule (dates, nights, phone and email shape,
// limits) is @rag/bookings' parseRequest() and, behind it, the SQL function
// request_booking(). No price and no status field exist to send: zod strips
// unknown keys, and the function would not take them anyway.

const requestRoom = z.object({
  unitId: z.number({ required_error: 'Choose what to book', invalid_type_error: 'Choose what to book' }),
  guests: z.number({ required_error: 'Enter the number of guests', invalid_type_error: 'Enter the number of guests' }),
});

/** A price for a stay, before sending it. */
export const bookQuoteSchema = z.object({
  slotId: z.number({ required_error: 'Choose a booking slot', invalid_type_error: 'Choose a booking slot' }),
  rooms: z.array(requestRoom, { required_error: 'Choose what to book', invalid_type_error: 'Choose what to book' }),
  checkIn: z.string({ required_error: 'Choose a date', invalid_type_error: 'Choose a date' }),
  nights: z.number({ invalid_type_error: 'Nights must be a number' }).optional(),
});

/**
 * A customer's booking request. `website` is a honeypot: a field the page
 * hides from people, so only a form-filling bot fills it (plan § 2.1).
 */
export const bookRequestSchema = bookQuoteSchema.extend({
  name: z.string({ required_error: 'Your name is required', invalid_type_error: 'Your name is required' }),
  phone: z.string({ required_error: 'Your mobile number is required', invalid_type_error: 'Your mobile number is required' }),
  email: z.string({ required_error: 'Your email is required', invalid_type_error: 'Your email is required' }),
  notes: z.string({ invalid_type_error: 'Notes must be text' }).nullish(),
  website: z.string().optional(),
});

/** Staff decide a request: the whole group, one action. */
export const decideRequestSchema = z.object({
  action: z.enum(['confirm', 'decline'], {
    errorMap: () => ({ message: 'action is "confirm" or "decline"' }),
  }),
});

/** A holiday, peak or closed day (D-080). Surcharge in CENTAVOS; a closed day has none. */
export const holidaySchema = z.object({
  day: z.string({ required_error: 'A date is required', invalid_type_error: 'A date is required' }),
  kind: z.enum(['holiday', 'peak', 'closed'], { errorMap: () => ({ message: 'kind is "holiday", "peak" or "closed"' }) }).optional(),
  label: z.string({ required_error: 'A label is required', invalid_type_error: 'A label is required' }),
  surcharge: z.number({ invalid_type_error: 'The surcharge must be a number' }).nullish(),
});

/** Copy chosen days to the same month and day of another year. */
export const copyHolidaysSchema = z.object({
  days: z.array(z.string(), { required_error: 'Choose dates to copy', invalid_type_error: 'Choose dates to copy' }),
  toYear: z.number({ required_error: 'A year is required', invalid_type_error: 'A year is required' }),
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

import { ROLES } from './permissions';
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
    .string({ required_error: 'A slug is required', invalid_type_error: 'A slug is required' })
    .trim()
    .regex(SLUG, 'A slug is 3–32 lower-case letters, digits and hyphens, not starting or ending with a hyphen'),
  businessName: z.string({ required_error: 'A business name is required' }).trim().min(1, 'A business name is required').max(100, 'A business name is at most 100 characters'),
  assistantName: z.string({ required_error: 'An assistant name is required' }).trim().min(1, 'An assistant name is required').max(50, 'An assistant name is at most 50 characters'),
});

export const updateTenantSchema = z
  .object({
    businessName: z.string().trim().min(1, 'A business name is required').max(100, 'A business name is at most 100 characters').optional(),
    assistantName: z.string().trim().min(1, 'An assistant name is required').max(50, 'An assistant name is at most 50 characters').optional(),
    logoUrl: httpsUrl.optional(),
    bannerUrl: httpsUrl.optional(),
    theme: themeSchema.optional(),
    fallbackMessages: fallbackMessagesSchema.optional(),
    suggestedQuestions: suggestedQuestionsSchema.optional(),
  })
  .strict()
  .refine((patch) => Object.keys(patch).length > 0, 'Nothing to change');

/** An application's config: an object. What it must hold is the trigger's to say. */
export const applicationConfigSchema = z.object({
  config: z.record(z.unknown(), { required_error: 'A config object is required', invalid_type_error: 'A config object is required' }),
});

const role = z.enum(ROLES, { errorMap: () => ({ message: `The role is one of ${ROLES.join(', ')}` }) });
const userId = z.string({ required_error: 'A user id is required' }).uuid('That is not a user id');

/** An existing account, by email (the form) or by user id (the platform adding itself). One of the two. */
export const addMemberSchema = z
  .object({ email: email.optional(), userId: userId.optional(), role })
  .refine((v) => (v.email ? 1 : 0) + (v.userId ? 1 : 0) === 1, 'Give an email or a user id, not both');
export const memberRoleSchema = z.object({ userId, role });
export const removeMemberSchema = z.object({ userId });
