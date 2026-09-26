// isolation.mjs — cross-tenant checks for @rag/bookings, through the package.
//
// verify.mjs proves the database refuses cross-tenant WRITES. This proves the
// package does not do cross-tenant READS, which only its tenant_id filters
// prevent (CLAUDE.md rule 6). Same approach as packages/rag/tools/isolation.mjs:
// two tenants that both have bookings, each asked about the other's.
//
// Needs no OpenAI key. It creates:
//   * a throwaway `bookings-probe` tenant with the bookings application, one
//     unit and one slot, deleted at the end (the delete cascades);
//   * ONE booking in villa, 300 days out, HARD-deleted at the end. Cancelling
//     it would leave a row in villa's real history.
//
// Run:  pnpm --filter @rag/bookings isolation

import { mintTenantToken, scopedClient } from '@rag/db';
import { supabase } from '@rag/db/service';
import {
  BookingConflictError,
  BookingInputError,
  BookingsNotEnabledError,
  cancelBooking,
  checkAvailability,
  createBooking,
  listBookings,
  listSlots,
  listUnits,
  localDate,
} from '../dist/index.js';

let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failures++;
};
/** Run fn and return what it threw, or null. */
const thrown = async (fn) => {
  try {
    await fn();
    return null;
  } catch (error) {
    return error;
  }
};

const { data: tenants, error: tenantError } = await supabase
  .from('tenants')
  .select('id, slug')
  .in('slug', ['villa', 'northwind']);
if (tenantError) throw new Error(tenantError.message);
// Staff work (list, book, cancel) runs on the service client. RLS is
// bypassed, so every check below is the CODE FILTERS' wall, alone (auth-rls
// Rule 1). Until Phase 5 there is no member to mint a staff token for anyway.
// Availability is what the chatbot asks, so it runs on a CHAT token, as the
// tool executor's does. That also puts the security-definer
// check_availability's own tenant check in the path.
const withDb = (t) => t && { id: t.id, slug: t.slug, db: supabase };
const chat = (t) => ({ ...t, db: scopedClient(mintTenantToken({ tenantId: t.id })) });
const villa = withDb(tenants.find((t) => t.slug === 'villa'));
const northwind = withDb(tenants.find((t) => t.slug === 'northwind'));
if (!villa || !northwind) throw new Error('Needs tenants villa and northwind');

