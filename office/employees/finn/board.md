# finn's board

Written by `node office/office.mjs task …` only (Rule 3). Newest last.

## Doing

## Inbox

- T-005 · 2026-10-28 · from quinn · **Record says 'Bookings tab' for the free-guest field; it is the Applications tab, Bookings card (LOW, wording)** · why: idea free-guest-field, QA docs/qa/free-guest-field.md D-1. Steps: (1) /platform as a super user, open any tenant; (2) the tabs are Profile / Applications / Members / ... - there is no 'Bookings' tab; (3) Applications tab -> Bookings card -> Limits -> 'Children stay free up to age' (#bk-free, tenant-form.tsx:654). The record says 'Bookings tab' at CLAUDE.md:400, decisions.md:4722 (D-147), plan/free-guests.md:39 and :182. Expected: 'the Applications tab (Bookings card)'. Your M-006 item 1 already noticed it; this is the task to fix the four lines. Not blocking release; no code.
- T-013 · 2026-10-28 · from user · **Short lane: bump next past GHSA-2464-fhr4-w9xw (critical), sharp and zod past their highs** · why: Sage's pnpm audit --prod on 2026-10-28 (plan/analytics.md section 9): next 15.5.25 critical GHSA-2464-fhr4-w9xw fixed in 15.5.28, also high GHSA-p3m5-59mp-jv5r. sharp 0.35.4 high GHSA-wq5f-xc86-pv6w (app-icon.png runs it on a tenant logo). zod 3.25.76 high GHSA-mrhx-c7xc-m3w5. The app is live on Vercel. The user made it its own task at gate 5 and it comes BEFORE analytics Phase 0. Re-run web tests, typecheck, pnpm build with dev NOT running (trap 16), verify, rooms, the three chatbot baselines, and pnpm audit --prod with its count. A high that cannot be bumped goes in risks.md with its reason. Then the record, the implementation gate, and a task to quinn. Rule 7: no eval, no OpenAI. No commit · idea: deps-upgrade

## Done

- T-002 · 2026-10-27 · from george · **Short lane: the platform form's free-guest field seen ON SCREEN (Bookings tab, Limits, 'Children stay free up to age')** · why: status.md:65 ('Owed: the platform form's field on screen (checked over HTTP)') and whats-done.md:10047. plan/free-guests.md section 3.3 names the field, and Phase 3 ('the platform field, the walk') is where it belongs. plan/free-guests/ holds party-staff-alteza-1280.png but no platform shot. The dev server is running at http://localhost:3000. QA (quinn) follows on gate 7. Rule 7: no eval, no OpenAI, no voice · idea: free-guest-field · done 2026-10-28: platform-walk 4/4 (1 run); 5 shots at 1280/375; no code changed, so no suite run (web tests, typecheck not run); no OpenAI; 0 throwaways left

## Dropped
