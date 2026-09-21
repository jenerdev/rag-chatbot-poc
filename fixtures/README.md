# fixtures/

Corpora that a **tool** depends on, as opposed to `sample-documents/`, which is
for testing by hand.

## `northwind.json`

The Northwind Labs Operations Handbook — 2,607 characters of invented facts,
the corpus every number in `notes.md` was measured against.

**Why it is committed.** `npm run eval` asserts on facts that exist only in this
document — the Bay 3 freezer temperature, extension 4417, the violet badge
escort ratio. Until 2026-09-21 the file lived only in `scratch/testdoc.json`,
and `scratch/` is gitignored. That meant the battery which `CLAUDE.md` names as
the gate on every `buildPrompt()` change depended on a file that was one
`git clean -fdx` away from being gone, and that no fresh clone of this repo ever
had.

It is 3 KB of made-up facts. There is no reason for it to live outside version
control.

## Loading it

```sh
curl -X POST http://localhost:3000/api/documents \
  -H 'Content-Type: application/json' \
  -d @fixtures/northwind.json
```

Both `npm run eval` and `npm run scores` assume this document is **the only**
thing in the database. A second corpus loaded alongside it does not just add
noise — it changes the verdicts. `sample-documents/03-amenities-and-facilities.md`
documents the resort's parking, so with both corpora loaded the eval case
`absent-2` ("How many parking spaces does the building have?") gets a real
answer and is scored a failure, when the refusal it was testing for is working
exactly as intended.

One corpus at a time.