// 300 days out, in villa's timezone: far enough that no real booking is there.
const day = (offset) => {
  const d = new Date(`${localDate('Asia/Manila')}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
};
const probeDate = day(300);

const { data: probeRow, error: probeError } = await supabase
  .from('tenants')
  .insert({ slug: 'bookings-probe', business_name: 'bookings isolation probe', assistant_name: 'Probe' })
  .select('id, slug')
  .single();
if (probeError) throw new Error(`Could not create the probe tenant: ${probeError.message}`);
const probe = { id: probeRow.id, slug: probeRow.slug, db: supabase };

let villaBookingId = null;
try {
  await supabase
    .from('tenant_applications')
    .insert({ tenant_id: probe.id, application_key: 'bookings', config: { timezone: 'Asia/Manila' } });
  await supabase.from('units').insert({ tenant_id: probe.id, name: 'Probe unit' });
  await supabase.from('slots').insert({ tenant_id: probe.id, name: 'Probe slot', start_time: '09:00', duration: '2 hours' });

  // 1. Northwind has no bookings application: every call is a 404-shaped
  //    error, the same answer "no such route" would give.
  {
    const errors = await Promise.all([
      thrown(() => checkAvailability(chat(northwind), { from: probeDate })),
      thrown(() => listBookings(northwind, { from: probeDate })),
      thrown(() => cancelBooking(northwind, 1)),
    ]);
    check(
      errors.every((e) => e instanceof BookingsNotEnabledError && e.status === 404),
      'northwind: bookings not enabled, 404',
      errors.map((e) => e?.message ?? 'no error').join(' | '),
    );
  }

  // 2. Villa's own setup, through the package.
  const [villaUnits, villaSlots] = await Promise.all([listUnits(villa), listSlots(villa)]);
  check(
    villaUnits.length === 1 && villaSlots.length === 3,
    'villa: 1 unit, 3 slots',
    `${villaUnits.map((u) => u.name).join(', ')} · ${villaSlots.map((s) => `${s.name} ${s.startTime}`).join(', ')}`,
  );

  // 3. A villa booking, then the same slot again: the second is a 409.
  const overnight = villaSlots.find((s) => s.name === 'Overnight');
  const booked = await createBooking(villa, {
    unitId: villaUnits[0].id,
    slotId: overnight.id,
    date: probeDate,
    guestName: 'Isolation Probe',
    guestPhone: '0917-000-0000',
  });
  villaBookingId = booked.id;
  check(booked.status === 'confirmed' && booked.slot === 'Overnight', 'villa: booking created', `#${booked.id} ${booked.date} ${booked.slot}`);

  const again = await thrown(() =>
    createBooking(villa, { unitId: villaUnits[0].id, slotId: overnight.id, date: probeDate, guestName: 'Second' }),
  );
  check(
    again instanceof BookingConflictError && again.status === 409,
    'villa: the same slot again is a 409',
    again?.message ?? 'NO ERROR — double-booked',
  );

  // 4. Villa's availability shows it, and carries no guest data.
  {
    const rows = await checkAvailability(chat(villa), { from: probeDate });
    const keys = [...new Set(rows.flatMap((r) => Object.keys(r)))].sort().join(',');
    const text = JSON.stringify(rows);
    check(
      rows.find((r) => r.slot === 'Overnight')?.status === 'taken',
      'villa: availability shows the booking as taken',
      rows.map((r) => `${r.slot} ${r.status}`).join(', '),
    );
    check(
      keys === 'date,slot,status,unit' && !text.includes('Isolation Probe') && !text.includes('0917'),
      'villa: availability carries no guest data',
      `keys: ${keys}`,
    );
  }

  // 5. The probe tenant, which HAS bookings, cannot see villa's.
  {
    const probeList = await listBookings(probe, { from: probeDate });
    check(
      probeList.length === 0,
      "probe: listBookings does not include villa's booking",
      `${probeList.length} rows`,
    );
    const probeAvailability = await checkAvailability(chat(probe), { from: probeDate });
    check(
      probeAvailability.every((r) => r.unit === 'Probe unit' && r.status === 'open'),
      "probe: availability shows only its own unit, all open",
      probeAvailability.map((r) => `${r.unit}/${r.slot} ${r.status}`).join(', '),
    );
  }

  // 6. The probe cannot cancel villa's booking by id. `false` is "not yours or
  //    not there", indistinguishable on purpose, and the booking is untouched.
  {
    const cancelled = await cancelBooking(probe, villaBookingId);
    const { data: still } = await supabase.from('bookings').select('status').eq('id', villaBookingId).single();
    check(
      cancelled === false && still.status === 'confirmed',
      "probe: cannot cancel villa's booking",
      `returned ${cancelled}, villa's is still ${still.status}`,
    );
    const nobody = await cancelBooking(probe, 999_999_999);
    check(nobody === false, 'probe: a nonexistent id gives the same false', `returned ${nobody}`);
  }

  // 7. The probe cannot book villa's unit. The message is the same one a
  //    nonexistent id gets, so unit ids cannot be enumerated.
  {
    const probeSlots = await listSlots(probe);
    const crossTenant = await thrown(() =>
      createBooking(probe, { unitId: villaUnits[0].id, slotId: probeSlots[0].id, date: probeDate, guestName: 'x' }),
    );
    const nonexistent = await thrown(() =>
      createBooking(probe, { unitId: 999_999_999, slotId: probeSlots[0].id, date: probeDate, guestName: 'x' }),
    );
    check(
      crossTenant instanceof BookingInputError &&
        nonexistent instanceof BookingInputError &&
        crossTenant.message === nonexistent.message,
      "probe: villa's unit looks exactly like no unit",
      `"${crossTenant?.message}" vs "${nonexistent?.message}"`,
    );
  }

  // 8. A past date is refused, measured against the tenant's today.
  {
    const past = await thrown(() => checkAvailability(chat(villa), { from: day(-1) }));
    check(
      past instanceof BookingInputError && past.message.includes('is in the past'),
      'villa: yesterday is refused',
      past?.message ?? 'NO ERROR',
    );
  }
} finally {
  if (villaBookingId !== null) {
    const { error } = await supabase.from('bookings').delete().eq('tenant_id', villa.id).eq('id', villaBookingId);
    if (error) console.log(`WARN  could not delete villa probe booking #${villaBookingId}: ${error.message}`);
  }
  const { error } = await supabase.from('tenants').delete().eq('id', probe.id);
  if (error) console.log(`WARN  could not delete the bookings-probe tenant: ${error.message}`);
}

console.log(failures === 0 ? '\nALL BOOKINGS ISOLATION CHECKS PASS' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
