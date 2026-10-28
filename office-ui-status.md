# Office UI: status

Written 2026-10-28 by Claude. It is the answer to "implement all the
phase defined on the plan … log all the phase done or phase not complete
… put here what should i do next".

**In one line:** every phase of [`plan/office-app.md`](./plan/office-app.md)
is done and committed on branch **`feat/office-app`**. Nothing is merged
or pushed, because merging is yours.

## Where the work is

- **The branch:** `feat/office-app`, 6 commits on top of master, in a git
  worktree at `.worktrees/office-app/` (inside this folder, ignored by git).
- **This folder's checkout is on `fix/deps-upgrade`.** That is Finn's
  dependency upgrade (next, sharp, zod), with its changes not committed.
- **This file** is not committed. It sits in the main folder so you see it
  first.

## The phases

| Phase | What | Status | Evidence |
|---|---|---|---|
| 0 | The `claude` CLI contract, measured as George | ✅ Done | `plan/office-app/phase0.md`, 5 real runs, 1.37 USD |
| 1 | `office.mjs`: one lock around every writer, `snapshot()`, the session index | ✅ Done | `office.test.mjs` 25/25 (two racing processes → 40 distinct ids) |
| 2 | The local server: token, Host and Origin checks, chat over SSE, Stop, the queue, the daily cap | ✅ Done | `server.test.mjs` 15/15 on a fake `claude`, nothing spent |
| 3 | The animated floor: five rooms behind glass, each employee seated at a desk with a laptop | ✅ Done | the walk; shots in `plan/office-app/walk/` |
| 4 | The panel: Chat, Board (drag and menu), Inbox | ✅ Done | the walk 16/16, three runs in a row; axe 0 violations on 7 states |
| 5 | One real day with the real `claude` | ✅ Done | `plan/office-app/phase5.md`: 8/8 on run 2 |
| 6 | The record: D-153, R-65, CLAUDE.md, status.md, whats-done.md, office/README.md | ✅ Done | on the branch |

**Tests:** `node --test office/office.test.mjs office/app/server.test.mjs office/app/text.test.mjs`
passes 43/43, and `node office/office.mjs check` is green.

**Spent on real `claude` calls:** about 4.3 USD in all.
- Phase 0: 1.37
- Phase 5 run 1: 0.97
- Phase 5 run 2: 1.67
- One debug turn: 0.31

## Nothing blocked a phase, but one finding matters beyond this app

**Claude Code silently ignores an agent file with Windows line endings
(CRLF) when its description contains `": "`.**
- It hit **seven of the ten employees**: everyone but George, Rhea and Uma.
- Phase 5's first run failed because of it, with `--agent 'ivy' not found`.
- Any fresh Windows clone with `core.autocrlf=true` would have the same
  problem.
- **Fixed on the branch:** a `.gitattributes` keeps those files LF, and
  `office:check` now names a CRLF agent file.
- **Master does not have the fix until you merge.** Your current
  checkout's agent files are LF, so they work today.

## What you do next, in order

1. **Wait for Quinn (QA) to finish the dependency upgrade.** She was
   still running when this was written. Her verdict lands in
   `docs/qa/deps-upgrade.md`; the outcome section below says what it was.
2. **Merge the dependency upgrade first.** It closes a CRITICAL advisory in
   `next` (15.5.25 → 15.5.28) on the live site:
   ```sh
   git add -A && git commit -m "fix(deps): next 15.5.28, sharp 0.35.5, zod 4 (deps-upgrade)"
   git switch master && git merge fix/deps-upgrade
   git push      # then deploy on Vercel
   ```
   Read Finn's notes first. **zod went from 3 to 4**, a major version,
   because no 3.x release has the fix; he showed that every message a
   person sees is unchanged across 32,673 inputs. **Three high advisories
   remain** in postcss, which `next` pins (R-64): moving to next 16 or
   forcing postcss is your call.
3. **Merge the office app:**
   ```sh
   git merge feat/office-app
   ```
   Expect small conflicts in `status.md`, `whats-done.md`, `decisions.md`,
   `risks.md` and `CLAUDE.md`. Both branches added entries at the ends of
   those files, so keep both sides. The numbers do not collide: the
   upgrade is R-64, the office app is D-153 and R-65.
4. **Open the office:**
   ```sh
   pnpm office
   ```
   Open the URL it prints. The token is in the URL, so do not share it.
   Every chat is a real `claude --agent` turn and costs money, about
   0.30 USD for a short one. The top bar shows today's spend against
   `OFFICE_DAILY_USD` (default 10 USD), and the page asks before going over.
5. **Then remove the worktree:**
   ```sh
   git worktree remove .worktrees/office-app
   ```

## Owed from before, still yours

- **free-guest-field:** type 18 into the platform form's "Children stay
  free up to age" and look at the browser's warning bubble once. Then
  mark it released:
  `node office/office.mjs gate free-guest-field released --by user --verdict RELEASED`.
- **analytics:** gate 5 is approved, and Finn builds it next on
  `feat/analytics`.
- Grade George's ten answers (`plan/ai-employees/phase3/q1.json`).
- Install Python, so the security-guidance plugin's hooks run.
- The `/mcp` logins for GitHub and Supabase. You skipped Context7.

## Dependency upgrade: outcome

Quinn finished at 09:05. Her report is `docs/qa/deps-upgrade.md`.

- **The upgrade:** Finn, 6.18 USD. `next` 15.5.28, `sharp` 0.35.5, `zod`
  4.6.7. `pnpm audit --prod` went from 1 critical and 6 high to 0
  critical and 3 high. The three highs are in postcss, which next pins
  (R-64).
- **QA: PASS.** Quinn, 3.22 USD.
  - `pnpm test` 810/810, typecheck 13/13, verify 243/243, rooms 57/57.
  - The app icon (sharp) 8/8.
  - Her new `plan/deps-upgrade-walk.mjs` 101/101: every error message is
    word for word what it was before zod 4, and 100,000 rooms are refused
    in ~350 ms.
  - Six existing walks all pass.
- **One walk failed, but not because of this change:**
  `booking-types-phase3-walk` passed 6 and failed 5. It still sends
  fields the staff routes stopped accepting before the upgrade. Quinn put
  fixing it on her own board as T-017.
- **The release gate is not written yet, on purpose.** Quinn's charter
  puts it after Sage's security gate (T-016 on Sage's board: whether to
  accept R-64, and the new list caps). It also needs your acceptance of
  the three postcss highs. Her recommendation once those are settled is
  **READY WITH DOCUMENTED RISKS**.

**So step 2 above becomes:**
1. Run Sage's T-016:
   `claude --agent sage`, then "do T-016"; or open `pnpm office` once it
   is merged and click Sage.
2. Accept R-64:
   `node office/office.mjs gate deps-upgrade security --by user --verdict ACCEPTED --note "postcss highs: build-time only, R-64"`.
3. Let Quinn write the release gate.
4. Commit, merge, push and deploy.

The critical advisory in `next` is live on Vercel until you deploy. If
you would rather not wait for the gates, the commit and merge in step 2
are safe to do now: QA has passed.

## One more thing to tidy

The pipeline's `office-app` idea still says **Approved**, and Finn's task
T-014 ("Build plan/office-app.md") is still on his board. I built it
myself instead, on `feat/office-app`, because you asked me to implement
it directly. Once it is merged, close the task:

```sh
node office/office.mjs task move T-014 dropped --note "built directly by Claude on feat/office-app, D-153"
```

You can also record its gates (`implementation`, then Quinn's `qa`), or
just leave it as is.
