# Office UI: status

Rewritten 2026-10-28, after the merges. The first version listed the
merges as steps; they are done, so this one lists only what is left.

**In one line:** the dependency upgrade, the office app, Todd and George's
memory are all on master. What is left is the deploy check, the upgrade's
last two gates, and the older owed items.

## Done

| What | Where | Proof |
|---|---|---|
| Dependency upgrade (next 15.5.28, sharp 0.35.5, zod 4) | `21fb7a6`, merged, **pushed** | QA PASS, `docs/qa/deps-upgrade.md` |
| The office app (`pnpm office`) | merged in `cad5db1`, **pushed** | tests 43/43, the walk 16/16 |
| Todd, the Task Tracker | `37ec48c`, **pushed** | first run: 21 items, 0.89 USD |
| George is the office's memory; chats show no Bash commands | `d853a77`, merged, **not pushed** | office tests 48/48 |
| T-014 (build the office app) | Finn's board, done | |

## What you do next, in order

1. **Check the deploy.** Open any page of the live site. Its footer
   should say "Build cad5db1" or newer, which means the critical `next`
   advisory is gone from production. If it shows an older build, start a
   production deploy from the Vercel dashboard.
2. **Sage's security review of the upgrade (T-016).** In the office,
   click Sage and send "do T-016". It covers the three postcss highs
   (R-64) and the new list caps.
3. **Accept R-64** once Sage has spoken, if you agree:
   `node office/office.mjs gate deps-upgrade security --by user --verdict ACCEPTED --note "postcss highs: build-time only, R-64"`
4. **Let Quinn write the release gate** for deps-upgrade. She expects
   READY WITH DOCUMENTED RISKS. Then mark it released:
   `node office/office.mjs gate deps-upgrade released --by user --verdict RELEASED`
5. **Push `d853a77`** when you like (`git push origin master`). It changes
   the office only, not the site.
6. **Tidy:** the branches `fix/deps-upgrade`, `feat/office-app` and
   `feat/george-memory` are fully merged and can be deleted.

## Still open on the boards

- **Sage, T-016:** step 2 above.
- **Quinn, T-017:** refresh `plan/booking-types-phase3-walk.mjs` to the
  request shapes the staff routes take since D-111. It is not caused by
  the upgrade.

## Owed from before, still yours

- **free-guest-field:** type 18 into the platform form's "Children stay
  free up to age" and look at the browser's warning bubble once, then
  `node office/office.mjs gate free-guest-field released --by user --verdict RELEASED`.
- **office-app:** on the pipeline it is still "Approved" with no gates.
  You can record `implementation` and `qa`, or leave it.
- **analytics:** on hold by your choice. Gates 1 to 5 stand; Finn starts
  from `plan/analytics.md` Phase 0 when you resume it.
- Grade George's ten answers (`plan/ai-employees/phase3/q1.json`).
- Install Python, so the security-guidance plugin's hooks run.
- The `/mcp` logins: GitHub needs `GITHUB_PERSONAL_ACCESS_TOKEN` set in
  your environment (it is empty, hence the HTTP 400), and Supabase.
