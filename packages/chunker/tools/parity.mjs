// parity.mjs — does the TypeScript chunker produce EXACTLY what the JS one did?
//
// This is the whole verification for Phase 2 of the migration. The chunker is
// the only module in the pipeline whose output can be compared character for
// character without spending a penny or touching the network, which is why it
// was ported first.
//
// A chunk boundary that moves by one character changes what gets embedded,
// which changes every similarity score downstream. That would show up in Phase 4
// as a drifted eval score with no obvious cause — days later, and nowhere near
// the change that caused it. Cheaper to prove it here.
//
// Run:  pnpm --filter @rag/chunker parity        (after `pnpm --filter @rag/chunker build`)

import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');

// pathToFileURL, not the bare path: on Windows an absolute path starts with a
// drive letter, and `import('C:/...')` is read as a URL with the scheme "c:".
const oldChunker = await import(
  pathToFileURL(join(repoRoot, 'apps', 'legacy-poc', 'src', 'chunker.js')).href
);
const newChunker = await import(pathToFileURL(join(here, '..', 'dist', 'index.js')).href);

// Every real document in the repo, plus the shapes that exercise the branches
// no real document happens to hit.
const corpus = [];

const sampleDir = join(repoRoot, 'sample-documents');
for (const name of (await readdir(sampleDir)).filter((f) => /^\d\d-.*\.md$/.test(f))) {
  corpus.push({ name, text: await readFile(join(sampleDir, name), 'utf8') });
}

const fixture = JSON.parse(await readFile(join(repoRoot, 'fixtures', 'northwind.json'), 'utf8'));
corpus.push({ name: 'fixtures/northwind.json', text: fixture.content });

corpus.push(
  { name: 'synthetic: empty', text: '' },
  { name: 'synthetic: whitespace only', text: '   \n\n  \t \n ' },
  { name: 'synthetic: shorter than one chunk', text: 'A single short sentence.' },
  // The D-018 fallback: no blank lines anywhere, so paragraph splitting cannot
  // help and the sliding window has to take over.
  { name: 'synthetic: one unbroken wall', text: 'x'.repeat(3500) },
  // The heading-plus-long-body shape the chunker has a special case for.
  { name: 'synthetic: heading + oversized paragraph', text: `# Refund Policy\n\n${'word '.repeat(400)}` },
  // Paragraphs just under the ceiling, which is where the overlap gets dropped.
  { name: 'synthetic: six 300-char paragraphs', text: Array.from({ length: 6 }, (_, i) => `${i} ${'y'.repeat(298)}`).join('\n\n') },
  { name: 'synthetic: CRLF line endings', text: '# Title\r\n\r\nFirst paragraph.\r\n\r\nSecond paragraph.' },
  { name: 'synthetic: unicode', text: `Héllo wörld — ${'é'.repeat(1200)}\n\nSecond ¶ with emoji 🎉 and a tab\there.` },
);

// Not just the defaults. 300/50 and 4000/150 are the configurations Phase 5
// measured (notes.md § 5.1), so they are the ones most likely to be tried again.
const configs = [
  { label: 'defaults (1000/150)', args: [] },
  { label: '300/50', args: [300, 50] },
  { label: '4000/150', args: [4000, 150] },
  { label: '1000/0 (no overlap)', args: [1000, 0] },
];

let comparisons = 0;
let differences = 0;

for (const { label, args } of configs) {
  for (const { name, text } of corpus) {
    const before = oldChunker.chunkText(text, ...args);
    const after = newChunker.chunkText(text, ...args);
    comparisons++;

    if (JSON.stringify(before) !== JSON.stringify(after)) {
      differences++;
      console.error(`\nDIFFERENT  [${label}]  ${name}`);
      console.error(`  old: ${before.length} chunks, lengths ${before.map((c) => c.length).join(',')}`);
      console.error(`  new: ${after.length} chunks, lengths ${after.map((c) => c.length).join(',')}`);
      const i = before.findIndex((c, n) => c !== after[n]);
      if (i !== -1) {
        console.error(`  first divergence at chunk ${i}:`);
        console.error(`    old: ${JSON.stringify(before[i]?.slice(0, 120))}`);
        console.error(`    new: ${JSON.stringify(after[i]?.slice(0, 120))}`);
      }
    }
  }
}

// The estimate the admin page renders while you type. It is only arithmetic,
// but it is arithmetic the user sees.
for (const { name, text } of corpus) {
  const before = oldChunker.estimateChunkCount(text.length);
  const after = newChunker.estimateChunkCount(text.length);
  comparisons++;
  if (before !== after) {
    differences++;
    console.error(`DIFFERENT  [estimateChunkCount]  ${name}: old ${before}, new ${after}`);
  }
}

// The constants are compared too. A chunker that behaves identically but
// exports CHUNK_SIZE = 900 would pass every test above and quietly re-chunk
// every document the next time something imported the constant instead.
for (const key of ['CHUNK_SIZE', 'CHUNK_OVERLAP']) {
  comparisons++;
  if (oldChunker[key] !== newChunker[key]) {
    differences++;
    console.error(`DIFFERENT  [${key}]: old ${oldChunker[key]}, new ${newChunker[key]}`);
  }
}

console.log();
console.log(`${corpus.length} documents x ${configs.length} configurations + estimates + constants`);
console.log(`${comparisons} comparisons, ${differences} differences`);
console.log();

if (differences > 0) {
  console.error('PARITY FAILED — the TypeScript chunker does not match the original.');
  process.exit(1);
}
console.log('PARITY OK — byte-identical output.');
