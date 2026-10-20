// The welcome line (D-139): the one sentence under the assistant's name on a
// new chat, saying what to ask it. Per tenant, `tenants.welcome_text`, set on
// the platform tenant form and read through tenant_public(); null means
// these words. The chat (a Client Component) draws the default, the form
// shows it as the field's placeholder, and lib/schemas.ts bounds the length
// the same way tenants_welcome_text_length does, so this file is browser-safe
// and imports nothing.

export const DEFAULT_WELCOME_TEXT = 'Discover more about our resort, accommodations, amenities, and booking options.';

/** The same bound as tenants_welcome_text_length (schema-welcome-text.sql). */
export const MAX_WELCOME_TEXT_LENGTH = 200;

/** The tenant's line, or the default: an empty or blank setting is the default too. */
export function welcomeTextOf(value: string | null | undefined): string {
  const text = value?.trim() ?? '';
  return text === '' ? DEFAULT_WELCOME_TEXT : text;
}
