// customer-booking-villa-rates.mjs — plan/customer-booking.md Phase 1: give
// villa prices in the database (§ 2.4), and mark each tenant's night slot
// (§ 2.2). Run AFTER schema-customer-booking.sql. Idempotent: running it
// again changes nothing, and prints what it found.
//
//   - villa's one unit, "Whole property": 30 guests included, 45 at most,
//     ₱250 per guest above 30 (02-rates-and-schedules.md, 08-faq.md);
//   - villa's three rates, weekday / weekend, in centavos, from
//     02-rates-and-schedules.md. No holiday_price: villa's holiday rate IS
//     its weekend rate;
//   - `nightly` on villa's Overnight and harbor's Night.
//
// The unit and its rates are written as villa's OPERATOR member on a staff
// token, under RLS (plan/auth-rls.md § 2.7), directly rather than through
// @rag/bookings' accommodations.ts, which is per_room only. Slots have no
// token write policy at all (they are set up by tools, like tenant:add), so
// `nightly` is set on the service client, with the tenant filter explicit.
// The holiday calendar is NOT filled here: staff type it on S-7 (Phase 4).
//
//   cd packages/rag && node --conditions=react-server --env-file=../../.env ../../plan/customer-booking-villa-rates.mjs

import { asOperator, supabase } from '../packages/db/dist/service.js';

const VILLA_UNIT = { standard_capacity: 30, capacity: 45, extra_person_rate: 25000 };
const VILLA_RATES = {
  'Day Tour': { weekday_price: 950000, weekend_price: 1200000 },
  Overnight: { weekday_price: 1600000, weekend_price: 2000000 },
  '22-Hour Whole Day': { weekday_price: 2200000, weekend_price: 2700000 },
};
const NIGHTLY = { villa: 'Overnight', harbor: 'Night' };

const { data: tenants, error: tenantsError } = await supabase.from('tenants').select('id, slug').in('slug', Object.keys(NIGHTLY));
if (tenantsError) throw new Error(tenantsError.message);
const bySlug = Object.fromEntries(tenants.map((t) => [t.slug, t]));
for (const slug of Object.keys(NIGHTLY)) if (!bySlug[slug]) throw new Error(`No tenant "${slug}"`);

// 1. The night slots. A missing slot is an error, not something to create.
for (const [slug, name] of Object.entries(NIGHTLY)) {
  const { data, error } = await supabase
    .from('slots')
    .update({ nightly: true })
    .eq('tenant_id', bySlug[slug].id)
    .eq('name', name)
    .select('id, name, nightly');
  if (error) throw new Error(`${slug} ${name}: ${error.message} (run sql/schema-customer-booking.sql first)`);
  if (data.length !== 1) throw new Error(`${slug} has ${data.length} slots named "${name}", expected 1`);
  console.log(`slot: ${slug} "${name}" nightly`);
}

// 2. Villa's unit and rates, as villa's operator.
const villa = await asOperator(bySlug.villa);
const { data: units, error: unitsError } = await villa.db.from('units').select('id, name, active').eq('tenant_id', villa.id);
if (unitsError) throw new Error(unitsError.message);
const active = units.filter((u) => u.active);
if (active.length !== 1) throw new Error(`villa has ${active.length} active units; a whole_resort tenant has exactly one`);
const unit = active[0];

{
  const { data, error } = await villa.db.from('units').update(VILLA_UNIT).eq('tenant_id', villa.id).eq('id', unit.id).select('standard_capacity, capacity, extra_person_rate');
  if (error || data.length !== 1) throw new Error(`villa unit: ${error?.message ?? `${data.length} rows updated`}`);
  console.log(`unit: villa "${unit.name}" ${data[0].standard_capacity}/${data[0].capacity} +${data[0].extra_person_rate}`);
}

const { data: slots, error: slotsError } = await villa.db.from('slots').select('id, name').eq('tenant_id', villa.id);
if (slotsError) throw new Error(slotsError.message);
// Every row carries every key (CLAUDE.md trap 15).
const rows = Object.entries(VILLA_RATES).map(([name, rate]) => {
  const slot = slots.find((s) => s.name === name);
  if (!slot) throw new Error(`villa has no "${name}" slot`);
  return { tenant_id: villa.id, unit_id: unit.id, slot_id: slot.id, weekday_price: rate.weekday_price, weekend_price: rate.weekend_price, holiday_price: null };
});
{
  const { data, error } = await villa.db.from('unit_rates').upsert(rows, { onConflict: 'tenant_id,unit_id,slot_id' }).select('slot_id, weekday_price, weekend_price, holiday_price');
  if (error) throw new Error(`villa rates: ${error.code} ${error.message}`);
  if (data.length !== rows.length) throw new Error(`villa rates: ${data.length} of ${rows.length} rows written`);
  const nameOf = Object.fromEntries(slots.map((s) => [s.id, s.name]));
  console.log(`rates: villa ${data.map((r) => `${nameOf[r.slot_id]} ${r.weekday_price}/${r.weekend_price}`).join(' · ')}`);
}

// 3. The effect, read back through villa's own token: one quote per slot on a
//    Monday and a Saturday, 32 guests (2 above the standard 30). Not "the
//    command succeeded": the price the trigger will store.
for (const [date, label] of [['2026-10-05', 'Mon'], ['2026-10-10', 'Sat']]) {
  const quotes = [];
  for (const slot of slots) {
    const { data, error } = await villa.db.rpc('unit_quote', { p_tenant_id: villa.id, p_unit_id: unit.id, p_slot_id: slot.id, p_date: date, p_guests: 32 });
    if (error) throw new Error(`unit_quote: ${error.message}`);
    const q = data[0];
    quotes.push(`${slot.name} ${q.base_price}+${q.extra_guest_price}+${q.surcharge}=${q.price}`);
  }
  console.log(`quote ${date} (${label}), 32 guests: ${quotes.join(' · ')}`);
}
