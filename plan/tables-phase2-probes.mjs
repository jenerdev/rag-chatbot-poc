// tables-phase2-probes.mjs — plan/tables.md Phase 2's probes: the code-written
// tables. The D-087 question that the model answers "Which date?" (so the
// list is written in code), and the undated price question that D-081
// answered with one sentence and now gets the rate card, in three languages.
// Run from packages/rag:
//   node --conditions=react-server --env-file=../../.env ../../plan/tables-phase2-probes.mjs
import { answerQuestion, loadTenant } from '../packages/rag/dist/index.js';

const PROBES = [
  ['harbor', 'What rooms are available?'],
  ['harbor', 'Anong mga kwarto ang bakante?'],
  ['villa', 'Room rates please'],
  ['harbor', 'Room rates please'],
  ['villa', 'Magkano po ang rates niyo?'],
  ['villa', 'Magkano po ang security deposit?'],
];

for (const [slug, message] of PROBES) {
  const tenant = await loadTenant(slug);
  const a = await answerQuestion({ tenant, conversationId: null, message });
  console.log(`=== ${slug} · ${message}`);
  console.log(`refused: ${a.refused} · sources: ${a.sources.length} · tools: ${a.toolCalls.map((c) => `${c.name}${JSON.stringify(c.args)}`).join(', ') || 'none'} · table: ${/\|---\|/.test(a.reply)}`);
  console.log(a.reply);
  console.log();
}
