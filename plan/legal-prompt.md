# Prompt: the legal groundwork (privacy policy, terms, consent, DPA, retention)

Paste everything below the line into a new Claude Code session in this repo.

---

Implement the legal groundwork for this app before real guests use it. The
app runs in the Philippines, so the **Data Privacy Act of 2012 (RA 10173)**
applies: each resort (tenant) is the personal information **controller** for
its guests, and the platform is their **processor**. We collect guests'
names, mobile numbers, emails, payment receipts and chat transcripts, and
chat text is sent to OpenAI.

**You are writing the app's parts, not the law.** Every policy text you
write is a clearly marked PLACEHOLDER for a lawyer to replace. Never present
generated legal text as final.

Read `CLAUDE.md` first, then `plan.md` § 0, `plan/customer-booking.md` § 0,
`plan/manage-booking.md` § 0 and `risks.md` R-48 and R-50. Follow the
project's way of working: write `plan/legal.md` (phases, rules, and the
decisions below) and show it to me **before writing code**; one commit per
phase, on a branch `feat/legal`; update `status.md`, `whats-done.md` and
`decisions.md` (next is **D-127**) as each phase finishes; record observed
values, not predicted ones.

## The four parts and where each goes

### 1. Privacy policy and terms of use: pages, linked everywhere
- New PUBLIC pages per tenant: `/t/<slug>/privacy` and `/t/<slug>/terms`
  (Server Components, 404 on an unknown or archived tenant like every
  tenant page, branded with `BrandHeader` like the booking page).
- Their text comes from the tenant's record: a privacy contact
  (name/role and email, the Data Protection Officer the Act requires) set on
  the platform form, filled into a PLACEHOLDER template that names the
  resort as controller. Store what the template needs as columns on
  `tenants` (new SQL file, the **33rd**, https/shape checks in SQL), and
  expose them through `tenant_public()` only if a visitor must see them.
  `tenant_public()` is a drop-and-recreate (its return type changes):
  guard the older definition in `schema-assistant-avatar.sql` on the new
  file's marker (trap 20), re-apply the grants, and update verify.mjs's
  public-columns allowlist.
- Links: add "Privacy" and "Terms" to `components/public-footer.tsx` (used
  by the booking page and Manage booking). **The chat page has no footer**:
  link both from the chat's consent line (part 2) instead. The landing page
  (`app/page.tsx`) gets platform-level placeholder pages `/privacy` and
  `/terms` for the platform itself.

### 2. Consent notices: at each point we collect data
- **Booking page** (`components/booking-page.tsx`, the last step): a
  required, unticked checkbox "I have read the Privacy Policy and agree to
  the Terms", both linked. Submit is refused without it **on the server
  too** (the route's schema in `lib/schemas.ts`, and SQL).
- **Record the consent** on the stay: when, and which policy version (a
  version string per tenant, bumped when its policy changes). The only
  public write is `request_booking()` (D-071), a security definer function
  replaced across several schema files: find its newest definition, add the
  parameter in the new file with every older definition guarded (trap 20),
  and keep it the ONE public write. A staff booking (`staff-stay.ts`) has no
  consent box; record it as staff-entered instead.
- **Chat** (`components/chat-screen.tsx`): one short line under the
  composer or on the welcome card: you are talking to an AI assistant, the
  conversation is saved and read by the resort's staff, and it is processed
  by OpenAI; with Privacy and Terms links. **No prompt text and no tool
  text changes.** The three chatbot baselines (CLAUDE.md Rule 1) must stay
  byte-identical; check them.
- **Manage booking's proof form** (`components/manage-booking.tsx`): one
  line saying the receipt is kept to verify the payment and deleted
  `PROOF_RETENTION_DAYS` (180) after the stay. Read the number from
  `@rag/bookings` through the server page, never a copy.

### 3. Data processing agreement: a gate on the platform
- Not a page: a signed contract between the platform and each resort. In
  the app: on the platform tenant form (`components/tenant-form.tsx`), a
  "DPA signed on" date and a "Privacy contact" field. A tenant with no DPA
  date cannot have the bookings application switched on, and Postgres says
  so (a trigger, like `tenant_applications_validate`), not only the form.
- Existing tenants: list which have no DPA date and stop. Do not backfill
  dates, and do not switch anything off; ask me.

### 4. Retention: periods, and the jobs that enforce them
- **Payment proofs** already expire: `storage-orphans -- --expired` deletes
  the files 180 days after the stay. Keep it.
- **Chat transcripts** are kept forever today (R-50). Add a sweep that
  deletes conversations older than the tenant's chat retention period, in
  the same style as the proof sweep: a dry run by default, a flag to
  delete, counted (a refused delete is silent; trap 17). Mind what cascades
  (Unanswered's history hangs off messages): say in `plan/legal.md` what is
  lost and what is kept.
- **Guest details on old stays**: after the tenant's period, clear name,
  phone and email from bookings that ended (keep the rows, amounts and
  references for the books). Same dry run / flag / count shape.
- The periods live in each tenant's bookings config (or on `tenants` for
  the chat), are set on the platform form, have a minimum and maximum
  checked in SQL, and appear in that tenant's privacy policy.
- Nothing is deployed, so these are commands, not cron. Write in
  `plan/legal.md` what must schedule them on deployment, and update R-50.

## Decisions to ask me before Phase 1 (do not choose them yourself)
1. The default chat retention period, and guest-detail retention period.
2. Whether a guest may ask for their data to be deleted from Manage
   booking (a request staff decide, like a cancellation), or only by email
   for now.
3. The platform's own legal name and contact for its `/privacy` page.

## Rules that already hold, and must still hold
- Two walls (Rule 6): every new query filters on `tenant_id`, and every new
  table or column has its policy; prove each wall alone (`isolation` both
  ways, `verify` checks with positive twins, trap 12).
- No service_role in a request (Rule 2); the sweeps are `tools/` scripts.
- No colour literals after `tokens.css`; axe at 0 on every page you touch
  (light and dark, 1280 and 375): extend `public-brand-a11y.mjs` or write
  `plan/legal-a11y.mjs`.
- Everything from the database is a React child, never HTML; the policy
  templates are text with the tenant's values as children, never
  `dangerouslySetInnerHTML`.
- Do not change booking prices, statuses, or the request flow beyond the
  consent field.

## Done means
- `pnpm typecheck`, `pnpm test`, `pnpm --filter @rag/db verify` (191 +
  yours), both isolation suites both ways, `rooms`, the three baselines
  identical, the booking walk (`customer-booking-phase3-walk.mjs`) and the
  Manage booking walks passing.
- A browser walk: a booking refused without the box, accepted with it, the
  consent recorded on the stay; the links reach both pages; a tenant with
  no DPA date cannot get bookings switched on; each sweep's dry run lists,
  then deletes and counts, on a throwaway tenant.
- Screenshots of the new pages and notices in `plan/legal/`.
- Nothing merged to `master` until I have looked.
