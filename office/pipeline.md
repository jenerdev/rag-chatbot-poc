# The pipeline

Every idea, its lane, its gates and its status, DERIVED from the gates (plan/ai-employees.md Rule 10). Written by `node office/office.mjs idea|gate …` only.

## analytics · Google Analytics on the public pages (the chat, the booking page, Manage booking) · full lane · from user · 2026-10-27 · **Approved**

- idea · APPROVE · by ivy · 2026-10-28 · file: docs/product/analytics.md · note: Real gap (no visit or funnel counts anywhere); approved scoped: no guest content or ref to any vendor, off by default (D-127), Lex during requirements, CSP with R-55, vendor chosen by the user at gate 2
- requirements · DONE · by rhea · 2026-10-28 · file: docs/requirements/analytics.md · note: FR-analytics-001..025, AC-01..24; Q1 (means, GA4 default) and Q2 (who reads) for the user; Q3/Q9 asked of Lex (M-004); Q8 for Theo
- requirements · APPROVE · by user · 2026-10-28 · note: The user 2026-10-28: 'A, default for the rest, approve'. Q1 A (GA4). Q2 default (owners of their own tenant and the operator, admins and staff not). Q4 default (the operator view is enough for v1). Q5 default (no: the landing, privacy and terms pages unmeasured). Q7 default (staff not excluded in v1). Q3 and Q9 stay Lex's, Q8 Theo's, Q6 Rhea's default
- ux · DONE · by uma · 2026-10-28 · file: docs/ux/analytics.md · note: No new screen: a ConsentBar (S-1 above the composer; S-6/S-13 under the brand band; in flow, not modal, equal Don't allow/Allow, no close) and a 'Your analytics choice' control on the tenant privacy page (#analytics); platform Features row. Lex's 180 days, version re-ask and GPC designed as [if FR]; ?ref= removal proposed to Rhea
- design · DONE · by vera · 2026-10-28 · file: docs/design/analytics.md
- architecture · SUBMITTED · by theo · 2026-10-28 · file: plan/analytics.md
- architecture · CONCERNS · by sage · 2026-10-28 · file: docs/security/analytics.md
- architecture · SUBMITTED · by theo · 2026-10-28 · file: plan/analytics.md · note: round 2: M-021 answers built (one property per tenant, Viewer-only as Rule 9; FR-028 instruction date; host-allowlist CSP); Rhea's A-1..A-22 mapped in section 8.2 (version bumped on FIRST switch-on only, unique ID, instruction date); Sage S-A1..S-A10 plus the audit and the anon-key row each adopted with a phase step and a check in section 8.1, none declined; D-151 amended, still proposed
- architecture · CLEAR · by sage · 2026-10-28 · file: docs/security/analytics.md
- architecture · APPROVE · by user · 2026-10-28 · note: The user 2026-10-28: 'approve, dependency upgrade as its own task'. Conditions, closed by Finn in their phases with a check each: S-A11 (the reload guard also covers admin/reset and platform, before paint), S-A4a (pass the slug when the switch is off, so Decline clears) and S-A4b (every parent domain), S-A12 (the slug's real shape), S-A13 (select for update, one-statement version bump), S-A14 (no duplicate Report-Only). Section 7 q5 to q8 take Theo's defaults. The next, sharp and zod bump is NOT Phase 0's: it is idea deps-upgrade

## free-guest-field · The platform form's free-guest field seen on screen · short lane · from user · 2026-10-27 · **Reviewed**

- implementation · DONE · by finn · 2026-10-28 · file: whats-done.md · note: 2026-10-28, Free guests: the platform form's field seen on screen (D-147, short lane free-guest-field)
- qa · PASS · by quinn · 2026-10-28 · file: docs/qa/free-guest-field.md
- release · READY WITH DOCUMENTED RISKS · by quinn · 2026-10-28 · file: docs/qa/free-guest-field.md

## deps-upgrade · Bump next, sharp and zod past the advisories Sage's pnpm audit found (docs/security/analytics.md, plan/analytics.md section 9) · short lane · from user · 2026-10-28 · **Reviewed**

- implementation · DONE · by finn · 2026-10-28 · file: whats-done.md · note: 2026-10-28, Dependencies upgraded: next 15.5.28, sharp 0.35.5, zod 4.6.7 (T-013, deps-upgrade; D-022 amended, R-64)
- qa · PASS · by quinn · 2026-10-28 · file: docs/qa/deps-upgrade.md

## office-app · The office as a local web app: an animated floor of five rooms, each employee at a desk, chat with each, their board and inbox (plan/office-app.md) · short lane · from user · 2026-10-28 · **Approved**
