// booking-types-phase3-walk.mjs — the new routes over HTTP, against a running
// `pnpm dev` (plan/booking-types.md Phase 3, "done when").
//
// Creates, and deletes at the end:
//   * `routes-rooms`, a per_room tenant with one slot, and
//   * `routes-whole`, a whole_resort tenant with one unit and one slot,
//     each with its own throwaway staff user (random password, never printed);
//   * photos under routes-rooms' folder in the bucket.
// Villa and Northwind are not touched.
//
// Every refusal has its positive twin (CLAUDE.md trap 12). The service client
// is used ONLY to set up, look and clean up, never to do the thing tested.
//
//   cd packages/db && node --conditions=react-server --env-file=../../.env ../../plan/booking-types-phase3-walk.mjs [base-url]

import { randomBytes } from 'node:crypto';
import { supabase } from '../packages/db/dist/service.js';

const BASE = process.argv[2] ?? 'http://localhost:3000';
let failures = 0;
const check = (ok, label, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  — ${detail}`);
  if (!ok) failures++;
};

// A far-future Monday, in Manila, so nothing real is in the way and the
// weekday rate applies.
const monday = (() => {
  const d = new Date(`${new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' }).format(new Date())}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 60);
  while (d.getUTCDay() !== 1) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
})();

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

/** fetch, with a staff cookie if given; returns status and parsed body. */
async function call(method, slug, path, { cookie, json, form } = {}) {
  const headers = {};
  if (cookie) headers.Cookie = cookie;
  let body;
  if (json !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(json);
  } else if (form) {
    body = form;
  }
  const response = await fetch(`${BASE}/api/t/${slug}${path}`, { method, headers, body });
  const text = await response.text();
  let data = text;
  try {
    data = JSON.parse(text);
  } catch {
    // not JSON; keep the text
  }
  return { status: response.status, data };
}
const photoForm = (bytes, name = 'photo.png', type = 'image/png') => {
  const form = new FormData();
  form.append('file', new Blob([bytes], { type }), name);
  return form;
};

