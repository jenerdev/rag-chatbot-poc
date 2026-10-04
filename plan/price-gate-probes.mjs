// price-gate-probes.mjs — D-093: a price question about something that is
// not the stay must not get the rate card. Run from packages/rag:
//   node --conditions=react-server --env-file=../../.env ../../plan/price-gate-probes.mjs
import { answerQuestion, loadTenant } from '../packages/rag/dist/index.js';
const PROBES = [
  ['villa', 'How much is parking?'],
  ['villa', 'How much is coke zero'],
  ['villa', 'how much is videoke'],
  ['villa', 'Magkano po?'],
  ['harbor', 'How much?'],
  ['villa', 'How much is the security deposit?'],
];
for (const [slug, message] of PROBES) {
  const tenant = await loadTenant(slug);
  const a = await answerQuestion({ tenant, conversationId: null, message });
  console.log(`=== ${slug} · ${message}\nrefused: ${a.refused} · rate card: ${/\|---/.test(a.reply)}\n${a.reply.split('\n')[0]}\n`);
}
