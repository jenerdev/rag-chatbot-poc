// booking-types-phase6-rows.mjs — what a room-availability row costs in the
// prompt, so MAX_AVAILABILITY_ROWS is set from a measurement (plan § 2.6,
// R-26), not chosen.
//
// The first version asked the chatbot about ranges and read the token count
// of its answer call. It measured nothing: for "from X to Y", D-046's date
// resolver checked the two end dates separately, and the model never asked for
// the range, so 7, 14 and 31 days all came back as 8 rows (recorded in
// plan/baseline/rows-booking-types-phase6.txt, and in the Phase 6 record).
//
// So this measures the RESULT itself. It runs the real executeTool() for
// harbor over 1, 7, 14 and 31 days, then sends exactly that tool content to
// the chat model (max 1 output token) and reads the input-token count
// OpenAI reports. The difference, divided by the difference in rows, is the
// cost of one row. Five tiny calls, a fraction of a cent.
//
//   cd packages/rag && node --conditions=react-server --env-file=../../.env ../../plan/booking-types-phase6-rows.mjs

import { chat } from '../packages/openai/dist/index.js';
import { executeTool, loadTenant } from '../packages/rag/dist/index.js';
import { localDate, MAX_AVAILABILITY_ROWS } from '../packages/bookings/dist/index.js';

const harbor = await loadTenant('harbor');
const plus = (n) => {
  const d = new Date(`${localDate('Asia/Manila')}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

const realLog = console.log;
let lines = [];
console.log = (...args) => lines.push(String(args[0] ?? ''));

/** Input tokens OpenAI counts for one user message holding `text`. */
async function inputTokens(text) {
  lines = [];
  await chat([{ role: 'user', content: text }], { maxTokens: 1, label: 'rows' });
  return Number(/rows: (\d+) in/.exec(lines.find((l) => l.startsWith('[openai] rows:')) ?? '')?.[1]);
}

const empty = await inputTokens('');
const results = [];
for (const days of [1, 7, 14, 31]) {
  const args = { date_from: plus(40), ...(days > 1 ? { date_to: plus(40 + days - 1) } : {}) };
  const { record, content } = await executeTool(harbor, { id: 'probe', name: 'check_availability', arguments: JSON.stringify(args) });
  const rows = record.result?.slots?.length ?? 0;
  results.push({ days, rows, chars: content.length, tokens: (await inputTokens(content)) - empty, error: record.result?.error });
}
console.log = realLog;

for (const r of results) {
  console.log(`${String(r.days).padStart(2)} days: ${String(r.rows).padStart(3)} rows, ${String(r.chars).padStart(6)} chars, ${String(r.tokens).padStart(5)} tokens${r.error ? `  error: ${r.error}` : ''}`);
}
const one = results[0];
const month = results.at(-1);
const perRow = (month.tokens - one.tokens) / (month.rows - one.rows);
console.log(`≈ ${perRow.toFixed(1)} tokens per row; MAX_AVAILABILITY_ROWS ${MAX_AVAILABILITY_ROWS} ≈ ${Math.round(MAX_AVAILABILITY_ROWS * perRow)} tokens`);
