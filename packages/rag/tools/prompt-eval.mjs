// prompt-eval.mjs — a fixed battery for judging a system-prompt change.
//
// Phase 5.5 showed the grounding instruction is the thing preventing
// hallucination, so any edit to it has to be judged on BOTH directions at once:
//
//   - is it still refusing things that are genuinely absent?   (safety)
//   - has it stopped refusing things that are genuinely there?  (usefulness)
//
// Run it before the change and after, and compare the two outputs.
//
// TENANCY (plan.md Phase 4). Every case names its tenant. The six original
// cases ask northwind, in their original wording; their verdicts must match
// plan/baseline/eval-pre-tenancy.txt exactly. The four new cases need BOTH
// tenants loaded. They assert that a fact which is in the database, but in the
// other tenant, is unreachable. So CLAUDE.md rule 1's "northwind and nothing
// else" is no longer a precondition: the villa corpus now lives in its own
// tenant, and that is what the leak cases exist to test.
// Env comes from --env-file, so dotenv is gone. The other flag matters more:
// --conditions=react-server is REQUIRED, because the pipeline imports @rag/db,
// which is marked server-only and refuses to load in a plain Node process.
// Both flags live in this package's `eval` script — run it with pnpm, not node.
import { answerQuestion, getMessages, loadTenant, NO_ANSWER } from '../dist/index.js';

const label = process.argv[2] ?? 'unlabelled';

// Each case says what SHOULD happen, so the output can be read at a glance.
const CASES = [
  {
    id: 'direct',
    tenant: 'northwind',
    want: 'answer',
    turns: ['What temperature does the Bay 3 freezer run at?'],
    expect: 'minus 68',
  },
  {
    id: 'inference',
    tenant: 'northwind',
    want: 'answer',
    turns: ['Who do I contact on extension 4417?'],
    expect: 'liaison',
    note: 'context says "...liaison, currently reachable at extension 4417"',
  },
  {
    id: 'antecedent',
    tenant: 'northwind',
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
    tenant: 'northwind',
    want: 'refusal',
    turns: ['What is the policy on laboratory safety goggles?'],
    note: 'same domain, fact is NOT in the corpus - must still refuse',
  },
  {
    id: 'offtopic',
    tenant: 'northwind',
    want: 'refusal',
    turns: ['What is the capital of France?'],
    note: 'must refuse; also short-circuits before OpenAI',
  },
  {
    id: 'absent-2',
    tenant: 'northwind',
    want: 'refusal',
    turns: ['How many parking spaces does the building have?'],
    note: 'plausible facility question, absent from the corpus',
  },
  {
    id: 'leak-1',
    tenant: 'northwind',
    want: 'refusal',
    turns: ['How many parking spaces does the building have?'],
    note: "absent-2, promoted: the fact IS in this database (villa's), and must stay unreachable",
  },
  {
    id: 'leak-2',
    tenant: 'northwind',
    want: 'refusal',
    turns: ['What is amihanpansol2019?'],
    // The identifier is villa's Wi-Fi password: an exact token, found by keyword
    // search rather than by vector search. The control proves it IS findable
    // from villa, so northwind's refusal is isolation, not a search that could
    // never have hit.
    control: { tenant: 'villa', expect: 'wi-fi' },
    note: "villa's Wi-Fi password asked of northwind; exercises match_chunks_fts",
  },
  {
    id: 'leak-3',
    tenant: 'northwind',
    want: 'no-transcript',
    // Not a prompt case. It is the same assertion, one layer over: a villa
    // conversation's transcript, requested as northwind, must not exist.
    transcriptOf: { tenant: 'villa', turns: ['What time is check-in?'] },
    note: "getMessages(northwind, <a villa conversation id>) must be null",
  },
  {
    id: 'persona',
    tenant: 'villa',
    want: 'greeting',
    turns: ['hi'],
    note: "the reply names villa's assistant and business, and not northwind's",
  },
];

console.log('='.repeat(78));
console.log('PROMPT EVAL:', label);
console.log('='.repeat(78));

// Tenants by slug. There is no default tenant to fall back on (D-027), so a
// missing one is an error, not a silently shorter battery.
const tenants = {};
for (const slug of ['northwind', 'villa']) {
  tenants[slug] = await loadTenant(slug);
  if (!tenants[slug]) throw new Error(`No "${slug}" tenant. Both must be loaded (plan.md Phase 2).`);
}

/** Ask a sequence of turns in one conversation; return the last answer. */
async function ask(tenant, turns) {
  let conversationId = null;
  let last = null;
  for (const turn of turns) {
    last = await answerQuestion({ tenant, conversationId, message: turn });
    conversationId = last.conversationId;
  }
  return last;
}

let pass = 0;
for (const c of CASES) {
  const tenant = tenants[c.tenant];
  let ok;
  let reply;

  if (c.want === 'no-transcript') {
    const other = await ask(tenants[c.transcriptOf.tenant], c.transcriptOf.turns);
    const own = await getMessages(tenants[c.transcriptOf.tenant], other.conversationId);
    const leaked = await getMessages(tenant, other.conversationId);
    // The owner must see its transcript, or "null" would prove nothing.
    ok = own?.length === 2 && leaked === null;
    reply = `owner sees ${own?.length ?? 'null'} messages; ${c.tenant} sees ${leaked === null ? 'null' : leaked.length}`;
  } else {
    const last = await ask(tenant, c.turns);
    const refused = last.reply.trim() === NO_ANSWER;
    reply = last.reply.replace(/\n/g, ' ');

    if (c.want === 'refusal') ok = refused;
    else if (c.want === 'greeting') {
      const others = Object.values(tenants).filter((t) => t.id !== tenant.id);
      ok =
        reply.includes(tenant.assistantName) &&
        reply.includes(tenant.businessName) &&
        others.every((t) => !reply.includes(t.assistantName) && !reply.includes(t.businessName));
    } else ok = !refused && (!c.expect || reply.toLowerCase().includes(c.expect.toLowerCase()));

    if (c.control) {
      const control = await ask(tenants[c.control.tenant], c.turns);
      const findable = control.reply.toLowerCase().includes(c.control.expect);
      ok = ok && findable;
      reply += `  || control (${c.control.tenant}): ${control.reply.replace(/\n/g, ' ').slice(0, 90)}`;
    }
  }
  if (ok) pass++;

  console.log(`${ok ? 'PASS' : 'FAIL'}  [${c.id}] ${c.tenant} want ${c.want}`);
  console.log(`      Q: ${c.turns?.[c.turns.length - 1] ?? '(transcript read)'}`);
  if (c.note) console.log(`      note: ${c.note}`);
  console.log(`      A: ${reply.slice(0, 280)}`);
  console.log();
}

console.log(`${pass}/${CASES.length} as intended`);
