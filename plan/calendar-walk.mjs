// calendar-walk.mjs — the calendar page in a real browser, against a running
// dev server (plan/calendar.md Phases 3–4, D-103).
//
// Villa's October 2026 as it really is (it has partly and fully booked
// dates), and harbor's November with three seeded facts: 25 Nov closed
// ("Walk closed"), 27 Nov a holiday ("Walk holiday") with one pending
// request on it, so two markers share a date. Seeded only where harbor has
// nothing, and removed at the end, whatever happens.
//
// Checks: the legend; the "Go to month" select; the month grid's 35 dates, each a button whose
// aria-label is the date in a sentence; the states drawn; a click opens the
// Day view and puts it in the address; Back returns to the month; the Day
// view lists the pending request and links to Bookings at that date; the
// week shows rooms × days of slot chips; at 375 px the PAGE never scrolls
// sideways. Screenshots at 1280 and 375, light and dark.
//
//   (cd packages/db && node --conditions=react-server --env-file=../../.env ../../plan/calendar-walk.mjs [base-url])

import { randomBytes } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { supabase } from '../packages/db/dist/service.js';
import { openBrowser } from './ui-refresh-cdp.mjs';

const BASE = process.argv[2] ?? 'http://localhost:3000';
const OUT = join(dirname(fileURLToPath(import.meta.url)), 'ui-refresh', 'calendar');
let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cellLabel = (n) => `document.querySelectorAll('.cal-month button.cal-day')[${n}]?.getAttribute('aria-label') ?? ''`;
// The page's own width, against the phone's: the other walks' strict test (ui-refresh Phase 7).
const noSideScroll = 'document.documentElement.scrollWidth <= 375';

const { data: tenants } = await supabase.from('tenants').select('id, slug').in('slug', ['villa', 'harbor']);
const harbor = tenants.find((t) => t.slug === 'harbor');
const villa = tenants.find((t) => t.slug === 'villa');

