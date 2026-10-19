// features.ts — the feature flags a super user switches per tenant (D-127).
//
// Pure, like permissions.ts: the platform form (a Client Component) draws
// its switches from this list, the header hides what is off, and the server
// guard (lib/feature-flags.ts) answers 404 for it. The keys are the same as
// the check in sql/schema-features.sql, which refuses any other.
//
// A feature is ON unless the tenant's row says off: every tenant keeps what
// it has, and a new feature reaches every tenant at once. The one exception
// is a feature marked `defaultOn: false` (voice, D-134: it adds cost and
// sends audio to a third party), which is OFF until a super user's row says
// on. A feature that
// `needs` an application does nothing without it (the page 404s anyway);
// the platform form says so beside the switch.

export const FEATURES = [
  { key: 'dashboard', label: 'Dashboard', group: 'Staff screens', about: "Staff land on today's arrivals, chats, refusals and (for owners and admins) money." },
  { key: 'conversations', label: 'Conversations', group: 'Staff screens', about: 'Staff read every chat visitors had with the assistant.' },
  { key: 'unanswered', label: 'Unanswered questions', group: 'Staff screens', about: 'Staff see the questions the assistant could not answer, and mark them resolved.' },
  { key: 'calendar', label: 'Calendar', group: 'Staff screens', needs: 'bookings', about: 'A month view of the bookings, with what is free and what is taken.' },
  { key: 'notifications', label: 'Notifications', group: 'Staff screens', needs: 'bookings', about: 'The bell, the chime and phone pushes when a guest sends a request, a proof or a change.' },
  { key: 'suggested_questions', label: 'Suggested questions', group: 'Guest pages', about: 'Question buttons on a new chat. The questions themselves are set on the Profile tab.' },
  { key: 'booking_page', label: 'Online booking page', group: 'Guest pages', needs: 'bookings', about: 'Guests send a booking request on /book, and the chat offers "Book your stay". Off, staff still book by hand.' },
  { key: 'manage_booking', label: 'Manage booking', group: 'Guest pages', needs: 'bookings', about: 'Guests look up their booking, send a proof of payment, and ask to move or cancel it.' },
  { key: 'voice', label: 'Voice', group: 'Guest pages', defaultOn: false, about: 'Guests speak their question and hear the answer. Voice goes to OpenAI and adds to the bill. Off until switched on.' },
] as const;

export type FeatureKey = (typeof FEATURES)[number]['key'];
export type FeatureFlags = Readonly<Record<FeatureKey, boolean>>;

export const FEATURE_KEYS: readonly FeatureKey[] = FEATURES.map((f) => f.key);

/** Every feature on: what a test that wants every page uses. Not a tenant's default since voice (`featureFlags({})`). */
export const ALL_ON: FeatureFlags = Object.fromEntries(FEATURE_KEYS.map((k) => [k, true])) as Record<FeatureKey, boolean>;

/** A feature's state with no row: on, unless it is marked `defaultOn: false`. */
export function featureDefault(key: FeatureKey): boolean {
  const feature = FEATURES.find((f) => f.key === key)!;
  return 'defaultOn' in feature ? feature.defaultOn : true;
}

/** The tenant's rows (key → enabled) over the defaults. A key this list does not know is dropped. */
export function featureFlags(rows: Readonly<Record<string, boolean>>): FeatureFlags {
  return Object.fromEntries(FEATURE_KEYS.map((k) => [k, rows[k] ?? featureDefault(k)])) as Record<FeatureKey, boolean>;
}

export function isFeatureKey(value: string): value is FeatureKey {
  return (FEATURE_KEYS as readonly string[]).includes(value);
}
