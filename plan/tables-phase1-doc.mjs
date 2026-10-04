// tables-phase1-doc.mjs — plan/tables.md Phase 1's end-to-end check: a
// document holding a pipe table goes into northwind, the chat is asked for
// it word for word, and the reply is printed so the table in it can be seen
// in the browser (the same text through <ReplyText>) and judged here. The
// document is DELETED at the end, whatever happened, because the battery
// needs northwind to hold fixtures/northwind.json and nothing else.
// Run from packages/rag:
//   node --conditions=react-server --env-file=../../.env ../../plan/tables-phase1-doc.mjs
import { asOperator } from '../packages/db/dist/service.js';
import { answerQuestion, deleteDocument, ingestDocument, loadTenant } from '../packages/rag/dist/index.js';

const TITLE = 'Tables Phase 1 probe (delete me)';
const CONTENT = [
  'Northwind has three meeting rooms, listed in this table:',
  '',
  '| Room | Seats | Rate per hour |',
  '|---|---|---|',
  '| Kestrel | 4 | ₱500.00 |',
  '| Osprey | 8 | ₱900.00 |',
  '| Harrier | 16 | ₱1,600.00 |',
  '',
  'Rates are per hour and include the projector.',
].join('\n');

const chat = await loadTenant('northwind');
const tenant = await asOperator(chat);
const { id: documentId } = await ingestDocument({ tenant, title: TITLE, source: null, content: CONTENT });
console.log(`ingested #${documentId}`);
try {
  const a = await answerQuestion({ tenant: chat, conversationId: null, message: 'Show me the meeting rooms table exactly as written in the document, with the same columns.' });
  console.log(`refused: ${a.refused} · sources: ${a.sources.length}`);
  console.log(a.reply);
  const rows = ['| Kestrel', '| Osprey', '| Harrier'].filter((r) => a.reply.includes(r)).length;
  const separator = /\|\s*:?-+:?\s*\|/.test(a.reply);
  console.log(`\npipe rows named: ${rows}/3 · separator line: ${separator}`);
} finally {
  const gone = await deleteDocument(tenant, documentId);
  console.log(`deleted #${documentId}: ${gone}`);
}
