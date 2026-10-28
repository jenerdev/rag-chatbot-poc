# sage's board

Written by `node office/office.mjs task …` only (Rule 3). Newest last.

## Doing

## Inbox

- T-016 · 2026-10-28 · from finn · **Security review of deps-upgrade: the remaining audit highs (R-64) and the new list caps** · why: whats-done.md entry '2026-10-28, Dependencies upgraded: next 15.5.28, sharp 0.35.5, zod 4.6.7 (T-013, deps-upgrade; D-022 amended, R-64)'. pnpm audit --prod 11 -> 5: 0 critical, 3 high, 2 moderate, all next 15.5.28's pinned postcss 8.4.31 / source-map-js 1.2.1, accepted in R-64 as build-time only. Your word wanted on that acceptance and on the options (next 16, or a pnpm.overrides). Also: route input validation changed library major (zod 3 -> 4); five lists gained a .max() so zod 4.6.6 refuses before parsing (rooms 10, days 100, methods 5, cancellation 5, rates 100). Code: apps/web/lib/schemas.ts. · idea: deps-upgrade

## Done

- T-011 · 2026-10-28 · from theo · **Security review of plan/analytics.md (gate 5): CONCERNS or CLEAR** · why: Gate 5 SUBMITTED 2026-10-28. Review before the user reads it: Rule 1 (nothing from Google before Allow, no Consent Mode), Rule 3's two walls (tenant_public() returns analytics_id only while on), § 2.3/2.4 (a Link keeps gtag and the first document's CSP: ga-disable + staff links as <a>), § 2.5 per-tenant cookie_prefix, § 4.7 the CSP for every page (R-55; 'unsafe-inline' scripts without a nonce, § 7 q4), Phase 6's walk aborting every hit. Every GA4 fact is [unverified] (R-63). Rule 7: spend nothing · idea: analytics · done 2026-10-28: CONCERNS: 3 MEDIUM, 4 LOW, 4 INFO in docs/security/analytics.md; gate recorded; theo messaged
- T-012 · 2026-10-28 · from theo · **Re-review plan/analytics.md, gate 5 round 2: CONCERNS or CLEAR** · why: plan/analytics.md section 8.1 answers each of your concerns with a phase step and a check, and declines none. S-A1: frame-src 'self' blob: Supabase in the base CSP, and csp-walk opens both PDF proofs. S-A2: StaffFrame reloads a document that held analytics, plus walk 11b with router.push. S-A3: Viewer-only is Rule 9, Phase 0 row H, an R-61 row per property, and walk 8 follows S-6's ?ref= Link (R-U5 was declined by Rhea, D-1). S-A4: cookie_domain none, cookie_update false, the clear on every non-load decision on the host and the parent. S-A5: R-55 amended, not closed, with the GTM note. S-A6: a read-only host query in Phase 0, then narrow the check or list the host. S-A7: the loader is keyed on the ID. S-A8: the client regex. S-A9: all notes adopted. S-A10: Rule 2 and R-63. Also the audit bump in Phase 0 (section 9) and the anon key in verify 249. New since round 1, from Rhea: analytics_instructed_on (FR-028), a unique ID (FR-020), the version bumped on the FIRST switch-on only (section 2.7). Assumptions T-A1 to T-A6 are in section 7. · idea: analytics · done 2026-10-28: Round 2 reviewed: CLEAR. S-A1, S-A5 resolved; S-A2/3/4 partly (LOW); new S-A11 LOW, S-A12-15 INFO. docs/security/analytics.md Round 2; M-024 to theo.

## Dropped
