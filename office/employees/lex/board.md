# lex's board

Written by `node office/office.mjs task …` only (Rule 3). Newest last.

## Doing

## Inbox

## Done

- T-008 · 2026-10-28 · from user · **Advice before the architecture: Q3 and Q9 of docs/requirements/analytics.md for GA4** · why: The user chose GA4 at gate 2 (2026-10-28). Rhea asked Q3 (consent under RA 10173, the cross-border transfer, the consent lifetime, the retention bound, the words replacing 'Guests are given no cookies' at lib/legal.ts:95, the controller under one platform account) and Q9 (GPC and DNT) in M-004. Answer them in docs/legal/analytics.md marked as advice, not your legal gate (that follows implementation), and message rhea and theo. Rule 7: spend nothing · idea: analytics · done 2026-10-28: docs/legal/analytics.md (ADVICE, no gate). Q3: GA4 needs prior opt-in consent (FR-006-008 stand); it is a cross-border transfer (privacy words + Google GA DPA terms + tenant DPA); the choice is kept 180 days and re-asked on a policy_version change; retention is GA4's shortest (~2 months) and FR-024 is revised; the line 95 replacement is drafted; the tenant is controller only on its recorded instruction, and the operator's own use is aggregates only. Q9: GPC/DNT count as Decline. LQ-1..9 for a lawyer. M-008 to rhea, M-009 to theo. Spent nothing.

## Dropped