const users = [];
const seeded = { days: [], booking: null };
const browsers = [];
try {
  // --- the seed ---------------------------------------------------------------
  const { data: existing } = await supabase.from('rate_calendar').select('day').eq('tenant_id', harbor.id).in('day', ['2026-11-25', '2026-11-27']);
  if (existing.length) throw new Error(`harbor already has calendar rows on ${existing.map((r) => r.day).join(', ')}; not seeding over them`);
  const days = await supabase.from('rate_calendar').insert([
    { tenant_id: harbor.id, day: '2026-11-25', kind: 'closed', label: 'Walk closed', surcharge: 0 },
    { tenant_id: harbor.id, day: '2026-11-27', kind: 'holiday', label: 'Walk holiday', surcharge: 0 },
  ]);
  if (days.error) throw new Error(`rate_calendar: ${days.error.message}`);
  seeded.days = ['2026-11-25', '2026-11-27'];
  const { data: rate } = await supabase.from('unit_rates').select('unit_id, slot_id').eq('tenant_id', harbor.id).limit(1).single();
  const booking = await supabase
    .from('bookings')
    .insert({ tenant_id: harbor.id, unit_id: rate.unit_id, slot_id: rate.slot_id, booked_date: '2026-11-27', guest_name: 'Walk guest', guest_phone: '0917 555 0101', guest_count: 2, status: 'pending' })
    .select('id')
    .single();
  if (booking.error) throw new Error(`booking: ${booking.error.message}`);
  seeded.booking = booking.data.id;

  // --- a staff member of each tenant --------------------------------------------
  const cookies = {};
  for (const t of [villa, harbor]) {
    const email = `calendar-walk-${t.slug}-${Date.now()}@example.com`;
    const password = randomBytes(18).toString('base64url');
    const { data, error } = await supabase.auth.admin.createUser({ email, password, email_confirm: true });
    if (error) throw new Error(error.message);
    users.push(data.user.id);
    const m = await supabase.from('memberships').insert({ user_id: data.user.id, tenant_id: t.id, role: 'staff' });
    if (m.error) throw new Error(m.error.message);
    const r = await fetch(`${BASE}/api/t/${t.slug}/admin/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
    cookies[t.slug] = (r.headers.getSetCookie?.() ?? []).find((x) => x.startsWith('rag_admin='))?.split(';')[0]?.slice('rag_admin='.length);
    if (!cookies[t.slug]) throw new Error(`login failed for ${t.slug}`);
  }

  for (const scheme of ['light', 'dark']) {
    const browser = await openBrowser({ scheme });
    browsers.push(browser);
    const { page } = browser;
    const first = scheme === 'light';
    for (const t of ['villa', 'harbor']) {
      await page.send('Network.setCookie', { name: 'rag_admin', value: cookies[t], url: `${BASE}/api/t/${t}/`, path: `/api/t/${t}` });
    }
    const shot = (name) => page.shot(join(OUT, `${name}-${scheme}.png`));
    const openMonth = async (slug, date) => {
      await page.goto(`${BASE}/t/${slug}/admin/calendar?view=month&date=${date}`);
      return page.until("document.querySelectorAll('.cal-month button.cal-day').length >= 28", 30000);
    };

    // 1. Villa's October: the grid, the legend, the states.
    await page.viewport(1280);
    check(await openMonth('villa', '2026-10-01'), `1. [${scheme}] villa's October grid loads`);
    if (first) {
      const cells = await page.eval("document.querySelectorAll('.cal-month button.cal-day').length");
      const legend = await page.eval("[...document.querySelectorAll('.cal-legend li')].map(li => li.textContent.trim())");
      const states = await page.eval("[...new Set([...document.querySelectorAll('.cal-month button.cal-day')].map(b => [...b.classList].find(c => ['available','partial','full','closed','none'].includes(c))))]");
      const unlabelled = await page.eval("[...document.querySelectorAll('.cal-month button.cal-day')].filter(b => !/^\\w+day \\d+ \\w+ \\d{4}/.test(b.getAttribute('aria-label') ?? '')).length");
      check(cells === 35, '1b. 35 dates: Monday 28 Sep to Sunday 1 Nov', String(cells));
      check(legend.join('|') === 'Available|Partly booked|Fully booked|Closed|Holiday|Peak|1Pending requests|Today|Past, or beyond the booking window', '1c. the legend names every swatch and marker', legend.join(' | '));
      check(states.includes('full') && states.includes('partial') && states.includes('available'), '1d. villa shows available, partly and fully booked dates', states.join(','));
      check(unlabelled === 0, '1e. every date is a button named by a sentence', `${unlabelled} without`);
      const full = await page.eval("[...document.querySelectorAll('.cal-month button.cal-day.full')][0]?.getAttribute('aria-label') ?? ''");
      check(/fully booked, \d+ of \d+ taken/.test(full), '1f. a full date says so, with its count', full);
      check(await page.eval("document.querySelectorAll('.cal-month button.cal-day.today').length === 1"), '1g. exactly one date is ringed as today');
      const words = await page.eval("({ dimOpen: [...document.querySelectorAll('.cal-month button.cal-day.dim')].filter(b => b.querySelector('.cal-word')?.textContent === 'Open').length, dim: document.querySelectorAll('.cal-month button.cal-day.dim').length, liveOpen: [...document.querySelectorAll('.cal-month button.cal-day.available:not(.dim)')].filter(b => b.querySelector('.cal-word')?.textContent === 'Open').length })");
      check(words.dim > 0 && words.dimOpen === 0 && words.liveOpen > 0, '1h. no "Open" on a past date; bookable dates still say it', JSON.stringify(words));
      const bg = await page.eval("(() => { const c = (e) => e && getComputedStyle(e).backgroundColor; const card = c(document.querySelector('.cal-head').closest('.card')); const others = [...document.querySelectorAll('.cal-month button.cal-day.other-month')]; const inMonth = c(document.querySelector('.cal-month button.cal-day.available:not(.other-month):not(.dim)')); return { others: others.length, plain: others.every(e => c(e) === card), card, inMonth }; })()");
      check(bg.others === 4 && bg.plain && bg.inMonth !== bg.card, '1i. the neighbouring months: 4 plain days; the open October dates are tinted', JSON.stringify(bg));
    }
    await shot('villa-month-1280');

    // 2. Harbor's November: closed, a holiday with a pending request.
    check(await openMonth('harbor', '2026-11-01'), `2. [${scheme}] harbor's November grid loads`);
    if (first) {
      const twentyFifth = await page.eval(`[...document.querySelectorAll('.cal-month button.cal-day')].find(b => b.getAttribute('aria-label').startsWith('Wednesday 25 November'))?.getAttribute('aria-label') ?? ''`);
      const t27 = await page.eval(`(() => { const b = [...document.querySelectorAll('.cal-month button.cal-day')].find(b => b.getAttribute('aria-label').startsWith('Friday 27 November')); return { label: b.getAttribute('aria-label'), star: !!b.querySelector('.cal-marker.holiday'), pending: b.querySelector('.cal-pending')?.textContent ?? null }; })()`);
      check(twentyFifth === 'Wednesday 25 November 2026: closed (Walk closed)', '2b. the 25th: closed, with its label', twentyFifth);
      check(t27.star && t27.pending === '1' && /1 pending request, holiday: Walk holiday/.test(t27.label), '2c. the 27th: the holiday star AND the pending count, both in its sentence', JSON.stringify(t27));
    }
    await shot('harbor-month-1280');

    // 3. Click the 27th: the Day view, in the address; then Back.
    if (first) {
      await page.eval(`[...document.querySelectorAll('.cal-month button.cal-day')].find(b => b.getAttribute('aria-label').startsWith('Friday 27 November')).click()`);
      check(await page.until("location.search.includes('view=day') && location.search.includes('date=2026-11-27') && !!document.querySelector('.cal-dayview')", 30000), '3. a click opens the Day view, and the address says so');
      check(await page.until("[...document.querySelectorAll('.cal-booking')].some(li => li.textContent.includes('Walk guest') && li.textContent.includes('pending'))", 30000), '3b. the Day view lists the pending request');
      const href = await page.eval("document.querySelector('.cal-day-summary a.button')?.getAttribute('href')");
      check(href === '/t/harbor/admin/bookings?from=2026-11-27', '3c. "Open in Bookings" goes to Bookings at that date', href);
      await page.shot(join(OUT, `harbor-day-1280-${scheme}.png`));
      await page.eval('history.back()');
      check(await page.until("location.search.includes('view=month') && document.querySelectorAll('.cal-month button.cal-day').length >= 28", 30000), '3d. Back returns to the month');

      // 3c2. The 28th: the 27th's Night request runs into it; the Day view
      //      shows that booking's guest under the slot it overlaps.
      await page.goto(`${BASE}/t/harbor/admin/calendar?view=day&date=2026-11-28`);
      await page.until("!!document.querySelector('.cal-dayview')", 30000);
      const card = await page.until("[...document.querySelectorAll('.cal-booking')].some(c => c.textContent.includes('Walk guest'))", 30000)
        ? await page.eval("(() => { const c = [...document.querySelectorAll('.cal-booking')].find(c => c.textContent.includes('Walk guest')); const facts = Object.fromEntries([...c.querySelectorAll('dt')].map(dt => [dt.textContent, dt.nextElementSibling.textContent])); return { facts, tel: c.querySelector('a[href^=\"tel:\"]')?.getAttribute('href') ?? null }; })()")
        : null;
      check(card?.facts?.Stay === 'Since Fri 27 Nov · Night' && card?.facts?.Guests === '2' && card?.facts?.Phone === '0917 555 0101' && card?.tel === 'tel:0917 555 0101' && card?.facts?.From === 'Staff',
        '3c2. a stay from the night before shows its guest on the 28th: since, guests, phone (a tel: link), source', JSON.stringify(card));
      await page.shot(join(OUT, `harbor-day-overlap-1280-${scheme}.png`));
    }

    // 3e. The month picker IS the month view's title (no h2 beside it):
    //     pick January 2027 and the grid and the address follow. Week and
    //     day keep a text title and have no picker.
    if (first) {
      await openMonth('harbor', '2026-11-01');
      const head = await page.eval(`(() => { const s = document.querySelector('.cal-head select.cal-month-select'); return { h2: !!document.querySelector('.cal-head h2'), value: s?.value ?? null, options: s?.options.length ?? 0 }; })()`);
      await page.eval(`(() => { const s = document.querySelector('.cal-head select.cal-month-select'); s.value = '2027-01'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
      const moved = await page.until("location.search.includes('date=2027-01-01') && document.querySelector('.cal-head select.cal-month-select')?.value === '2027-01' && document.querySelector('.cal-month button.cal-day')?.getAttribute('aria-label')?.includes('December 2026')", 30000);
      check(!head.h2 && head.value === '2026-11' && head.options === 25 && moved, '3e. month view: the picker is the title (no h2), 25 months; January 2027 picked, the grid and the address follow', JSON.stringify(head));
      await page.goto(`${BASE}/t/harbor/admin/calendar?view=week&date=2026-10-21`);
      await page.until("document.querySelectorAll('.cal-week tbody tr').length > 0", 30000);
      const week = await page.eval(`({ h2: document.querySelector('.cal-head h2')?.textContent ?? null, picker: !!document.querySelector('.cal-month-select') })`);
      check(week.h2 === '19 – 25 Oct 2026' && !week.picker, '3f. week view: a text title, no month picker', JSON.stringify(week));
      // 3g. The step buttons name the view's step.
      const steps = {};
      for (const v of ['month', 'week', 'day']) {
        await page.eval(`[...document.querySelectorAll('.segmented[aria-label="View"] button')].find(b => b.textContent === '${v[0].toUpperCase() + v.slice(1)}').click()`);
        await page.until(`location.search.includes('view=${v}') && !!document.querySelector('.cal-month, .cal-week, .cal-dayview')`, 30000);
        steps[v] = await page.eval("[...document.querySelectorAll('.cal-head .cal-steps > button')].map(b => b.textContent.trim()).join(' | ')");
      }
      check(steps.month === 'Previous month | Today | Next month' && steps.week === 'Previous week | Today | Next week' && steps.day === 'Previous day | Today | Next day', '3g. the step buttons say month, week or day with the view', JSON.stringify(steps));
    }

    // 4. The week of harbor's pending requests (21–22 Oct).
    await page.goto(`${BASE}/t/harbor/admin/calendar?view=week&date=2026-10-21`);
    check(await page.until("document.querySelectorAll('.cal-week tbody tr').length > 0", 30000), `4. [${scheme}] harbor's week loads`);
    if (first) {
      const rows = await page.eval("document.querySelectorAll('.cal-week tbody tr').length");
      const chips = await page.eval("document.querySelectorAll('.cal-week td .slot-chip').length");
      const heads = await page.eval("document.querySelectorAll('.cal-week thead button.cal-day').length");
      check(rows === 4 && chips === 56 && heads === 7, '4b. 4 rooms × 7 days, 56 slot chips, 7 day headers that are buttons', `${rows} rows · ${chips} chips · ${heads} heads`);
      const fits = await page.eval("(() => { const s = document.querySelector('.cal-week-scroll'); return s.scrollWidth <= s.clientWidth + 1; })()");
      check(fits, '4c. at 1280 px all seven days fit: the week does not scroll');
    }
    await shot('harbor-week-1280');

    // 5. A phone: the grid and the week, and no sideways PAGE scroll.
    await page.viewport(375);
    await openMonth('harbor', '2026-11-01');
    await sleep(300);
    check(await page.eval(noSideScroll), `5. [${scheme}] 375 px month: the page does not scroll sideways`, String(await page.eval('document.documentElement.scrollWidth')));
    await shot('harbor-month-375');
    await page.goto(`${BASE}/t/harbor/admin/calendar?view=week&date=2026-10-21`);
    await page.until("document.querySelectorAll('.cal-week tbody tr').length > 0", 30000);
    check(await page.eval(noSideScroll), `5b. [${scheme}] 375 px week: the table scrolls inside itself, not the page`);
    await shot('harbor-week-375');
  }
} catch (error) {
  check(false, 'walk', error.message);
} finally {
  for (const b of browsers) b.close();
  if (seeded.booking) await supabase.from('bookings').delete().eq('id', seeded.booking);
  if (seeded.days.length) await supabase.from('rate_calendar').delete().eq('tenant_id', harbor.id).in('day', seeded.days);
  for (const id of users) await supabase.auth.admin.deleteUser(id);
  const { count } = await supabase.from('rate_calendar').select('day', { count: 'exact', head: true }).eq('tenant_id', harbor.id).in('day', ['2026-11-25', '2026-11-27']);
  const { count: left } = await supabase.from('bookings').select('id', { count: 'exact', head: true }).eq('tenant_id', harbor.id).eq('guest_name', 'Walk guest');
  check(count === 0 && left === 0, 'cleanup: the seeded days and booking are gone', `${count} days · ${left} bookings`);
}

console.log(`\n${failures === 0 ? 'all passed' : `${failures} FAILED`}`);
process.exit(failures ? 1 : 0);
