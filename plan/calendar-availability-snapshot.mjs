// calendar-availability-snapshot.mjs — the rows check_availability() and
// check_room_availability() return, for the diff plan/calendar.md Rule 5
// demands: Phase 1 moves their "taken" test into slot_taken(), and their
// rows must not change by a byte.
//
// Phase 0 saves the left side, Phase 1 the right, for the SAME range (pass
// the first date, so a run on another day still compares like with like).
// Only villa and harbor: northwind has no bookings application.
//
//   (cd packages/db && node --conditions=react-server --env-file=../../.env ../../plan/calendar-availability-snapshot.mjs <from> > out.json)

import { supabase } from '../packages/db/dist/service.js';

const from = process.argv[2];
if (!/^\d{4}-\d{2}-\d{2}$/.test(from ?? '')) throw new Error('usage: <from YYYY-MM-DD>');
const to = new Date(Date.parse(`${from}T00:00:00Z`) + 30 * 86400000).toISOString().slice(0, 10);

const out = { from, to };
for (const slug of ['villa', 'harbor']) {
  const { data: tenant } = await supabase.from('tenants').select('id').eq('slug', slug).single();
  const a = await supabase.rpc('check_availability', { p_tenant_id: tenant.id, p_from: from, p_to: to });
  if (a.error) throw new Error(`${slug} check_availability: ${a.error.message}`);
  const r = await supabase.rpc('check_room_availability', { p_tenant_id: tenant.id, p_from: from, p_to: to, p_slot: null, p_unit: null, p_guests: null });
  if (r.error) throw new Error(`${slug} check_room_availability: ${r.error.message}`);
  // Sorted, so a row order Postgres is free to change is not a "difference".
  const key = (row) => JSON.stringify(row);
  out[slug] = { check_availability: a.data.map(key).sort(), check_room_availability: r.data.map(key).sort() };
}
process.stdout.write(JSON.stringify(out, null, 1) + '\n');
