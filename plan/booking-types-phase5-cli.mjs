// booking-types-phase5-cli.mjs — `tenant:booking-type` against a scratch
// tenant (plan/booking-types.md Phase 5, "done when"): it shows the type,
// refuses per § 2.4 with the count, and switches back and forth when nothing
// is in the way.
//
// Runs the real CLI as a child process, exactly as an operator would. The
// service client sets the scene (units, a rate, a booking) and looks; it never
// does the switch itself. Villa, northwind and harbor are only READ.
//
//   cd packages/db && node --conditions=react-server --env-file=../../.env ../../plan/booking-types-phase5-cli.mjs

import { execFileSync } from 'node:child_process';
import { supabase } from '../packages/db/dist/service.js';

let failures = 0;
const check = (ok, label, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  — ${detail}`);
  if (!ok) failures++;
};

/** Run the CLI; returns { code, out } with stdout and stderr together. */
function cli(...args) {
  try {
    const out = execFileSync(
      process.execPath,
      ['--conditions=react-server', '--env-file=../../.env', 'tools/tenant.mjs', 'booking-type', ...args],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    return { code: 0, out: out.trim() };
  } catch (error) {
    return { code: error.status ?? 1, out: `${error.stdout ?? ''}${error.stderr ?? ''}`.trim() };
  }
}

const SLUG = 'cli-probe';
const { data: probe, error } = await supabase
  .from('tenants')
  .insert({ slug: SLUG, business_name: 'CLI probe', assistant_name: 'Probe' })
  .select('id')
  .single();
if (error) throw new Error(`create ${SLUG}: ${error.message}`);

try {
  // 1. Shapes that are refused before the database is asked.
  {
    const noApp = cli(SLUG);
    const badType = cli(SLUG, 'per_bed');
    const nobody = cli('no-such-tenant-here');
    check(
      noApp.code === 1 && /does not have the bookings application/.test(noApp.out)
        && badType.code === 1 && /usage/.test(badType.out)
        && nobody.code === 1 && /no tenant/.test(nobody.out),
      'no application, a bad type and a missing tenant are each refused',
      `${noApp.out} | ${badType.out} | ${nobody.out}`,
    );
  }

  await supabase.from('tenant_applications').insert({ tenant_id: probe.id, application_key: 'bookings', config: { timezone: 'Asia/Manila' } });
  const { data: slot } = await supabase.from('slots').insert({ tenant_id: probe.id, name: 'Night', start_time: '14:00', duration: '22 hours' }).select('id').single();
  const { data: first } = await supabase.from('units').insert({ tenant_id: probe.id, name: 'Room A', active: true }).select('id').single();

  // 2. Shown as the default, then switched to per_room.
  {
    const shown = cli(SLUG);
    const switched = cli(SLUG, 'per_room');
    const { data: app } = await supabase.from('tenant_applications').select('config').eq('tenant_id', probe.id).single();
    check(
      shown.code === 0 && /books as whole_resort \(the default/.test(shown.out) && switched.code === 0 && app.config.booking_type === 'per_room',
      'shows the default, then switches to per_room',
      `${shown.out} | ${switched.out.split('\n')[0]} | stored ${JSON.stringify(app.config)}`,
    );
  }

  // 3. Three active rooms: back to whole_resort is refused, with the count.
  await supabase.from('units').insert([
    { tenant_id: probe.id, name: 'Room B', active: true },
    { tenant_id: probe.id, name: 'Room C', active: true },
  ]);
  {
    const refused = cli(SLUG, 'whole_resort');
    const { data: app } = await supabase.from('tenant_applications').select('config').eq('tenant_id', probe.id).single();
    check(
      refused.code === 1 && /3 active units/.test(refused.out) && app.config.booking_type === 'per_room',
      'per_room → whole_resort refused while 3 rooms are active',
      `${refused.out} | still ${app.config.booking_type}`,
    );
  }

  // 4. One active room left, but a live booking on it: refused, with the count.
  await supabase.from('units').update({ active: false }).eq('tenant_id', probe.id).neq('id', first.id);
  await supabase.from('unit_rates').insert({ tenant_id: probe.id, unit_id: first.id, slot_id: slot.id, weekday_price: 100000, weekend_price: 100000 });
  const future = new Date(Date.now() + 90 * 86_400_000).toISOString().slice(0, 10);
  const { data: booking, error: bookingError } = await supabase
    .from('bookings')
    .insert({ tenant_id: probe.id, unit_id: first.id, slot_id: slot.id, booked_date: future, guest_name: 'CLI probe' })
    .select('id')
    .single();
  if (bookingError) throw new Error(`seed booking: ${bookingError.message}`);
  {
    const refused = cli(SLUG, 'whole_resort');
    check(
      refused.code === 1 && /1 live booking/.test(refused.out),
      'a switch is refused while a booking has not ended',
      refused.out,
    );
  }

  // 5. Cancelled, the booking no longer blocks: whole_resort, then per_room again.
  await supabase.from('bookings').update({ status: 'cancelled' }).eq('id', booking.id);
  {
    const toWhole = cli(SLUG, 'whole_resort');
    const { data: afterWhole } = await supabase.from('tenant_applications').select('config').eq('tenant_id', probe.id).single();
    const again = cli(SLUG, 'whole_resort');
    const toRooms = cli(SLUG, 'per_room');
    const { data: afterRooms } = await supabase.from('tenant_applications').select('config').eq('tenant_id', probe.id).single();
    check(
      toWhole.code === 0 && !('booking_type' in afterWhole.config) && /Nothing to change/.test(again.out)
        && toRooms.code === 0 && afterRooms.config.booking_type === 'per_room' && afterRooms.config.timezone === 'Asia/Manila',
      'with nothing live: whole_resort (the key removed), a no-op, then per_room again',
      `${toWhole.out} | ${again.out} | ${toRooms.out.split('\n')[0]} | ${JSON.stringify(afterRooms.config)}`,
    );
  }

  // 6. The real tenants, read only.
  {
    const villa = cli('villa');
    const harbor = cli('harbor');
    const northwind = cli('northwind');
    check(
      /books as whole_resort \(the default/.test(villa.out) && /books as per_room/.test(harbor.out) && /does not have the bookings application/.test(northwind.out),
      'villa is whole_resort by default, harbor per_room, northwind has no bookings',
      `${villa.out} | ${harbor.out} | ${northwind.out}`,
    );
  }
} finally {
  await supabase.from('tenants').delete().eq('id', probe.id);
}

console.log(failures === 0 ? '\nALL PHASE 5 CLI CHECKS PASS' : `\n${failures} CLI CHECK(S) FAILED`);
process.exitCode = failures === 0 ? 0 : 1;
