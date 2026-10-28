---
name: project-record
description: How this repository keeps its record (status.md, whats-done.md, decisions.md, risks.md, CLAUDE.md) when a step finishes — the shapes, the rules, and what George audits. Preloaded by the Full-Stack Engineer and the QA Engineer; from CLAUDE.md "Keeping the record", not a second wording of it.
---

# Keeping the record

CLAUDE.md, "Keeping the record", verbatim:

> When any meaningful step finishes, update **both** files in the same turn:
>
> | File | Answers | What to add |
> |---|---|---|
> | `status.md` | *What do I do next?* | Tick it, rewrite "▶ Next up", append to the session log |
> | `whats-done.md` | *What did I just do, and why did it matter?* | What was done, why, what each observed value proves, what trap it avoided |
>
> - **Record real observed values** — token counts, similarity scores, versions,
>   error text. Never predicted ones.
> - **Record deviations with their reasoning.** If a step contradicts a logged
>   decision, amend `decisions.md` too. D-014's reversal is the worked example.
> - **Verify the effect, not the exit code.** "The command succeeded" is not "the
>   effect happened".

## The shapes, as the record already writes them

**A `whats-done.md` entry** is appended at the end, one `##` heading per
step, dated, with the D-number when there is one, and bullets in this
order (omit a bullet that has nothing to say):

```
## 2026-10-27 · <what, in a sentence> (D-NNN)

- **Asked:** the user's words, quoted.
- **What:** what was done, file by file, in words; the ONE place a thing lives.
- **Observed:** every number as it was read: tests N, typecheck N/N, verify N/N, rooms N/N, the walk N/N, ms, tokens, USD; error text verbatim.
- **Why <the alternative> not:** the road not taken and the measured reason.
- **Trap:** what bit, and the rule it taught.
- **Skipped / Left / Owed:** what was not done and why; what waits on whom.
```

**`status.md`'s "▶ Next up"** takes a NEW bold paragraph at the top of the
section for the step ("**<Thing> (<date>, D-NNN, done[, walk included]):**
…"), ending with "Not committed." or the commit, what is owed, and
"**Next:** …". The session log at the bottom gets a dated `###` entry with
Did / Tried and dropped / Trap / Observed / Next bullets.

**A decision** is a `## D-NNN · <title> · **Added <date>**` section at
the end of `decisions.md`: **Decision:** in a paragraph, the reasons as
bullets, **Measured:** with observed values, and **Reverse if:** naming
what would undo it. An amendment to an older decision is written under
that decision as "**Amended <date>:**", and the dated list in CLAUDE.md
says "(D-NNN amended)".

**A risk** is `## R-NN · <title> · **<status>**` in `risks.md`; closing
one changes its status heading to "**Closed <date> (D-NNN): …**", because
`office.mjs index` reads the heading and nothing else.

**CLAUDE.md** gets one paragraph in the dated list at the top for a
feature ("**<Thing>** since <date> (D-NNN, [`plan/<x>.md`], Phases …)"),
and a line in the Layout tree for a new file that someone will need to
find.

## The rules the office adds

- **The doer writes, George audits** (plan/ai-employees.md Rule 2, q5):
  the employee who built the thing writes these files in the same turn;
  George reads them and moves the task to done, or says what is missing.
- **The implementation gate points at the entry:** `node office/office.mjs
  gate <slug> implementation --by <me> --verdict DONE --file whats-done.md
  --note "<the entry's heading>"`, written AFTER the entry exists (Rule 10).
- **Numbers on the board:** the suites' results also go into the task's
  closing note (`task move <id> done --note "tests 243, typecheck 13/13,
  walk 5/5"`), observed, never predicted; a test not run is "not run",
  never "passed".
- **The three chatbot baselines** (`plan/baseline/`) are diffed whenever
  the task said the chatbot is untouched, and the entry says
  "byte-identical" only after the diff.
- **A commit is the user's** (Rule 8): the entry ends "Not committed."
