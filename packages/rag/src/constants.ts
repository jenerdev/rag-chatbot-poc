// The tunable knobs, all in one place.
//
// `CLAUDE.md` § Conventions puts every constant at the top of its module in
// SCREAMING_SNAKE_CASE so the dials are findable. Splitting rag.js into five
// files would have scattered them, so they are collected here instead — one
// import away from every module that uses one, and one file to read when asking
// "what can I actually change?".
//
// Every value below was measured, not chosen. The evidence is in notes.md, and
// `plan/steps.md` § 0 freezes all of them for the duration of the migration:
// changing one during a port destroys the only way to prove the port worked.

// How many chunks to retrieve. Every one is pasted into the prompt and billed
// as input tokens on every turn, so this is a direct cost/quality dial.
// 5 × ~1000 chars is roughly 1,250 tokens — comfortable. Phase 5.4 tries 1 and 20.
export const MATCH_COUNT = 5;

// --- hybrid search (post-MVP, D-015) ---------------------------------------

// How many candidates each of the two searches contributes before fusion.
// Retrieving a few more than MATCH_COUNT gives the fusion something to choose
// between; the final list is still trimmed to MATCH_COUNT, so this costs
// database work but not a single extra prompt token.
export const CANDIDATE_COUNT = 10;

// The constant in Reciprocal Rank Fusion. 60 is the value from the original
// paper and is what almost everyone uses. Larger k flattens the difference
// between ranks; smaller k makes the top rank dominate.
export const RRF_K = 60;

// The "do I actually know this?" gate. Below this score, we refuse.
//
// Chosen from measured scores, not guessed (Q-1, roadmap 3.2). Measured on the
// Northwind test corpus with score-probe:
//
//     direct hits          0.46 – 0.54
//     paraphrased          0.40 – 0.45
//     exact identifier     0.28    <- "extension 4417"; vectors are weak here
//     completely off topic 0.04 – 0.10
//
// 0.25 sits in the wide empty gap between 0.10 and 0.28. The original 0.30
// guess would have rejected the "extension 4417" question, which IS answerable
// from the documents — a false refusal.
//
// Note what a threshold CANNOT do: "what is the policy on safety goggles?"
// scored 0.427 — squarely in direct-hit territory — even though the handbook
// never mentions goggles. Same domain, same vocabulary, absent fact. No
// threshold rejects that; only the system prompt's refusal instruction can.
// That is why D-008 calls the short circuit belt-and-braces, not the defence.
//
// This number is corpus-dependent. Re-measure if the documents change a lot.
export const MIN_SIMILARITY = 0.25;

// How many past messages to re-send. The model is stateless: the ENTIRE array
// is uploaded and re-billed on every single turn, so unbounded history makes
// cost grow with the square of conversation length (D-011, costs.md).
export const MAX_HISTORY = 6;

// How many of the user's own messages are scanned for an explicit language
// request ("Tagalog lang po", D-043). Scanned in code, never sent to the
// model, so this costs one small query and no tokens. It is a bound, not a
// quality dial: it only has to be longer than any real conversation, so that
// a request made at the start is still found at the end. Not measured.
export const LANGUAGE_SCAN_MESSAGES = 50;

// Longest a rewritten search query may be. The rewriter should produce one
// short question; anything longer means it started explaining itself instead,
// and we fall back to the original rather than searching with prose.
export const REWRITE_MAX_TOKENS = 60;

// --- tools (plan/bookings.md Phase 6) --------------------------------------

// How many rounds of tool calls one answer may make. A round is one model
// reply that asks for tools, then running them. Two means one call plus one
// retry, which is enough for "that date was in the past, try again". A model
// still asking after that is looping, and the answer fails loudly rather than
// spending more calls. Provisional: not measured yet.
export const MAX_TOOL_ROUNDS = 2;

// The exact refusal string. Defined once because two different code paths can
// produce it — the short circuit, and the model following its system prompt —
// and the UI should not be able to tell them apart.
export const NO_ANSWER = "I don't know based on the documents I have.";

// How many question embeddings the process remembers (embed-cache.ts): a
// vector is 1536 floats, about 12 KB as numbers, so 500 is a few megabytes
// and covers every suggested question of every tenant many times over. Least
// recently used goes first. Provisional: a cache this size has not been
// measured against a day's traffic, only reasoned about.
export const EMBED_CACHE_SIZE = 500;
