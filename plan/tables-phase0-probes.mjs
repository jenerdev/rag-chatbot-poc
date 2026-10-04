// tables-phase0-probes.mjs — the six probe questions of plan/tables.md
// Phase 0, asked through answerQuestion() exactly as the chat route asks
// them, so the replies before any table exist are on record verbatim.
// Run from packages/rag:
//   node --conditions=react-server --env-file=../../.env ../../plan/tables-phase0-probes.mjs
import { answerQuestion, loadTenant } from '../packages/rag/dist/index.js';
import { localDate } from '../packages/bookings/dist/index.js';

const TODAY = localDate('Asia/Manila');
const plus = (n) => {
  const d = new Date(`${TODAY}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const words = (date) =>
  new Date(`${date}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
const FREE = plus(14); // the battery's FREE / H_FREE: nothing is ever seeded on it

const PROBES = [
  ['harbor', 'What rooms do you have?'],
  ['villa', 'What rooms do you have?'],
  ['harbor', `What rooms are open on ${words(FREE)}?`],
  ['villa', `What's open on ${words(FREE)}?`],
  ['villa', 'Room rates please'],
  ['harbor', 'Magkano ang extra guest?'],
];

console.log(`today ${TODAY} · FREE ${FREE}\n`);
for (const [slug, message] of PROBES) {
  const tenant = await loadTenant(slug);
  const a = await answerQuestion({ tenant, conversationId: null, message });
  console.log(`=== ${slug} · ${message}`);
  console.log(`refused: ${a.refused} · sources: ${a.sources.length} · tools: ${a.toolCalls.map((c) => `${c.name}${JSON.stringify(c.args)}`).join(', ') || 'none'}`);
  console.log(a.reply);
  console.log();
}
