// voice-phase5-walls.mjs — the speak route's one read, latestReply(), behind
// each wall ALONE (plan/voice.md Phase 5, CLAUDE.md rule 6, D-038), with its
// positive twin. In place of the pipeline isolation suite, which needs
// northwind (deleted 2026-10-20). No API key, no dev server.
//
//   1. wall 2 alone: villa's CHAT token, latestReply() of alteza's
//      conversation is null, and an UNFILTERED read of its messages is 0 rows;
//   2. wall 1 alone: the service client (RLS bypassed) as villa: null, by the
//      tenant_id filter only;
//   3. the twin: alteza's own chat token reads its reply, and a stored
//      refusal comes back as alteza's words, never the marker.
//
//   (cd packages/rag && node --conditions=react-server --env-file=../../.env ../../plan/voice-phase5-walls.mjs)

import { mintTenantToken, scopedClient } from '../packages/db/dist/index.js';
import { supabase as service } from '../packages/db/dist/service.js';
import { latestReply, loadTenant, NO_ANSWER } from '../packages/rag/dist/index.js';

let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failures++;
};

const villa = await loadTenant('villa');
const alteza = await loadTenant('alteza');
if (!villa || !alteza) throw new Error('needs villa and alteza');
const chatAs = (t) => ({ ...t, db: scopedClient(mintTenantToken({ tenantId: t.id })) });

// Alteza's conversation: a question, a real answer, a question, a refusal (newest).
const { data: conversation, error } = await service.from('conversations').insert({ tenant_id: alteza.id }).select('id').single();
if (error) throw new Error(error.message);
const id = conversation.id;
try {
  const rows = [
    ['user', 'Do you have a pool?'],
    ['assistant', 'Yes, the pool is open from 8 AM to 8 PM.'],
    ['user', 'Do you have a helipad?'],
    ['assistant', NO_ANSWER],
  ].map(([role, content]) => ({ tenant_id: alteza.id, conversation_id: id, role, content }));
  for (const row of rows) {
    const { error: e } = await service.from('messages').insert(row);
    if (e) throw new Error(e.message);
  }

  // 1. Wall 2 alone.
  const villaChat = chatAs(villa);
  const viaToken = await latestReply(villaChat, id);
  const { data: unfiltered, error: readError } = await villaChat.db.from('messages').select('id').eq('conversation_id', id);
  check(viaToken === null && !readError && unfiltered.length === 0, "1. RLS alone: villa's chat token gets null, and 0 of alteza's messages unfiltered", `${JSON.stringify(viaToken)} · ${unfiltered?.length ?? readError?.message} rows`);

  // 2. Wall 1 alone.
  const viaFilter = await latestReply({ ...villa, db: service }, id);
  check(viaFilter === null, "2. the filter alone (service client, RLS bypassed): villa gets null for alteza's conversation", JSON.stringify(viaFilter));

  // 3. The twin.
  const own = await latestReply(chatAs(alteza), id);
  check(
    own !== null && own.text !== NO_ANSWER && !own.text.includes(NO_ANSWER) && own.text.length > 0 && own.language === 'english',
    "3. the twin: alteza's own token reads its latest reply, the refusal as alteza's words",
    JSON.stringify(own),
  );
} finally {
  await service.from('conversations').delete().eq('id', id);
}
console.log(`\n${failures === 0 ? 'all passed' : `${failures} FAILED`}`);
process.exit(failures ? 1 : 0);
