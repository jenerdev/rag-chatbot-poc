// prompt-eval.mjs — a fixed battery for judging a system-prompt change.
//
// Phase 5.5 showed the grounding instruction is the thing preventing
// hallucination, so any edit to it has to be judged on BOTH directions at once:
//
//   - is it still refusing things that are genuinely absent?   (safety)
//   - has it stopped refusing things that are genuinely there?  (usefulness)
//
// Run it before the change and after, and compare the two outputs.
// Env comes from --env-file, so dotenv is gone. The other flag matters more:
// --conditions=react-server is REQUIRED, because the pipeline imports @rag/db,
// which is marked server-only and refuses to load in a plain Node process.
// Both flags live in this package's `eval` script — run it with pnpm, not node.
import { answerQuestion, NO_ANSWER } from '../dist/index.js';

const label = process.argv[2] ?? 'unlabelled';

// Each case says what SHOULD happen, so the output can be read at a glance.
const CASES = [
  {
    id: 'direct',
    want: 'answer',
    turns: ['What temperature does the Bay 3 freezer run at?'],
    expect: 'minus 68',
  },
  {
    id: 'inference',
    want: 'answer',
    turns: ['Who do I contact on extension 4417?'],
    expect: 'liaison',
    note: 'context says "...liaison, currently reachable at extension 4417"',
  },
  {
    id: 'antecedent',
    want: 'answer',
    turns: [
      'What colours are the visitor badges and what does each one mean?',
      'Which of those may not enter Bay 7?',
      'And what is the escort ratio for that group?',
    ],
    expect: 'three',
    note: 'violet = prospective staff -> ratio is 1 per 3, NOT the auditor 1:1',
  },
  {
    id: 'absent',
    want: 'refusal',
    turns: ['What is the policy on laboratory safety goggles?'],
    note: 'same domain, fact is NOT in the corpus - must still refuse',
  },
  {
    id: 'offtopic',
    want: 'refusal',
    turns: ['What is the capital of France?'],
    note: 'must refuse; also short-circuits before OpenAI',
  },
  {
    id: 'absent-2',
    want: 'refusal',
    turns: ['How many parking spaces does the building have?'],
    note: 'plausible facility question, absent from the corpus',
  },
];

console.log('='.repeat(78));
console.log('PROMPT EVAL:', label);
console.log('='.repeat(78));

let pass = 0;
for (const c of CASES) {
  let conversationId = null;
  let last = null;
  for (const turn of c.turns) {
    last = await answerQuestion({ conversationId, message: turn });
    conversationId = last.conversationId;
  }

  const refused = last.reply.trim() === NO_ANSWER;
  const reply = last.reply.replace(/\n/g, ' ');

  let ok;
  if (c.want === 'refusal') ok = refused;
  else ok = !refused && (!c.expect || reply.toLowerCase().includes(c.expect.toLowerCase()));
  if (ok) pass++;

  console.log(`${ok ? 'PASS' : 'FAIL'}  [${c.id}] want ${c.want}`);
  console.log(`      Q: ${c.turns[c.turns.length - 1]}`);
  if (c.note) console.log(`      note: ${c.note}`);
  console.log(`      A: ${reply.slice(0, 170)}`);
  console.log();
}

console.log(`${pass}/${CASES.length} as intended`);
