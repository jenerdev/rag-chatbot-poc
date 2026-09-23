'use client';

// S-3 · Bookings. Staff see a range of dates, every slot on each date as open
// or taken, and the bookings that start on that date. They can book a slot and
// cancel a booking.
//
// Rendered by app/t/[tenant]/admin/bookings/page.tsx, which has already
// checked on the server that the tenant exists and has the bookings
// application. Every route this screen calls is admin-only, so it starts the
// same way the knowledge-base screen does: is there a session for THIS tenant?
//
// What this screen does NOT do: decide whether a slot is free. It shows what
// check_availability says, and it attempts the booking. If the slot was taken
// in the meantime, the server's 409 is shown as-is. The rule lives in one
// place, the exclusion constraint (plan/bookings.md § 2.2).

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { BookingSummary, SlotAvailability, SlotSummary, UnitSummary } from '@rag/bookings';
import { BrandHeader } from '@/components/brand-header';
import { LoginForm, describeFailure } from '@/components/admin-login';

export interface BookingsScreenProps {
  slug: string;
  businessName: string;
  logoUrl: string | null;
  bannerUrl: string | null;
}

interface Setup {
  timezone: string;
  /** Today in the TENANT'S timezone, computed on the server, not from this browser's clock. */
  today: string;
  units: UnitSummary[];
  slots: SlotSummary[];
}

type Auth = 'checking' | 'out' | 'in';
type Notice = { message: string; kind: 'ok' | 'error' } | null;

// How many days the screen shows at once. Under both server limits:
// availability allows 31, the admin list 92.
const RANGE_DAYS = 14;

/** YYYY-MM-DD plus n days. Done on UTC midnights, so no DST edge can shift the date. */
function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** "Sat 10 Oct". Formatted as UTC because the date string has no zone; it is a calendar date, not an instant. */
function dayLabel(date: string): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  });
}

/** "22:00:00" → "22h", "09:30:00" → "9h 30m". Anything else is shown as Postgres wrote it. */
function durationLabel(duration: string): string {
  const match = /^(\d{2}):(\d{2}):00$/.exec(duration);
  if (!match) return duration;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
}

function BookingRow({
  booking,
  onCancel,
  busy,
}: {
  booking: BookingSummary;
  onCancel: (booking: BookingSummary) => void;
  busy: boolean;
}) {
  const cancelled = booking.status === 'cancelled';
  return (
    <div className={`booking${cancelled ? ' cancelled' : ''}`}>
      <div className="booking-main">
        <span className="booking-slot">{booking.slot}</span>
        <span className="booking-guest">{booking.guestName}</span>
        <span className="booking-meta">
          {[
            booking.guestCount ? `${booking.guestCount} guests` : null,
            booking.guestPhone,
            booking.status === 'confirmed' ? null : booking.status,
          ]
            .filter(Boolean)
            .join(' · ')}
        </span>
        {!cancelled && (
          <button type="button" disabled={busy} onClick={() => onCancel(booking)}>
            Cancel
          </button>
        )}
      </div>
      {/* Notes are a React child, so whatever staff typed is escaped (CLAUDE.md § Conventions). */}
      {booking.notes && <div className="booking-notes">{booking.notes}</div>}
    </div>
  );
}

