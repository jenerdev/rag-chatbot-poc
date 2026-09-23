// prompt-snapshot.mjs — print the exact messages buildPrompt() produces for a tenant.
//
// Bookings plan (plan/bookings.md) Rule 1: adding tools must not change a
// single byte of the prompt for a tenant that has none. The battery measures
// behaviour; this measures the string, so a diff can prove "unchanged" rather
// than a verdict count implying it.
//
// The chunks and history are FIXED here, not retrieved. Retrieval goes through
// an embedding call and the live database, so its output can drift for reasons
// that have nothing to do with the prompt. Only the tenant row is read, because
// the persona line is built from it.
//
//   pnpm --filter @rag/pipeline prompt-snapshot [slug]   (default: northwind)

import { buildPrompt, loadTenant } from '../dist/index.js';

const slug = process.argv[2] ?? 'northwind';
const tenant = await loadTenant(slug);
if (!tenant) {
  console.error(`No tenant "${slug}"`);
  process.exit(1);
}

const chunks = [
  { content: 'The Quiet Hour runs from 2 PM to 3 PM every weekday.' },
  { content: 'The facilities liaison is currently reachable at extension 4417.' },
];
const history = [
  { role: 'user', content: 'When is the Quiet Hour?' },
  { role: 'assistant', content: 'From 2 PM to 3 PM every weekday.' },
];
const question = 'Who do I contact on extension 4417?';

process.stdout.write(JSON.stringify(buildPrompt(tenant, chunks, history, question), null, 2) + '\n');
