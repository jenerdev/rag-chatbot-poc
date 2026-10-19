// booking-types-phase6-harbor.mjs — put tenant harbor into the state the
// battery's rt-* cases expect (plan/booking-types.md Phase 6):
//
//   - its corpus, fixtures/harbor.json, ingested once (skipped if a document
//     with that title is already there);
//   - its rooms and Night rates, fixtures/harbor-units.json, UPSERTED BY
//     NAME, so running it again changes nothing, and rooms staff added by
//     hand (the Phase 4 walk) are kept.
//
// Everything runs as harbor's OPERATOR member on a staff token, through the
// same @rag/bookings and @rag/pipeline functions the admin routes call
// (plan/auth-rls.md § 2.7), not as service_role. The one embedding call costs
// a fraction of a cent.
//
//   cd packages/rag && node --conditions=react-server --env-file=../../.env ../../plan/booking-types-phase6-harbor.mjs

import { readFileSync } from 'node:fs';
import { asOperator } from '../packages/db/dist/service.js';
import { addUnitRoom, createAccommodation, listAccommodations, listSlots, setRates, updateAccommodation, updateUnitRoom } from '../packages/bookings/dist/index.js';
import { ingestDocument, listDocuments, loadTenant } from '../packages/rag/dist/index.js';

const read = (name) => JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8'));
const corpus = read('harbor.json');
const units = read('harbor-units.json');

const chat = await loadTenant('harbor');
if (!chat) throw new Error('No tenant "harbor": run tenant:add first (Phase 0)');
const harbor = await asOperator(chat);

// 1. The corpus.
const documents = await listDocuments(harbor);
if (documents.some((d) => d.title === corpus.title)) {
  console.log(`corpus: "${corpus.title}" already there, skipped`);
} else {
  const doc = await ingestDocument({ tenant: harbor, title: corpus.title, source: corpus.source, content: corpus.content });
  console.log(`corpus: ingested "${corpus.title}" as document ${doc.id ?? JSON.stringify(doc)}`);
}

// 2. The slot must exist already (Phase 4 made it); a missing one is an error,
//    not something to create quietly with a different start time.
const slot = (await listSlots(harbor)).find((s) => s.name === units.slot.name);
if (!slot) throw new Error(`harbor has no "${units.slot.name}" slot`);

// 3. Rooms, by name, then their rates.
const existing = await listAccommodations(harbor);
for (const room of units.rooms) {
  let current = existing.find((a) => a.name === room.name);
  if (!current) {
    current = await createAccommodation(harbor, { name: room.name, capacity: room.capacity, sortOrder: room.sort_order });
    console.log(`room: added ${room.name}`);
  }
  // Capacity, order, and (plan/extra-guests.md) the standard capacity and the
  // extra-guest rate, set together so a standard never exceeds the maximum.
  if (
    current.capacity !== room.capacity ||
    current.sortOrder !== room.sort_order ||
    current.standardCapacity !== (room.standard_capacity ?? null) ||
    current.extraPersonRate !== (room.extra_person_rate ?? null)
  ) {
    current = await updateAccommodation(harbor, current.id, {
      capacity: room.capacity,
      sortOrder: room.sort_order,
      standardCapacity: room.standard_capacity ?? null,
      extraPersonRate: room.extra_person_rate ?? null,
    });
    console.log(`room: updated ${room.name}`);
  }
  const rate = current.rates.find((r) => r.slotId === slot.id);
  if (rate?.weekdayPrice !== room.weekday_price || rate?.weekendPrice !== room.weekend_price) {
    current = await setRates(harbor, current.id, [{ slotId: slot.id, weekdayPrice: room.weekday_price, weekendPrice: room.weekend_price }]);
    console.log(`rate: ${room.name} ${room.weekday_price}/${room.weekend_price}`);
  }
  // Room types (D-133): a type with a `rooms` list has those physical rooms.
  // A name already there is kept; the type's rooms not named are renamed in
  // order (the backfill's one room, named after the type), then the rest added.
  if (room.rooms) {
    const spare = current.rooms.filter((r) => !room.rooms.includes(r.name)).sort((a, b) => a.id - b.id);
    for (const name of room.rooms) {
      if (current.rooms.some((r) => r.name === name)) continue;
      const old = spare.shift();
      if (old) {
        await updateUnitRoom(harbor, current.id, old.id, { name });
        console.log(`room: ${room.name}'s ${old.name} renamed ${name}`);
      } else {
        await addUnitRoom(harbor, current.id, name);
        console.log(`room: ${room.name} gains ${name}`);
      }
    }
  }
  // Rated first, retired second: the Old Annex has a price and is still left
  // out, which is what rt-inactive needs.
  if (current.active !== room.active) {
    current = await updateAccommodation(harbor, current.id, { active: room.active });
    console.log(`room: ${room.name} ${room.active ? 'offered again' : 'retired'}`);
  }
}

const final = await listAccommodations(harbor);
console.log(
  'harbor now:',
  final
    .map((a) => `${a.name}${a.active ? '' : ' (retired)'} ${a.standardCapacity}/${a.capacity} +${a.extraPersonRate} ${a.rates.map((r) => `${r.weekdayPrice}/${r.weekendPrice}`).join(',')}`)
    .join(' · '),
);
