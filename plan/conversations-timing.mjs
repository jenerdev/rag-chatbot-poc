// conversations-timing.mjs — conversation_list() on a STAFF token (trap 11:
// never measure RLS as service_role), for plan/conversations.md § 7 q6: the
// trigram index waits until a real tenant's search passes 100 ms. Wall time
// through PostgREST, so it includes the round trip; the median of 7 calls, beside app_role() (one row read) as the floor.
//
//   (cd packages/rag && node --conditions=react-server --env-file=../../.env ../../plan/conversations-timing.mjs)
import { asOperator, supabase } from '../packages/db/dist/service.js';
import { loadTenant } from '../packages/rag/dist/index.js';

for (const slug of ['villa', 'harbor', 'northwind']) {
  const staff = await asOperator(await loadTenant(slug));
  const { count } = await supabase.from('messages').select('id', { count: 'exact', head: true }).eq('tenant_id', staff.id);
  for (const [label, fn, args] of [['floor app_role', 'app_role', null], ['list, 90 days', 'conversation_list', {}], ['search "the"', 'conversation_list', { p_query: 'the' }]]) {
    const times = [];
    for (let i = 0; i < 7; i++) {
      const t = performance.now();
      const { error } = await (args ? staff.db.rpc(fn, { p_tenant_id: staff.id, p_days: 90, ...args }) : staff.db.rpc(fn));
      if (error) throw new Error(error.message);
      times.push(performance.now() - t);
    }
    times.sort((a, b) => a - b);
    console.log(`${slug.padEnd(9)} ${String(count).padStart(5)} messages · ${label.padEnd(14)} median ${times[3].toFixed(0)} ms (min ${times[0].toFixed(0)}, max ${times[6].toFixed(0)})`);
  }
}
