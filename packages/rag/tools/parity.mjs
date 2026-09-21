// parity.mjs — does the TypeScript pipeline behave exactly like rag.js?
//
// Phase 4's verification is meant to be `pnpm eval` matching the Phase 0
// baseline. There is no baseline (the corpus swap was deferred) and the OpenAI
// key is invalid, so that comparison cannot run yet.
//
// This is what CAN be proved today, and it is not nothing. It covers the two
// places where a porting mistake would be silent and expensive:
//
//   1. buildPrompt   — pure. A changed prompt is the one thing Phase 5.5
//                      measured as the difference between a grounded answer
//                      and a confident invention. Needs nothing but the CPU.
//   2. retrieve      — the RRF fusion, the threshold, the foundBy labelling
//                      (D-015). Needs the database, but NOT OpenAI: the query
//                      vector is an embedding already stored in a chunk row.
//
// Both are run against the old rag.js and the new @rag/pipeline with identical
// inputs, and the results compared exactly.
//
// What this does NOT cover, and what still needs the key: ingestDocument,
// rewriteQuestion, answerQuestion and answerQuestionStream. Their shared
// retrieval core is covered here; their model calls are not.
//
// Run:  pnpm --filter @rag/pipeline parity

import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');

const oldRag = await import(pathToFileURL(join(repoRoot, 'apps', 'legacy-poc', 'src', 'rag.js')).href);
const newRag = await import(pathToFileURL(join(here, '..', 'dist', 'index.js')).href);
const { supabase, parseStoredVector } = await import(
  pathToFileURL(join(repoRoot, 'packages', 'db', 'dist', 'index.js')).href
);

let checks = 0;
let failures = 0;

const same = (label, a, b) => {
  checks++;
  const ok = JSON.stringify(a) === JSON.stringify(b);
  if (!ok) {
    failures++;
    console.error(`\nDIFFERENT  ${label}`);
    console.error(`  old: ${JSON.stringify(a)?.slice(0, 300)}`);
    console.error(`  new: ${JSON.stringify(b)?.slice(0, 300)}`);
  }
  return ok;
};

// --- 1. The constants -------------------------------------------------------
// Frozen by plan/steps.md § 0. A drifted constant changes retrieval without
// changing a line of logic, which is the hardest kind of difference to spot.
console.log('constants');
for (const key of [
  'MATCH_COUNT',
  'CANDIDATE_COUNT',
  'RRF_K',
  'MIN_SIMILARITY',
  'MAX_HISTORY',
  'REWRITE_MAX_TOKENS',
  'NO_ANSWER',
]) {
  const ok = same(`  ${key}`, oldRag[key], newRag[key]);
  if (ok) console.log(`  PASS  ${key.padEnd(20)} ${JSON.stringify(newRag[key])}`);
}

// --- 2. buildPrompt, the correctness gate -----------------------------------
// Pure, so this needs neither the network nor the database.
console.log('\nbuildPrompt');
const promptCases = [
  {
    label: 'no chunks, no history',
    chunks: [],
    history: [],
    question: 'What is the capital of France?',
  },
  {
    label: 'one chunk, no history',
    chunks: [{ content: 'The Bay 3 freezer runs at minus 68 degrees Celsius.' }],
    history: [],
    question: 'What temperature does the Bay 3 freezer run at?',
  },
  {
    label: 'five chunks and a conversation',
    chunks: Array.from({ length: 5 }, (_, i) => ({ content: `Chunk ${i} says something.` })),
    history: [
      { role: 'user', content: 'Who is the Operations Director?' },
      { role: 'assistant', content: 'Marisol Venn.' },
    ],
    question: 'When did they join?',
  },
  {
    label: 'content with newlines, quotes and unicode',
    chunks: [{ content: 'Line one\n\n"quoted" — and an emoji 🎉\twith a tab' }],
    history: [{ role: 'user', content: 'Previous\nmessage' }],
    question: 'Why?',
  },
];

for (const { label, chunks, history, question } of promptCases) {
  const before = oldRag.buildPrompt(chunks, history, question);
  const after = newRag.buildPrompt(chunks, history, question);
  if (same(`  ${label}`, before, after)) {
    console.log(`  PASS  ${label} (${after.length} messages, ${after[0].content.length} chars of system)`);
  }
}

// --- 3. retrieve, the fusion --------------------------------------------------
// The query vector is an embedding already in the database, so no OpenAI call
// is made and the run is free. The text still varies, because the keyword half
// of the hybrid search reads the text and not the vector.
console.log('\nretrieve (live database, no OpenAI)');

const { data: seedChunks, error: seedError } = await supabase
  .from('chunks')
  .select('id, content, embedding')
  .limit(3);

if (seedError || !seedChunks?.length) {
  console.error(`  SKIPPED — could not read a seed chunk: ${seedError?.message ?? 'no rows'}`);
  failures++;
} else {
  const vector = parseStoredVector(seedChunks[0].embedding);

  const queries = [
    'What is the Wi-Fi password?',
    'extension 4417',
    'How many guests can stay?',
    'What is the capital of France?',
    '',
    'pool refill time and early check-in',
    seedChunks[0].content.slice(0, 80),
  ];

  for (const query of queries) {
    const before = await oldRag.retrieve(query, vector);
    const after = await newRag.retrieve(query, vector);

    const label = `  "${query.slice(0, 44)}${query.length > 44 ? '…' : ''}"`;
    if (same(label, before, after)) {
      console.log(
        `  PASS ${label.padEnd(50)} ${after.length} chunks ` +
          `[${after.map((c) => c.foundBy).join(' ')}]`,
      );
    }
  }

  // The same chunk searched with its own embedding must come back, and the
  // fusion must not reorder identical inputs differently between runs.
  const twice = await Promise.all([newRag.retrieve('stability check', vector), newRag.retrieve('stability check', vector)]);
  if (same('  fusion is deterministic', twice[0], twice[1])) console.log('  PASS  fusion is deterministic');
}

// --- 4. The database reads ----------------------------------------------------
console.log('\ndatabase reads');
same('  listDocuments', await oldRag.listDocuments(), await newRag.listDocuments());
console.log('  PASS  listDocuments');

const docs = await newRag.listDocuments();
if (docs.length > 0) {
  same('  getChunks', await oldRag.getChunks(docs[0].id), await newRag.getChunks(docs[0].id));
  console.log(`  PASS  getChunks (document ${docs[0].id}, ${(await newRag.getChunks(docs[0].id)).length} chunks)`);
}

const { data: conversation } = await supabase.from('conversations').select('id').limit(1).single();
if (conversation) {
  same('  getMessages', await oldRag.getMessages(conversation.id), await newRag.getMessages(conversation.id));
  console.log('  PASS  getMessages');
}

// --- verdict ------------------------------------------------------------------
console.log();
console.log(`${checks} comparisons, ${failures} differences`);
if (failures > 0) {
  console.error('\nPARITY FAILED — the TypeScript pipeline does not match rag.js.');
  process.exit(1);
}
console.log('\nPARITY OK — identical behaviour on everything reachable without an API key.');
console.log('Still unverified (needs OPENAI_API_KEY): ingestDocument, rewriteQuestion,');
console.log('answerQuestion, answerQuestionStream — and the eval battery itself.');
