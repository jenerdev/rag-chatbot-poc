# plan/legal.md — the legal groundwork (D-129 – D-131)

The brief is `plan/legal-prompt.md`. The app runs in the Philippines, so the
**Data Privacy Act of 2012 (RA 10173)** applies. Each resort (tenant) is the
**personal information controller** for its guests, and the platform is its
**processor**. We collect guests' names, mobile numbers, emails, payment
receipts and chat transcripts, and the chat text is sent to OpenAI.

**We write the app's parts, not the law.** Every policy text here is a
marked PLACEHOLDER for a lawyer to replace. Nothing in this plan is legal
advice.

## § 0 · The three decisions the brief asked the user for

The user asked for this to run unattended ("if one item has a blocker,
proceed"), so each decision below is made PROVISIONALLY, on the cautious
side, and is one setting to change:

| # | Question | Provisional answer | Where to change it |
|---|---|---|---|
| 1 | How long are chats and guest details kept? | Chats **365 days** from the last message. Guest details **1,095 days (3 years)** after check-out. Each tenant can set 30–1,825 and 180–3,650 days. | The platform tenant form's Legal tab (per tenant); the defaults in `schema-legal.sql` |
| 2 | Can a guest ask for deletion from Manage booking? | **Not yet: by email** to the tenant's privacy contact, as the privacy page says. A deletion request flow is a follow-up. | — |
| 3 | The platform's own legal name and contact | **Placeholders**: `[Platform operator's registered name]`, `[privacy@platform.example]`. Set in ONE place, `apps/web/lib/legal.ts`. | `lib/legal.ts` |

**Waits on the user:** confirm or change these three, and have a lawyer
replace the placeholder texts.

## § 1 · Rules

1. **Two walls for the writes that matter.**
   - The DPA gate is a trigger: the platform cannot switch bookings on
     for a tenant with no DPA date.
   - The retention sweeps are counted.
   - The consent box is required by the route, and Postgres RECORDS it on
     the stay as it is born. Postgres does not refuse a web stay without
     it, because every older tool and test books through
     `request_booking()` directly. The browser never holds a token, so the
     route is the only web door (§ 4).
2. **`request_booking()` is not replaced.** It is defined across five files
   and its body is long (trap 20). A thin definer wrapper,
   `request_booking_with_consent()`, sets a transaction-local setting and
   calls it. A BEFORE INSERT trigger on `stays` copies the setting onto the
   stay row.
3. **Policy text is React children** filled with the tenant's values, never
   HTML.
4. **No prompt or tool text changes.** The three chatbot baselines stay
   byte-identical; the chat's consent line is page text.
5. **The sweeps are `tools/` scripts on service_role:** a dry run by
   default, `--remove` to act, and every removal counted (trap 17).
   Nothing is deployed, so nothing schedules them yet (§ 6).

## § 2 · Phase 1 — SQL, the 35th file `schema-legal.sql`

- **`tenants` gains:**
  - `privacy_contact_name` and `privacy_contact_email` (the Act's Data
    Protection Officer, a shape check);
  - `dpa_signed_on` (a date);
  - `policy_version` (text, default `'1'`, shape check);
  - `chat_retention_days` and `guest_retention_days` (with defaults and
    ranges, § 0).
- **`tenant_public()`** is dropped and recreated with the privacy contact,
  the policy version and the two periods. Their place is the public privacy
  page. The older definition in `schema-assistant-avatar.sql` is guarded on
  this file's marker; re-applying the grants is part of the same step.
- **`stays` gains** `consent_version` and `consented_at`.
  `stays_consent()` (BEFORE INSERT) copies the transaction-local
  `app.consent_version` onto the row, and `request_booking_with_consent()`
  sets it and calls `request_booking()`. A stay made by staff has none:
  staff entered it.
- **`tenant_applications_dpa()`** (BEFORE INSERT) refuses the bookings
  application for a tenant with no `dpa_signed_on`, with the words "Record
  the signed data processing agreement first". service_role (the CLI and
  the walks) is exempt; the platform token is not. Existing rows are not
  touched; § 5 lists the tenants that have bookings and no DPA date.
- **Guest details can be removed:**
  - `bookings.guest_removed_at`;
  - `bookings_web_fields` is re-made to accept a web row whose details are
    removed (the older file's version is guarded);
  - `remove_guest_details(p_tenant_id, p_before date)`: service_role only.
    It clears name, phone, email, notes and the change requests' reasons
    on stays that ended before the date, and returns the count.

## § 3 · Phase 2 — the pages

- **`/t/<slug>/privacy` and `/t/<slug>/terms`:** public, branded with
  `BrandHeader`, and a 404 for an unknown or archived tenant. The text comes
  from `lib/legal.ts`, a placeholder template filled with the tenant's name,
  contact, periods and version.
- **`/privacy` and `/terms`:** the platform's own, linked from the landing
  page.
- **Links:**
  - "Privacy" and "Terms" in `public-footer.tsx` (the booking page and
    Manage booking);
  - the chat page has no footer, so its consent line carries both links.

## § 4 · Phase 3 — consent and the notices

- **Booking page:** a required, unticked checkbox, "I have read the Privacy
  Policy and agree to the Terms", above Send.
  - `bookRequestSchema` requires `consent: true`.
  - The route calls `request_booking_with_consent()` with the tenant's
    policy version.
  - The receipt is unchanged.
- **Chat:** one line on the welcome card. It says you're talking to an AI
  assistant, the conversation is saved and read by the resort's staff, and
  it is processed by OpenAI, then links Privacy and Terms.
- **Manage booking's proof form:** one line saying the receipt is kept to
  verify the payment and deleted `PROOF_RETENTION_DAYS` (180) days after
  the stay. The number comes through the server page.

## § 5 · Phase 4 — the platform's Legal tab and the DPA gate

- **A Legal tab** on the tenant form: DPA signed on, privacy contact (name
  and email), policy version, and the two retention periods. It saves
  through the ordinary tenant PATCH.
- **The Applications tab** says why Switch on is refused when there is no
  DPA date. Postgres's own sentence comes back as the toast.
- **Existing tenants with bookings and no DPA date** are listed, not
  changed (the brief's "list and stop"):
  `plan/legal-dpa-missing.mjs` prints them. The user decides.

## § 6 · Phase 5 — retention

- **Chats:** `pnpm --filter @rag/db retention [-- --remove]`. A
  conversation whose newest message is older than the tenant's
  `chat_retention_days` is deleted, and its messages with it.
  - What cascades: a refused question's resolution row goes too
    (Unanswered's history), so the Unanswered list loses old entries.
  - Kept: nothing of that chat.
- **Guest details:** the same command calls `remove_guest_details()` for
  each tenant, with the tenant's `guest_retention_days`. The booking rows,
  dates, amounts and references stay for the books.
- **Payment receipts:** unchanged, `storage-orphans -- --expired` (180
  days).
- **On deployment:** a daily job runs `retention -- --remove` and
  `storage-orphans -- --expired --remove`. R-50 is updated to point here.

## § 7 · Done means

- **Suites:** typecheck, test, verify (201 + the new checks), isolation
  both ways, rooms, the three baselines identical, and
  `customer-booking-phase3-walk.mjs`.
- **`plan/legal-walk.mjs`:**
  - a booking refused without the box and accepted with it, with the
    consent recorded on the stay;
  - the footer and chat links reach both pages;
  - bookings cannot be switched on without a DPA date, and can with one;
  - each sweep's dry run lists, then removes and counts, on a throwaway
    tenant.
- **axe** over the new pages and notices, 0 violations; screenshots in
  `plan/legal/`.
- **Not merged** until the user has looked.
