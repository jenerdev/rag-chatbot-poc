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
  /**
   * D-097: a promo code the customer typed. Shape only (the database's
   * code shape); whether it exists, covers the dates or has uses left is
   * promo_for_request()'s answer, in words, on the quote.
   */
  promoCode: z.string({ invalid_type_error: 'The promo code must be text' }).max(32, 'That is not a promo code').nullish(),
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

/**
 * A price for a stay on the staff form (D-111): the booking page's quote
 * with the promo the staff member PICKED instead of a typed code. Types
 * only; every rule is parseRequest()'s, the page's own.
 */
export const staffQuoteSchema = bookQuoteSchema.omit({ promoCode: true }).extend({
  /** D-097: a promo the staff member picked; the trigger checks it and stores the discount */
  promoId: z.number({ invalid_type_error: 'Promo must be a number' }).nullish(),
});

/**
 * A stay booked by staff (D-111): the booking page's fields (name, mobile AND
 * email, check-in, nights, guests per unit), the picked promo, and Walk in.
 * No `status` (D-095: born pending; zod strips the key) and no `price`
 * (the trigger's, plan Rule 2).
 */
export const staffStaySchema = staffQuoteSchema.extend({
  name: z.string({ required_error: "The guest's name is required", invalid_type_error: "The guest's name is required" }),
  phone: z.string({ required_error: "The guest's mobile number is required", invalid_type_error: "The guest's mobile number is required" }),
  email: z.string({ required_error: "The guest's email is required", invalid_type_error: "The guest's email is required" }),
  notes: z.string({ invalid_type_error: 'Notes must be text' }).nullish(),
  walkIn: z.boolean({ invalid_type_error: 'Walk in is true or false' }).optional(),
});

/**
 * The Manage booking lookup (plan/manage-booking.md Phase 2): a reference
 * and the email or mobile number the guest booked with. POST, so neither
 * reaches a URL or a log. guest_stay() normalises and decides; this only
 * refuses what is not text.
 */
export const manageLookupSchema = z.object({
  reference: z.string({ required_error: 'Your booking reference is required', invalid_type_error: 'Your booking reference is required' }),
  contact: z.string({
    required_error: 'Your email or mobile number is required',
    invalid_type_error: 'Your email or mobile number is required',
  }),
});

/**
 * S-14 (plan/manage-booking.md Phase 4): verify or reject one proof. The
 * amount is pesos as typed, parsed by string (lib/money.ts); review_payment()
 * decides the rest in words (the range, "I checked the account", a reason).
 */
export const reviewPaymentSchema = z.object({
  action: z.enum(['verify', 'reject'], { errorMap: () => ({ message: 'The action is "verify" or "reject".' }) }),
  amount: z.string({ invalid_type_error: 'The amount must be text, like 1500 or 1,500.00' }).nullish(),
  accountChecked: z.boolean({ invalid_type_error: '"I checked the account" is true or false' }).optional(),
  note: z.string({ invalid_type_error: 'The note must be text.' }).max(500, 'The note is too long (500 characters at most).').nullish(),
  confirm: z.boolean({ invalid_type_error: '"confirm" is true or false' }).optional(),
});

/** A refund made elsewhere, recorded (record_refund() checks it against what was received). */
export const recordRefundSchema = z.object({
  groupId: z.string({ required_error: 'Which booking?', invalid_type_error: 'Which booking?' }),
  amount: z.string({ required_error: 'The amount refunded is required', invalid_type_error: 'The amount must be text, like 1500' }),
  method: z.string({ required_error: 'How was it returned?', invalid_type_error: 'How was it returned?' }),
  note: z.string({ required_error: 'A note is required', invalid_type_error: 'The note must be text.' }),
});

const payMethod = z.object({
  kind: z.enum(['gcash', 'bank', 'other'], { errorMap: () => ({ message: 'A way to pay is GCash, bank or other.' }) }),
  label: z.string({ required_error: 'Each way to pay needs a label', invalid_type_error: 'Each way to pay needs a label' }),
  accountName: z.string().nullish(),
  accountNumber: z.string().nullish(),
  instructions: z.string().nullish(),
});

/** The Settings tab: the whole `payments` setting, or null to turn payments off. The SQL validator decides the limits. */
export const paymentSettingsSchema = z.object({
  settings: z
    .object({
      methods: z.array(payMethod),
      fee: z.union([
        z.object({ kind: z.literal('full') }),
        z.object({ kind: z.enum(['fixed', 'percent']), value: z.number({ invalid_type_error: 'The fee is a number' }) }),
      ]),
      payWithinHours: z.number().nullable(),
      reviewWithinHours: z.number().nullable(),
      terms: z.string().nullable(),
      // Absent = "none", so a caller written before Phase 5 keeps today's rule.
      hold: z.enum(['none', 'on_proof', 'on_request'], { errorMap: () => ({ message: 'The hold is "none", "on_proof" or "on_request".' }) }).default('none'),
      // Phase 6; absent = no refund tiers, no rescheduling on the page.
      cancellation: z.array(z.object({ daysBefore: z.number(), refundPercent: z.number() })).default([]),
      rescheduleUntilDaysBefore: z.number().nullable().default(null),
    })
    .nullable(),
});