export function BookingsScreen({ slug, businessName, logoUrl, bannerUrl }: BookingsScreenProps) {
  const api = `/api/t/${slug}`;
  const [auth, setAuth] = useState<Auth>('checking');
  const [setup, setSetup] = useState<Setup | null>(null);
  const [from, setFrom] = useState<string | null>(null);
  const [availability, setAvailability] = useState<SlotAvailability[] | null>(null);
  const [bookings, setBookings] = useState<BookingSummary[] | null>(null);
  const [loadMessage, setLoadMessage] = useState('Loading…');
  const [notice, setNotice] = useState<Notice>(null);
  const [busy, setBusy] = useState(false);

  // The form.
  const [unitId, setUnitId] = useState<number | null>(null);
  const [slotId, setSlotId] = useState<number | null>(null);
  const [date, setDate] = useState('');
  const [guestName, setGuestName] = useState('');
  const [guestPhone, setGuestPhone] = useState('');
  const [guestCount, setGuestCount] = useState('');
  const [notes, setNotes] = useState('');

  const unauthorized = useCallback(() => {
    setAuth('out');
    setSetup(null);
    setAvailability(null);
    setBookings(null);
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const response = await fetch(`${api}/admin/session`);
        const body = await response.json();
        setAuth(body.admin === true ? 'in' : 'out');
      } catch {
        setAuth('out');
      }
    })();
  }, [api]);

  // Once logged in: units, slots, and the tenant's today. The range starts at
  // today, and the form defaults to the first unit, the first slot and today.
  useEffect(() => {
    if (auth !== 'in') return;
    void (async () => {
      let response: Response | null = null;
      try {
        response = await fetch(`${api}/bookings/setup`);
        if (response.status === 401) return unauthorized();
        if (!response.ok) throw new Error('failed');
        const body: Setup = await response.json();
        setSetup(body);
        setFrom(body.today);
        setDate(body.today);
        setUnitId(body.units[0]?.id ?? null);
        setSlotId(body.slots[0]?.id ?? null);
      } catch (error) {
        setLoadMessage(await describeFailure(error as Error, response));
      }
    })();
  }, [api, auth, unauthorized]);

  const to = from ? addDays(from, RANGE_DAYS - 1) : null;

  // Availability and bookings for the range, in parallel. They are two calls
  // on purpose: availability is the shape the chatbot will see, with no guest
  // data, and the bookings list is the admin-only one that has it.
  const load = useCallback(async () => {
    if (!from || !to) return;
    let response: Response | null = null;
    try {
      const range = `from=${from}&to=${to}`;
      const [a, b] = await Promise.all([
        fetch(`${api}/bookings/availability?${range}`),
        fetch(`${api}/bookings?${range}`),
      ]);
      if (a.status === 401 || b.status === 401) return unauthorized();
      response = a.ok ? b : a;
      if (!a.ok || !b.ok) throw new Error('failed');
      setAvailability(await a.json());
      setBookings(await b.json());
    } catch (error) {
      setAvailability(null);
      setBookings(null);
      setLoadMessage(await describeFailure(error as Error, response));
    }
  }, [api, from, to, unauthorized]);

  useEffect(() => {
    void load();
  }, [load]);

  const logout = useCallback(async () => {
    await fetch(`${api}/admin/session`, { method: 'DELETE' }).catch(() => undefined);
    unauthorized();
  }, [api, unauthorized]);

  const book = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();
      setNotice(null);
      setBusy(true);
      let response: Response | null = null;
      try {
        response = await fetch(`${api}/bookings`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            unitId,
            slotId,
            date,
            guestName,
            guestPhone: guestPhone || null,
            guestCount: guestCount === '' ? null : Number(guestCount),
            notes: notes || null,
          }),
        });
        if (response.status === 401) return unauthorized();
        if (!response.ok) throw new Error('failed');
        const created: BookingSummary = await response.json();
        setNotice({ message: `Booked ${created.slot} on ${dayLabel(created.date)} for ${created.guestName}.`, kind: 'ok' });
        setGuestName('');
        setGuestPhone('');
        setGuestCount('');
        setNotes('');
        void load();
      } catch (error) {
        // A 409 lands here with the server's own sentence: "That slot on …
        // overlaps an existing booking." It is not rephrased.
        setNotice({ message: await describeFailure(error as Error, response), kind: 'error' });
      } finally {
        setBusy(false);
      }
    },
    [api, date, guestCount, guestName, guestPhone, load, notes, slotId, unauthorized, unitId],
  );

  const cancel = useCallback(
    async (booking: BookingSummary) => {
      if (!window.confirm(`Cancel ${booking.slot} on ${dayLabel(booking.date)} for ${booking.guestName}?`)) return;
      setNotice(null);
      setBusy(true);
      let response: Response | null = null;
      try {
        response = await fetch(`${api}/bookings/${booking.id}`, { method: 'DELETE' });
        if (response.status === 401) return unauthorized();
        if (!response.ok) throw new Error('failed');
        setNotice({ message: `Cancelled ${booking.slot} on ${dayLabel(booking.date)}. The slot is free again.`, kind: 'ok' });
        void load();
      } catch (error) {
        setNotice({ message: `Could not cancel: ${await describeFailure(error as Error, response)}`, kind: 'error' });
      } finally {
        setBusy(false);
      }
    },
    [api, load, unauthorized],
  );

  // Group both lists by date, in range order.
  const days = useMemo(() => {
    if (!from || !availability || !bookings) return [];
    return Array.from({ length: RANGE_DAYS }, (_, i) => {
      const day = addDays(from, i);
      return {
        day,
        slots: availability.filter((a) => a.date === day),
        bookings: bookings.filter((b) => b.date === day),
      };
    });
  }, [availability, bookings, from]);

  const multipleUnits = (setup?.units.length ?? 0) > 1;

  const header = (
    <BrandHeader businessName={businessName} logoUrl={logoUrl} bannerUrl={bannerUrl} subtitle="Bookings">
      {auth === 'in' && (
        <button type="button" className="link" onClick={logout}>
          Log out
        </button>
      )}
      <Link className="button" href={`/t/${slug}/admin`}>
        Knowledge base
      </Link>
      <Link className="button" href={`/t/${slug}`}>
        ← Chat
      </Link>
    </BrandHeader>
  );

  if (auth !== 'in') {
    return (
      <>
        {header}
        <main>
          {auth === 'checking' ? (
            <div className="small muted">Checking your session…</div>
          ) : (
            <LoginForm api={api} slug={slug} onLoggedIn={() => setAuth('in')} />
          )}
        </main>
      </>
    );
  }

  if (!setup || !from || !to) {
    return (
      <>
        {header}
        <main>
          <div className="small">{loadMessage}</div>
        </main>
      </>
    );
  }

  return (
    <>
      {header}

      <main>
        <div className={notice ? `notice ${notice.kind}` : 'notice hidden'}>{notice?.message}</div>

        <section className="card">
          <h2>New booking</h2>
          <form onSubmit={book}>
            <div className="field-row">
              {multipleUnits && (
                <div className="field">
                  <label htmlFor="unit">Unit</label>
                  <select id="unit" value={unitId ?? ''} onChange={(e) => setUnitId(Number(e.target.value))}>
                    {setup.units.map((u) => (
                      <option key={u.id} value={u.id}>
                        {u.name}
                      </option>
                    ))}
                  </select>
                </div>
              )}
              <div className="field">
                <label htmlFor="slot">Slot</label>
                <select id="slot" value={slotId ?? ''} onChange={(e) => setSlotId(Number(e.target.value))}>
                  {setup.slots.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name} — {s.startTime}, {durationLabel(s.duration)}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label htmlFor="date">Date</label>
                <input type="date" id="date" required min={setup.today} value={date} onChange={(e) => setDate(e.target.value)} />
              </div>
            </div>

            <div className="field-row">
              <div className="field grow">
                <label htmlFor="guest-name">Guest name</label>
                <input type="text" id="guest-name" required value={guestName} onChange={(e) => setGuestName(e.target.value)} />
              </div>
              <div className="field">
                <label htmlFor="guest-phone">
                  Phone <span className="muted">(optional)</span>
                </label>
                <input type="text" id="guest-phone" value={guestPhone} onChange={(e) => setGuestPhone(e.target.value)} />
              </div>
              <div className="field narrow">
                <label htmlFor="guest-count">
                  Guests <span className="muted">(optional)</span>
                </label>
                <input
                  type="number"
                  id="guest-count"
                  min={1}
                  step={1}
                  value={guestCount}
                  onChange={(e) => setGuestCount(e.target.value)}
                />
              </div>
            </div>

            <div className="field">
              <label htmlFor="notes">
                Notes <span className="muted">(optional)</span>
              </label>
              <input type="text" id="notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
            </div>

            <div className="form-footer">
              <span className="small muted">
                Times are in {setup.timezone}. Today there is {dayLabel(setup.today)}.
              </span>
              <button type="submit" className="primary" disabled={busy || unitId === null || slotId === null}>
                {busy ? 'Saving…' : 'Book'}
              </button>
            </div>
          </form>
        </section>

        <section className="card">
          <div className="range-head">
            <h2>
              {dayLabel(from)} – {dayLabel(to)}
            </h2>
            <div className="range-nav">
              <button type="button" disabled={from <= setup.today} onClick={() => setFrom(addDays(from, -RANGE_DAYS))}>
                ← Earlier
              </button>
              <button type="button" disabled={from === setup.today} onClick={() => setFrom(setup.today)}>
                Today
              </button>
              <button type="button" onClick={() => setFrom(addDays(from, RANGE_DAYS))}>
                Later →
              </button>
            </div>
          </div>

          {availability === null || bookings === null ? (
            <div className="small">{loadMessage}</div>
          ) : (
            days.map(({ day, slots, bookings: dayBookings }) => (
              <div key={day} className="day">
                <div className="day-head">
                  <span className="day-label">{dayLabel(day)}</span>
                  <span className="day-slots">
                    {slots.map((s) => (
                      <span
                        key={`${s.unit}/${s.slot}`}
                        className={`slot-chip ${s.status}`}
                        title={s.status === 'taken' ? 'Overlaps a booking — maybe one from another day' : 'Free to book'}
                      >
                        {multipleUnits ? `${s.unit} · ` : ''}
                        {s.slot}: {s.status}
                      </span>
                    ))}
                  </span>
                </div>
                {dayBookings.map((b) => (
                  <BookingRow key={b.id} booking={b} busy={busy} onCancel={cancel} />
                ))}
              </div>
            ))
          )}
        </section>
      </main>
    </>
  );
}