const made = { tenants: [], users: [] };
async function makeTenant(slug, bookingType) {
  const { data, error } = await supabase
    .from('tenants')
    .insert({ slug, business_name: `walk ${slug}`, assistant_name: 'Probe' })
    .select('id, slug')
    .single();
  if (error) throw new Error(`create ${slug}: ${error.message}`);
  made.tenants.push(data.id);
  const config = bookingType === 'per_room' ? { timezone: 'Asia/Manila', booking_type: 'per_room' } : { timezone: 'Asia/Manila' };
  await supabase.from('tenant_applications').insert({ tenant_id: data.id, application_key: 'bookings', config });
  const { data: slot } = await supabase
    .from('slots')
    .insert({ tenant_id: data.id, name: 'Night', start_time: '14:00', duration: '22 hours' })
    .select('id')
    .single();

  const email = `walk-${slug}-${Date.now()}@example.com`;
  const password = randomBytes(18).toString('base64url');
  const { data: user, error: userError } = await supabase.auth.admin.createUser({ email, password, email_confirm: true });
  if (userError) throw new Error(`user for ${slug}: ${userError.message}`);
  made.users.push(user.user.id);
  await supabase.from('memberships').insert({ user_id: user.user.id, tenant_id: data.id });

  const login = await fetch(`${BASE}/api/t/${slug}/admin/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];
  if (login.status !== 200 || !cookie) throw new Error(`login ${slug}: ${login.status}`);
  return { id: data.id, slug, slotId: slot.id, cookie };
}

try {
  const rooms = await makeTenant('routes-rooms', 'per_room');
  const whole = await makeTenant('routes-whole', 'whole_resort');
  const { data: wholeUnit } = await supabase.from('units').insert({ tenant_id: whole.id, name: 'Whole property' }).select('id').single();

  // 1. No staff cookie: every new route is 401, before anything else is said.
  {
    const results = await Promise.all([
      call('GET', rooms.slug, '/accommodations'),
      call('POST', rooms.slug, '/accommodations', { json: { name: 'x' } }),
      call('PATCH', rooms.slug, '/accommodations/1', { json: { active: false } }),
      call('PUT', rooms.slug, '/accommodations/1/rates', { json: { rates: [] } }),
      call('POST', rooms.slug, '/accommodations/1/images', { form: photoForm(PNG) }),
      call('DELETE', rooms.slug, '/accommodations/1/images/1'),
      call('POST', rooms.slug, '/bookings/quote', { json: { unitId: 1, slotId: 1, date: monday } }),
    ]);
    check(results.every((r) => r.status === 401), 'no staff cookie: every new route is 401', results.map((r) => r.status).join(' '));
  }

  // 2. The cookie is per tenant: routes-rooms' cookie on routes-whole is 401.
  {
    const r = await call('GET', whole.slug, '/bookings/setup', { cookie: rooms.cookie });
    check(r.status === 401, "one tenant's staff cookie is not another's", `${r.status} ${r.data?.error ?? ''}`);
  }

  // 3. whole_resort: rooms and quotes are 404; setup says whole_resort.
  {
    const list = await call('GET', whole.slug, '/accommodations', { cookie: whole.cookie });
    const add = await call('POST', whole.slug, '/accommodations', { cookie: whole.cookie, json: { name: 'A room' } });
    const q = await call('POST', whole.slug, '/bookings/quote', { cookie: whole.cookie, json: { unitId: wholeUnit.id, slotId: whole.slotId, date: monday } });
    const setup = await call('GET', whole.slug, '/bookings/setup', { cookie: whole.cookie });
    check(
      list.status === 404 && add.status === 404 && q.status === 404 && setup.status === 200 && setup.data.bookingType === 'whole_resort',
      'whole_resort: rooms and quotes are 404, setup says whole_resort',
      `list ${list.status} · add ${add.status} · quote ${q.status} · setup ${setup.status} ${setup.data.bookingType}`,
    );
  }

  // 4. per_room: add two rooms, rate them, and list them.
  const garden = await call('POST', rooms.slug, '/accommodations', { cookie: rooms.cookie, json: { name: 'Garden Room', capacity: 2, sortOrder: 1 } });
  const family = await call('POST', rooms.slug, '/accommodations', { cookie: rooms.cookie, json: { name: 'Family Room', capacity: 6, sortOrder: 2 } });
  const gardenRates = await call('PUT', rooms.slug, `/accommodations/${garden.data.id}/rates`, {
    cookie: rooms.cookie,
    json: { rates: [{ slotId: rooms.slotId, weekdayPrice: 350000, weekendPrice: 450000 }] },
  });
  await call('PUT', rooms.slug, `/accommodations/${family.data.id}/rates`, {
    cookie: rooms.cookie,
    json: { rates: [{ slotId: rooms.slotId, weekdayPrice: 600000, weekendPrice: 750000 }] },
  });
  const badRate = await call('PUT', rooms.slug, `/accommodations/${garden.data.id}/rates`, {
    cookie: rooms.cookie,
    json: { rates: [{ slotId: rooms.slotId, weekdayPrice: 3500.5, weekendPrice: 1 }] },
  });
  const setup = await call('GET', rooms.slug, '/bookings/setup', { cookie: rooms.cookie });
  check(
    garden.status === 201 && family.status === 201 && gardenRates.status === 200 && gardenRates.data.rates[0]?.weekdayPrice === 350000
      && badRate.status === 400 && setup.data.bookingType === 'per_room' && setup.data.currency === 'PHP',
    'per_room: rooms added and rated; a float price is a 400; setup says per_room',
    `rooms ${garden.status}/${family.status} · rates ${gardenRates.status} · float ${badRate.status} ${badRate.data?.error} · setup ${setup.data.bookingType} ${setup.data.currency}`,
  );

  // 5. The quote, then a 2-room booking with a forged price in the body: the
  //    stored total is the quote's, not the body's.
  const rooms2 = [{ unitId: garden.data.id, guestCount: 2 }, { unitId: family.data.id, guestCount: 4 }];
  const q = await call('POST', rooms.slug, '/bookings/quote', { cookie: rooms.cookie, json: { rooms: rooms2, slotId: rooms.slotId, date: monday } });
  const booked = await call('POST', rooms.slug, '/bookings', {
    cookie: rooms.cookie,
    json: { rooms: rooms2, slotId: rooms.slotId, date: monday, guestName: 'Walk Guest', price: 1, total: 1 },
  });
  check(
    // Family Room, 4 guests: 2 above the default standard of 2, at ₱250
    // (plan/extra-guests.md): 350000 + (600000 + 50000) = 1000000.
    q.status === 200 && q.data.total === 1000000 && booked.status === 201 && booked.data.total === 1000000
      && booked.data.bookings.every((b) => b.price !== 1 && b.groupId === booked.data.groupId),
    'a forged price in the body is ignored: stored total = quote',
    `quote ${q.status} ${q.data.total} · booked ${booked.status} total ${booked.data.total} · prices ${booked.data.bookings?.map((b) => b.price).join('+')}`,
  );

  // 6. Another tenant's unit id, and a clash, through the route.
  {
    const foreign = await call('POST', rooms.slug, '/bookings', {
      cookie: rooms.cookie,
      json: { unitId: wholeUnit.id, guestCount: 1, slotId: rooms.slotId, date: monday, guestName: 'x' },
    });
    const clash = await call('POST', rooms.slug, '/bookings', {
      cookie: rooms.cookie,
      json: { unitId: garden.data.id, guestCount: 1, slotId: rooms.slotId, date: monday, guestName: 'x' },
    });
    check(
      foreign.status === 400 && foreign.data.error === 'No such unit or slot.' && clash.status === 409,
      "another tenant's unit is a 400 'No such unit or slot.'; a clash is a 409",
      `foreign ${foreign.status} ${foreign.data.error} · clash ${clash.status}`,
    );
  }

  // 7. The room filter.
  {
    const onlyGarden = await call('GET', rooms.slug, `/bookings?from=${monday}&unit=${garden.data.id}`, { cookie: rooms.cookie });
    const foreignRoom = await call('GET', rooms.slug, `/bookings?from=${monday}&unit=${wholeUnit.id}`, { cookie: rooms.cookie });
    check(
      onlyGarden.status === 200 && onlyGarden.data.length === 1 && onlyGarden.data[0].unitId === garden.data.id && foreignRoom.data.length === 0,
      "?unit= shows one room; another tenant's room shows []",
      `garden ${onlyGarden.data.length} · foreign ${foreignRoom.status} ${foreignRoom.data.length}`,
    );
  }

  // 8. Photos: a real upload is served; SVG, oversize and another tenant's
  //    room are refused.
  const upload = await call('POST', rooms.slug, `/accommodations/${garden.data.id}/images`, { cookie: rooms.cookie, form: photoForm(PNG) });
  const served = upload.status === 201 ? await fetch(upload.data.url) : null;
  {
    const svg = await call('POST', rooms.slug, `/accommodations/${garden.data.id}/images`, {
      cookie: rooms.cookie,
      form: photoForm(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), 'x.png', 'image/png'),
    });
    const huge = await call('POST', rooms.slug, `/accommodations/${garden.data.id}/images`, {
      cookie: rooms.cookie,
      form: photoForm(Buffer.concat([PNG, Buffer.alloc(3 * 1024 * 1024)])),
    });
    const foreign = await call('POST', rooms.slug, `/accommodations/${wholeUnit.id}/images`, { cookie: rooms.cookie, form: photoForm(PNG) });
    check(
      upload.status === 201 && served?.status === 200 && svg.status === 400 && huge.status === 400 && foreign.status === 404,
      "photo: uploaded and served; an SVG named .png, 3 MB, and another tenant's room refused",
      `upload ${upload.status} served ${served?.status} · svg ${svg.status} ${svg.data.error} · huge ${huge.status} · foreign room ${foreign.status}`,
    );
  }

  // 9. Reorder, then delete: via the wrong room is 404; twice is 404.
  {
    const imageId = upload.data.id;
    const reorder = await call('PATCH', rooms.slug, `/accommodations/${garden.data.id}/images/${imageId}`, { cookie: rooms.cookie, json: { sortOrder: 3 } });
    const wrongRoom = await call('DELETE', rooms.slug, `/accommodations/${family.data.id}/images/${imageId}`, { cookie: rooms.cookie });
    const removed = await call('DELETE', rooms.slug, `/accommodations/${garden.data.id}/images/${imageId}`, { cookie: rooms.cookie });
    const again = await call('DELETE', rooms.slug, `/accommodations/${garden.data.id}/images/${imageId}`, { cookie: rooms.cookie });
    const { data: objects } = await supabase.storage.from('unit-images').list(`${rooms.id}/${garden.data.id}`);
    check(
      reorder.status === 200 && wrongRoom.status === 404 && removed.status === 200 && again.status === 404 && objects?.length === 0,
      'photo: reordered; wrong room 404; removed with its object; twice 404',
      `reorder ${reorder.status} · wrong room ${wrongRoom.status} · removed ${removed.status} · again ${again.status} · objects ${objects?.length}`,
    );
  }

  // 10. Room changes: retire one; another tenant's room and a missing one are 404.
  {
    const retire = await call('PATCH', rooms.slug, `/accommodations/${family.data.id}`, { cookie: rooms.cookie, json: { active: false } });
    const foreign = await call('PATCH', rooms.slug, `/accommodations/${wholeUnit.id}`, { cookie: rooms.cookie, json: { active: false } });
    const missing = await call('GET', rooms.slug, '/accommodations/999999999', { cookie: rooms.cookie });
    const { data: wholeStill } = await supabase.from('units').select('active').eq('id', wholeUnit.id).single();
    check(
      retire.status === 200 && retire.data.active === false && foreign.status === 404 && missing.status === 404 && wholeStill.active === true,
      "a room retired; another tenant's and a missing room are 404, and the foreign one is untouched",
      `retire ${retire.status} ${retire.data.active} · foreign ${foreign.status} · missing ${missing.status} · foreign still active: ${wholeStill.active}`,
    );
  }
} finally {
  for (const tenantId of made.tenants) {
    const { data: folders } = await supabase.storage.from('unit-images').list(`${tenantId}`);
    for (const folder of folders ?? []) {
      const { data: files } = await supabase.storage.from('unit-images').list(`${tenantId}/${folder.name}`);
      if (files?.length) await supabase.storage.from('unit-images').remove(files.map((f) => `${tenantId}/${folder.name}/${f.name}`));
    }
  }
  for (const id of made.users) await supabase.auth.admin.deleteUser(id);
  if (made.tenants.length) await supabase.from('tenants').delete().in('id', made.tenants);
}

console.log(failures === 0 ? '\nALL PHASE 3 WALK CHECKS PASS' : `\n${failures} WALK CHECK(S) FAILED`);
process.exitCode = failures === 0 ? 0 : 1;