/** Phase 6: a guest's change request (or its quote, `dryRun`). request_change() decides the rest. */
export const changeRequestSchema = manageLookupSchema.extend({
  kind: z.enum(['cancel', 'reschedule'], { errorMap: () => ({ message: 'A change is "cancel" or "reschedule".' }) }),
  newCheckIn: z.string().nullish(),
  reason: z.string().max(500, 'The reason is too long (500 characters at most).').nullish(),
  dryRun: z.boolean().optional(),
});

/** Phase 6: staff decide a change request. */
export const decideChangeSchema = z.object({
  action: z.enum(['approve', 'reject'], { errorMap: () => ({ message: 'The action is "approve" or "reject".' }) }),
  note: z.string().max(500, 'The note is too long (500 characters at most).').nullish(),
});

/** The optional note on a decision (D-096): the package bounds it too. */
const decisionNote = z.string({ invalid_type_error: 'The note must be text.' }).max(500, 'The note is too long (500 characters at most).').nullish();

/**
 * A promo (D-097). `value` is an INTEGER: centavos for a fixed amount,
 * hundredths of a percent for a percentage (1250 = 12.50 %); the screen
 * turns what was typed into it by string (plan § 2.1). @rag/bookings
 * validates the rest in words (the range, the code shape, the limit).
 */
export const createPromoSchema = z.object({
  name: z.string({ required_error: 'A name is required', invalid_type_error: 'A name is required' }),
  kind: z.enum(['fixed', 'percent'], { errorMap: () => ({ message: 'Kind is "fixed" or "percent"' }) }),
  value: z.number({ required_error: 'A value is required', invalid_type_error: 'The value must be a number' }),
  validFrom: z.string({ required_error: '"Valid from" is required', invalid_type_error: '"Valid from" must be a date' }),
  validTo: z.string({ required_error: '"Valid to" is required', invalid_type_error: '"Valid to" must be a date' }),
  code: z.string({ invalid_type_error: 'The code must be text' }).nullish(),
  maxUses: z.number({ invalid_type_error: 'The usage limit must be a number' }).nullish(),
});

/** A change to a promo: any subset, including `active: false` to retire it. */
export const updatePromoSchema = createPromoSchema.partial().extend({
  active: z.boolean({ invalid_type_error: 'Active must be true or false' }).optional(),
});

/** Staff decide a request: the whole group, one action, an optional note. */
export const decideRequestSchema = z.object({
  action: z.enum(['confirm', 'decline', 'cancel'], {
    errorMap: () => ({ message: 'action is "confirm", "decline" or "cancel"' }),
  }),
  note: decisionNote,
});

/** Staff confirm or cancel ONE booking (D-095, D-096): PATCH /bookings/[id]. */
export const bookingActionSchema = z.object({
  action: z.enum(['confirm', 'cancel'], {
    errorMap: () => ({ message: 'action is "confirm" or "cancel"' }),
  }),
  note: decisionNote,
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
    assistantAvatarUrl: httpsUrl.optional(),
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

/** Several unanswered questions at once (S-4's checkboxes): their ids, at most `max` (the list's cap, UNANSWERED_LIMIT, from the route). */
export function unansweredIdsSchema(max: number) {
  return z.object({
    ids: z
      .array(z.number().int().positive(), { required_error: 'Choose at least one question', invalid_type_error: 'Choose at least one question' })
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
const notifyKind = z.enum(['request', 'proof', 'change'], { message: 'A kind is request, proof or change' });
export const pushDeviceSchema = z.object({
  endpoint: z.string({ required_error: 'An endpoint is required' }).url('The endpoint must be a URL').max(1000, 'The endpoint is too long'),
  keys: z.object({
    p256dh: z.string().regex(/^[A-Za-z0-9_-]{86,88}=?$/, 'The device key is not a P-256 key'),
    auth: z.string().regex(/^[A-Za-z0-9_-]{21,24}={0,2}$/, 'The device secret is not 16 bytes'),
  }),
  kinds: z.array(notifyKind).min(1, 'Choose at least one kind').max(3).transform((k) => [...new Set(k)]),
});
export const pushEndpointSchema = z.object({ endpoint: z.string({ required_error: 'An endpoint is required' }).url('The endpoint must be a URL').max(1000) });
/** DELETE /admin/push: this device, or (R-51) every device of the member. */
export const pushRemoveSchema = z.union([pushEndpointSchema, z.object({ all: z.literal(true) })], { errorMap: () => ({ message: 'Send { endpoint } or { all: true }' }) });

/**
 * POST /admin/notifications (plan/notifications.md § 8): mark these read, or
 * `all`. Ids are the outbox's; one that is not the member's marks nothing.
 */
export const notificationsReadSchema = z.union([
  z.object({ ids: z.array(z.number().int().positive(), { message: 'ids is a list of notification ids' }).min(1, 'Name at least one notification').max(200) }),
  z.object({ all: z.literal(true) }),
], { errorMap: () => ({ message: 'Send { ids: [...] } or { all: true }' }) });
