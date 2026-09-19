// Phase 3.1 — what do real similarity scores actually look like?
//
// Run with min_similarity = 0 so NOTHING is filtered out. The point is to see
// the whole range: what a direct hit scores, what a vaguely related question
// scores, and what a completely unrelated question scores. MIN_SIMILARITY is
// then chosen from this evidence rather than guessed (Q-1, roadmap 3.2).
import 'dotenv/config';
import { embed } from '../src/openai.js';
import { supabase } from '../src/supabase.js';

const QUESTIONS = [
  ['direct hit  ', 'What time is the Quiet Hour?'],
  ['direct hit  ', 'What temperature does the Bay 3 freezer run at?'],
  ['direct hit  ', 'Who approves equipment requests over 2000 credits?'],
  ['direct hit  ', 'How long are chemical samples retained?'],
  ['paraphrased ', 'Why cannot I use the centrifuge in the early afternoon?'],
  ['paraphrased ', 'Can a candidate on a tour walk into Bay 7?'],
  ['exact token ', 'extension 4417'],
  ['same domain ', 'What is the policy on laboratory safety goggles?'],
  ['off topic   ', 'What is the capital of France?'],
  ['off topic   ', 'How do I bake sourdough bread?'],
  ['off topic   ', 'Explain the offside rule in football.'],
];

// One embeddings call for every question at once — same batching trick as ingest.
const vectors = await embed(QUESTIONS.map(([, q]) => q));

console.log('kind          question                                             top  scores');
console.log('-'.repeat(100));

for (let i = 0; i < QUESTIONS.length; i++) {
  const [kind, question] = QUESTIONS[i];
  const { data, error } = await supabase.rpc('match_chunks', {
    query_embedding: vectors[i],
    match_count: 5,
    min_similarity: 0, // show everything
  });
  if (error) throw new Error(error.message);

  const scores = data.map((c) => c.similarity.toFixed(3)).join('  ');
  const top = data[0] ? data[0].similarity.toFixed(3) : '  -  ';
  console.log(`${kind}  ${question.padEnd(52)} ${top}  ${scores}`);
}

console.log();
console.log('Reminder: every question returns match_count rows when the threshold is 0.');
console.log('The off-topic rows below are not a bug — they are the nearest chunks in a');
console.log('corpus of 3. That is exactly what MIN_SIMILARITY exists to reject (D-008).');
