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

/** An admin login. The key is checked against a scrypt hash, never compared as text. */
export const adminLoginSchema = z.object({
  key: z
    .string({ required_error: 'An admin key is required', invalid_type_error: 'An admin key is required' })
    .min(1, 'An admin key is required')
    // Generated keys are 43 characters. The cap stops a megabyte "key" from
    // costing a megabyte of scrypt input.
    .max(256, 'That is not an admin key'),
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
