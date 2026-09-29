// alteza-rooms.mjs — alteza's six rooms, their rates and its holiday calendar.
//
// The rooms and their included / maximum guests are the ones
// sample-documents/alteza/02-rooms-and-capacity.md describes. The RATES ARE
// INVENTED PLACEHOLDERS: that document holds no prices on purpose
// (OWNER-QUESTIONNAIRE rule 2), so the owner replaces these on the Rooms
// screen. Every amount is centavos.
//
// Runs as alteza's OPERATOR member on a staff token, through the same
// @rag/bookings functions the admin routes call; UPSERTED BY NAME, so a
// second run changes nothing and rooms staff edited by hand are kept.
//
//   cd packages/rag && node --conditions=react-server --env-file=../../.env ../../plan/alteza-rooms.mjs

import { asOperator } from '../packages/db/dist/service.js';
import {
  createAccommodation,
  listAccommodations,
  listCalendar,
  listSlots,
  setCalendarDay,
  setRates,
  updateAccommodation,
} from '../packages/bookings/dist/index.js';
import { loadTenant } from '../packages/rag/dist/index.js';

const EXTRA = 35000; // ₱350 per guest above the included number, per period
// [name, included, maximum, sort, Day Use weekday/weekend, Overnight weekday/weekend]
const ROOMS = [
  ['Casa Uno', 2, 3, 1, [250000, 320000], [380000, 480000]],
  ['Casa Dos', 2, 3, 2, [260000, 330000], [400000, 500000]],
  ['Familia', 4, 6, 3, [450000, 550000], [650000, 800000]],
  ['Kubo A', 2, 4, 4, [220000, 280000], [350000, 440000]],
  ['Kubo B', 2, 4, 5, [220000, 280000], [350000, 440000]],
  ['Loft Suite', 2, 2, 6, [300000, 380000], [500000, 620000]],
];
const PEAK = 100000; // ₱1,000 per night per room on 24 and 31 Dec and 1 Jan (03-booking-periods)

const chat = await loadTenant('alteza');
if (!chat) throw new Error('No tenant "alteza"');
const alteza = await asOperator(chat);

const slots = await listSlots(alteza);
const dayUse = slots.find((s) => s.name === 'Day Use');
const overnight = slots.find((s) => s.name === 'Overnight');
if (!dayUse || !overnight) throw new Error('alteza needs the Day Use and Overnight slots first');

const existing = await listAccommodations(alteza);
for (const [name, included, maximum, sortOrder, day, night] of ROOMS) {
  let room = existing.find((a) => a.name === name);
  // The Loft takes no extra guest: no fee, and standard = maximum.
  const fee = included === maximum ? null : EXTRA;
  if (!room) {
    room = await createAccommodation(alteza, { name, standardCapacity: included, maxCapacity: maximum, extraPersonRate: fee, sortOrder });
    console.log(`room: added ${name}`);
  } else if (room.standardCapacity !== included || room.capacity !== maximum || room.extraPersonRate !== fee || room.sortOrder !== sortOrder) {
    room = await updateAccommodation(alteza, room.id, { standardCapacity: included, maxCapacity: maximum, extraPersonRate: fee, sortOrder });
    console.log(`room: updated ${name}`);
  }
  const want = [
    { slotId: dayUse.id, weekdayPrice: day[0], weekendPrice: day[1] },
    { slotId: overnight.id, weekdayPrice: night[0], weekendPrice: night[1] },
  ];
  const same = want.every((w) => room.rates.some((r) => r.slotId === w.slotId && r.weekdayPrice === w.weekdayPrice && r.weekendPrice === w.weekendPrice));
  if (!same) {
    await setRates(alteza, room.id, want);
    console.log(`rate: ${name} Day Use ${day[0]}/${day[1]} · Overnight ${night[0]}/${night[1]}`);
  }
}

// The calendar: 03-booking-periods-and-inclusions.md's dates. Holy Week is
// typed per year (it moves); 25 Dec is a closure, which the calendar cannot
// express, so it is left to staff.
const year = Number(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' }).format(new Date()).slice(0, 4));
const days = [];
for (const y of [year, year + 1]) {
  days.push(
    { day: `${y}-12-24`, kind: 'peak', label: 'Christmas Eve', surcharge: PEAK },
    { day: `${y}-12-31`, kind: 'peak', label: "New Year's Eve", surcharge: PEAK },
    { day: `${y + 1}-01-01`, kind: 'peak', label: "New Year's Day", surcharge: PEAK },
  );
}
for (const day of ['2027-03-25', '2027-03-26', '2027-03-27', '2027-03-28']) days.push({ day, kind: 'holiday', label: 'Holy Week', surcharge: 0 });
// setCalendarDay is an upsert on (tenant, day), so this is idempotent as it
// is; listCalendar caps a range at 800 days, so the read-back is one span.
for (const d of days) await setCalendarDay(alteza, d);
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' }).format(new Date());
const end = new Date(`${today}T00:00:00Z`);
end.setUTCDate(end.getUTCDate() + 799);
const listed = await listCalendar(alteza, { from: today, to: end.toISOString().slice(0, 10) });
console.log(`calendar: ${days.length} day(s) set, ${listed.length} listed from today: ${listed.map((d) => `${d.day} ${d.label}${d.surcharge ? ` +${d.surcharge}` : ''}`).join(' · ')}`);

const final = await listAccommodations(alteza);
console.log(
  'alteza rooms:',
  final.map((a) => `${a.name} ${a.standardCapacity}/${a.capacity}${a.extraPersonRate ? ` +${a.extraPersonRate}` : ''} [${a.rates.map((r) => `${r.slot} ${r.weekdayPrice}/${r.weekendPrice}`).join(', ')}]`).join(' · '),
);
