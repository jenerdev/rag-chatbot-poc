'use client';

// S-5 · Rooms. For a per_room tenant: add a room, change it, retire it, price
// it per slot, and give it photos (plan/booking-types.md Phase 4).
//
// Rendered by app/t/[tenant]/admin/accommodations/page.tsx, which has already
// checked on the server that the tenant exists, has bookings, and books by
// room. Every route this screen calls is admin-only.
//
// What this screen does NOT decide:
//   - a price. Staff type pesos; they are turned into CENTAVOS by splitting
//     the string (lib/money.ts), sent, and validated again by @rag/bookings.
//     What a booking costs is decided later by the database (plan Rule 2);
//   - whether a photo is acceptable. It resizes and re-encodes in the
//     browser (which drops EXIF/GPS), and the server checks size and type by
//     the bytes anyway.
//
// Everything a room carries (name, description) is tenant text, rendered as
// React children, so it is escaped (CLAUDE.md § Conventions). Photo URLs come
// from the server's getPublicUrl(), built from a path the server made.
//
// The look (plan/ui-refresh.md Phase 9): "Add a room" opens a drawer; each
// room stays a card (its details, rates and photos are edited in place);
// Retire and Remove photo ask in the dialog; a photo can be dropped on the
// dashed tile as well as chosen.

import { useCallback, useEffect, useState } from 'react';
import type { Accommodation, BookingSummary, ImageSummary, SlotSummary } from '@rag/bookings';
import { LoginForm, describeFailure } from '@/components/admin-login';
import { fetchRole } from '@/components/tenant-nav';
import { Drawer, useConfirmDialog, type Question } from '@/components/dialogs';
import { useNotice, type Notice } from '@/components/toast';
import { Icon } from '@/components/icons';
import { StaffFrame } from '@/components/staff-frame';
import type { NavFeatures } from '@/lib/nav-items';
import { isRole, type Role } from '@/lib/permissions';
import { centavosToInput, formatMoney, parseMoneyInput } from '@/lib/money';
import { resizeImage } from '@/lib/resize-image';

export interface AccommodationsScreenProps {
  slug: string;
  businessName: string;
  logoUrl: string | null;
  bannerUrl: string | null;
  /** What the tenant has, for the header's links (lib/nav.ts). */
  nav: NavFeatures;
  /** From @rag/bookings, via the server page: the one copy of each limit. */
  maxImageBytes: number;
  maxImageEdge: number;
  maxImagesPerUnit: number;
}

interface Setup {
  today: string;
  currency: string;
  slots: SlotSummary[];
}

type Auth = 'checking' | 'out' | 'in';

/** How far ahead "future bookings" are counted when a room is retired: the admin list's own limit. */
const LOOKAHEAD_DAYS = 92;

function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** fetch + the screen's two shared outcomes: 401 logs out, anything not ok throws with the server's message. */
type Call = (path: string, init?: RequestInit) => Promise<Response>;

interface RoomCardProps {
  room: Accommodation;
  setup: Setup;
  call: Call;
  busy: boolean;
  setBusy: (busy: boolean) => void;
  onNotice: (notice: Notice) => void;
  onChanged: () => void;
  limits: Pick<AccommodationsScreenProps, 'maxImageBytes' | 'maxImageEdge' | 'maxImagesPerUnit'>;
  /** The screen's confirmation dialog (components/dialogs.tsx). */
  ask: (question: Question) => Promise<string | null>;
}

function RoomCard({ room, setup, call, busy, setBusy, onNotice, onChanged, limits, ask }: RoomCardProps) {
  // A photo dragged over the drop tile.
  const [dragging, setDragging] = useState(false);
  const [name, setName] = useState(room.name);
  const [capacity, setCapacity] = useState(room.capacity === null ? '' : String(room.capacity));
  // plan/extra-guests.md: guests the rate covers, and the fee per guest above
  // them, typed in pesos and sent as centavos like every price.
  const [standard, setStandard] = useState(room.standardCapacity === null ? '' : String(room.standardCapacity));
  const [extraRate, setExtraRate] = useState(room.extraPersonRate === null ? '' : centavosToInput(room.extraPersonRate));
  const [description, setDescription] = useState(room.description ?? '');
  // One weekday and one weekend input per slot, as TEXT in pesos.
  const [rates, setRates] = useState<Record<number, { weekday: string; weekend: string }>>(() =>
    Object.fromEntries(
      setup.slots.map((s) => {
        const rate = room.rates.find((r) => r.slotId === s.id);
        return [s.id, { weekday: rate ? centavosToInput(rate.weekdayPrice) : '', weekend: rate ? centavosToInput(rate.weekendPrice) : '' }];
      }),
    ),
  );

  // Runs one action with the screen's busy flag and notice, so every button
  // below reports the same way.
  const run = useCallback(
    async (action: () => Promise<string | null>) => {
      onNotice(null);
      setBusy(true);
      try {
        const message = await action();
        if (message) onNotice({ message, kind: 'ok' });
        onChanged();
      } catch (error) {
        onNotice({ message: (error as Error).message, kind: 'error' });
      } finally {
        setBusy(false);
      }
    },
    [onChanged, onNotice, setBusy],
  );

  const saveDetails = (event: React.FormEvent) => {
    event.preventDefault();
    void run(async () => {
      const extraPersonRate = extraRate.trim() === '' ? null : parseMoneyInput(extraRate);
      if (extraRate.trim() !== '' && extraPersonRate === null) {
        throw new Error('Enter the extra guest fee as pesos, for example 250 or 250.50.');
      }
      await call(`/accommodations/${room.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          name,
          maxCapacity: capacity === '' ? null : Number(capacity),
          standardCapacity: standard === '' ? null : Number(standard),
          extraPersonRate,
          description: description === '' ? null : description,
        }),
      });
      return `Saved ${name}.`;
    });
  };

  const saveRates = (event: React.FormEvent) => {
    event.preventDefault();
    void run(async () => {
      const payload = [];
      for (const slot of setup.slots) {
        const { weekday, weekend } = rates[slot.id] ?? { weekday: '', weekend: '' };
        if (weekday.trim() === '' && weekend.trim() === '') continue;
        const weekdayPrice = parseMoneyInput(weekday);
        const weekendPrice = parseMoneyInput(weekend);
        if (weekdayPrice === null || weekendPrice === null) {
          throw new Error(`${slot.name}: enter both prices as pesos, for example 3500 or 3500.50.`);
        }
        payload.push({ slotId: slot.id, weekdayPrice, weekendPrice });
      }
      if (payload.length === 0) throw new Error('Enter a weekday and a weekend price for at least one slot.');
      await call(`/accommodations/${room.id}/rates`, { method: 'PUT', body: JSON.stringify({ rates: payload }) });
      return `Saved the rates for ${room.name}. Existing bookings keep the price they were booked at.`;
    });
  };

  const setActive = (active: boolean) => {
    void run(async () => {
      if (!active) {
        // Retiring a room does not cancel its bookings (R-25). Say how many
        // stay, so staff can decide to move or cancel them first.
        const response = await call(`/bookings?from=${setup.today}&to=${addDays(setup.today, LOOKAHEAD_DAYS - 1)}&unit=${room.id}`);
        const upcoming = ((await response.json()) as BookingSummary[]).filter((b) => b.status !== 'cancelled');
        const sure = await ask({
          title: `Retire ${room.name}?`,
          body: upcoming.length
            ? `It has ${upcoming.length} booking(s) in the next ${LOOKAHEAD_DAYS} days. They stay valid and keep this room; it just will not be offered again.`
            : 'It will not be offered for new bookings.',
          actionLabel: 'Retire',
          backLabel: 'Keep offering it',
        });
        if (sure === null) return null;
      }
      await call(`/accommodations/${room.id}`, { method: 'PATCH', body: JSON.stringify({ active }) });
      return active ? `${room.name} is offered again.` : `${room.name} is retired.`;
    });
  };

  const upload = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (file) uploadFile(file);
  };

  // A chosen OR dropped photo: the same resize and the same route.
  const uploadFile = (file: File) => {
    if (!/^image\/(jpeg|png|webp)$/.test(file.type)) {
      onNotice({ message: 'A photo is a JPEG, PNG or WebP image.', kind: 'error' });
      return;
    }
    void run(async () => {
      const resized = await resizeImage(file, limits.maxImageEdge);
      if (resized.after > limits.maxImageBytes) {
        throw new Error(`Even resized, the photo is ${(resized.after / 1048576).toFixed(1)} MB; the limit is ${limits.maxImageBytes / 1048576} MB.`);
      }
      const form = new FormData();
      form.append('file', resized.blob, resized.blob.type === 'image/webp' ? 'photo.webp' : 'photo.jpg');
      await call(`/accommodations/${room.id}/images`, { method: 'POST', body: form });
      // The sizes are shown because Phase 4 measures them (plan § 2.8).
      return `Added a photo: ${(resized.before / 1024).toFixed(0)} KB → ${(resized.after / 1024).toFixed(0)} KB, ${resized.width}×${resized.height}.`;
    });
  };

  const removePhoto = async (image: ImageSummary) => {
    const sure = await ask({ title: 'Remove this photo?', body: `It leaves ${room.name}'s photos for good.`, actionLabel: 'Remove', backLabel: 'Keep it', danger: true });
    if (sure === null) return;
    void run(async () => {
      await call(`/accommodations/${room.id}/images/${image.id}`, { method: 'DELETE' });
      return 'Photo removed.';
    });
  };

  // One place left or right. The SERVER swaps positions and renumbers the
  // room (moveImage), so this screen never has to know the stored numbers.
  // It used to set them to positions itself, which broke when every upload
  // had sort order 0 (code review, 2026-09-28).
  const movePhoto = (index: number, by: -1 | 1) => {
    const image = room.images[index];
    if (!image || !room.images[index + by]) return;
    void run(async () => {
      await call(`/accommodations/${room.id}/images/${image.id}`, { method: 'PATCH', body: JSON.stringify({ move: by }) });
      return null;
    });
  };

  return (
    <section className={`card room${room.active ? '' : ' retired'}`}>
      <div className="room-head">
        <h2>
          {room.name}
          {!room.active && <span className="badge">Retired</span>}
          {room.active && room.rates.length === 0 && (
            <span className="badge warn">
              <Icon name="alert" size={12} /> No rate yet
            </span>
          )}
        </h2>
        <button type="button" className="sm" disabled={busy} onClick={() => setActive(!room.active)}>
          {room.active ? 'Retire' : 'Offer again'}
        </button>
      </div>

      <form onSubmit={saveDetails}>
        <div className="field-row">
          <div className="field grow">
            <label htmlFor={`name-${room.id}`}>Name</label>
            <input type="text" id={`name-${room.id}`} required value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="field narrow">
            <label htmlFor={`standard-${room.id}`}>Included</label>
            <input type="number" id={`standard-${room.id}`} min={1} step={1} value={standard} onChange={(e) => setStandard(e.target.value)} />
          </div>
          <div className="field narrow">
            <label htmlFor={`capacity-${room.id}`}>Max guests</label>
            <input type="number" id={`capacity-${room.id}`} min={1} step={1} value={capacity} onChange={(e) => setCapacity(e.target.value)} />
          </div>
          <div className="field narrow">
            <label htmlFor={`extra-${room.id}`}>Per extra guest</label>
            <input
              type="text"
              inputMode="decimal"
              id={`extra-${room.id}`}
              placeholder="no fee"
              value={extraRate}
              onChange={(e) => setExtraRate(e.target.value)}
            />
          </div>
        </div>
        <div className="small muted">
          {room.standardCapacity !== null && room.extraPersonRate !== null
            ? `The rate covers ${room.standardCapacity} guest(s); each guest above that adds ${formatMoney(room.extraPersonRate, setup.currency)}, up to ${room.capacity ?? 'any number of'} guests.`
            : 'No extra-guest fee: the rate is the same for any party up to the maximum.'}
        </div>
        <div className="field">
          <label htmlFor={`description-${room.id}`}>
            Description <span className="muted">(staff only; guests read the documents)</span>
          </label>
          <textarea id={`description-${room.id}`} rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
        </div>
        <div className="form-footer">
          <button type="submit" disabled={busy}>
            Save details
          </button>
        </div>
      </form>

      <form onSubmit={saveRates} className="rates">
        <div className="rates-grid">
          <span className="small muted">Slot</span>
          <span className="small muted">Weekday ({setup.currency})</span>
          <span className="small muted">Weekend ({setup.currency})</span>
          {setup.slots.map((slot) => (
            <div key={slot.id} className="rates-row">
              <span>{slot.name}</span>
              {(['weekday', 'weekend'] as const).map((kind) => (
                <input
                  key={kind}
                  type="text"
                  inputMode="decimal"
                  aria-label={`${slot.name} ${kind} price`}
                  placeholder="not offered"
                  value={rates[slot.id]?.[kind] ?? ''}
                  onChange={(e) => setRates((current) => ({ ...current, [slot.id]: { ...current[slot.id]!, [kind]: e.target.value } }))}
                />
              ))}
            </div>
          ))}
        </div>
        <div className="form-footer">
          <span className="small muted">
            {room.rates.length === 0
              ? 'No rate yet: this room cannot be booked.'
              : room.rates.map((r) => `${r.slot} ${formatMoney(r.weekdayPrice, setup.currency)} / ${formatMoney(r.weekendPrice, setup.currency)}`).join(' · ')}
          </span>
          <button type="submit" disabled={busy}>
            Save rates
          </button>
        </div>
      </form>

      <div className="photos">
        {room.images.map((image, index) => (
          <figure key={image.id} className="photo">
            {/* eslint-disable-next-line @next/next/no-img-element -- a plain public URL; next/image would need remotePatterns for the bucket */}
            <img src={image.url} alt={`${room.name}, photo ${index + 1}`} />
            <figcaption>
              <button type="button" className="ghost sm" disabled={busy || index === 0} onClick={() => movePhoto(index, -1)} aria-label="Move left" title="Move left">
                <Icon name="chevron-left" size={16} />
              </button>
              <button type="button" className="ghost sm danger" disabled={busy} onClick={() => void removePhoto(image)} aria-label={`Remove photo ${index + 1}`} title="Remove">
                <Icon name="trash" size={16} />
              </button>
              <button
                type="button"
                className="ghost sm"
                disabled={busy || index === room.images.length - 1}
                onClick={() => movePhoto(index, 1)}
                aria-label="Move right"
                title="Move right"
              >
                <Icon name="chevron-right" size={16} />
              </button>
            </figcaption>
          </figure>
        ))}
        {room.images.length < limits.maxImagesPerUnit && (
          <label
            className={dragging ? 'photo-add dragging' : 'photo-add'}
            onDragOver={(event) => {
              event.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(event) => {
              event.preventDefault();
              setDragging(false);
              const file = event.dataTransfer.files[0];
              if (file && !busy) uploadFile(file);
            }}
          >
            {/* Visually hidden, not display:none: the tile is its label, and the keyboard reaches it. */}
            <input type="file" className="visually-hidden" accept="image/jpeg,image/png,image/webp" disabled={busy} onChange={upload} />
            <Icon name="image" size={22} />
            <span className="photo-add-text">Add a photo</span>
            <span className="small muted">
              or drop one here · {room.images.length} of {limits.maxImagesPerUnit}
            </span>
          </label>
        )}
      </div>
    </section>
  );
}

export function AccommodationsScreen({
  slug,
  businessName,
  logoUrl,
  bannerUrl,
  nav,
  maxImageBytes,
  maxImageEdge,
  maxImagesPerUnit,
}: AccommodationsScreenProps) {
  const api = `/api/t/${slug}`;
  const [auth, setAuth] = useState<Auth>('checking');
  // What this member is, for the header's links only; the routes decide for themselves.
  const [role, setRole] = useState<Role | null>(null);
  const [setup, setSetup] = useState<Setup | null>(null);
  const [rooms, setRooms] = useState<Accommodation[] | null>(null);
  const [loadMessage, setLoadMessage] = useState('Loading…');
  const [busy, setBusy] = useState(false);

  // The new-room form, in a drawer.
  const [name, setName] = useState('');
  const [capacity, setCapacity] = useState('');
  const [formOpen, setFormOpen] = useState(false);
  const { notice, setNotice } = useNotice(formOpen);
  const { ask, dialog } = useConfirmDialog();

  const unauthorized = useCallback(() => {
    setAuth('out');
    setSetup(null);
    setRooms(null);
  }, []);

  const call: Call = useCallback(
    async (path, init = {}) => {
      const headers = init.body instanceof FormData ? undefined : { 'Content-Type': 'application/json' };
      const response = await fetch(`${api}${path}`, { ...init, headers });
      if (response.status === 401) {
        unauthorized();
        throw new Error('Your session ended. Log in again.');
      }
      if (!response.ok) throw new Error(await describeFailure(new Error('failed'), response));
      return response;
    },
    [api, unauthorized],
  );

  useEffect(() => {
    void (async () => {
      try {
        const response = await fetch(`${api}/admin/session`);
        const body = await response.json();
        setAuth(body.admin === true ? 'in' : 'out');
        setRole(isRole(body.role) ? body.role : null);
      } catch {
        setAuth('out');
      }
    })();
  }, [api]);

  const load = useCallback(async () => {
    try {
      const [s, r] = await Promise.all([call('/bookings/setup'), call('/accommodations')]);
      setSetup(await s.json());
      setRooms(await r.json());
    } catch (error) {
      setLoadMessage((error as Error).message);
    }
  }, [call]);

  useEffect(() => {
    if (auth === 'in') void load();
  }, [auth, load]);

  const logout = useCallback(async () => {
    await fetch(`${api}/admin/session`, { method: 'DELETE' }).catch(() => undefined);
    unauthorized();
  }, [api, unauthorized]);

  const addRoom = async (event: React.FormEvent) => {
    event.preventDefault();
    setNotice(null);
    setBusy(true);
    try {
      await call('/accommodations', {
        method: 'POST',
        // Left empty, the maximum is @rag/bookings' default (4), and so are
        // the standard (2) and the extra-guest fee (₱250).
        body: JSON.stringify({ name, ...(capacity === '' ? {} : { maxCapacity: Number(capacity) }), sortOrder: rooms?.length ?? 0 }),
      });
      setNotice({ message: `Added ${name}. Give it a rate so it can be booked.`, kind: 'ok' });
      setName('');
      setCapacity('');
      setFormOpen(false);
      void load();
    } catch (error) {
      setNotice({ message: (error as Error).message, kind: 'error' });
    } finally {
      setBusy(false);
    }
  };

  const frame = { slug, businessName, logoUrl, bannerUrl, features: nav, current: 'rooms' as const, title: 'Rooms', session: { auth, role, onLogout: logout } };

  if (auth !== 'in') {
    return (
      <>
        <StaffFrame {...frame}>
          {auth === 'checking' ? (
            <div className="small muted">Checking your session…</div>
          ) : (
            <LoginForm api={api} slug={slug} onLoggedIn={() => {
                setAuth('in');
                void fetchRole(api).then(setRole);
              }} />
          )}
        </StaffFrame>
      </>
    );
  }

  if (!setup || !rooms) {
    return (
      <>
        <StaffFrame {...frame}>
          <div className="small">{loadMessage}</div>
        </StaffFrame>
      </>
    );
  }

  return (
    <>
      <StaffFrame
        {...frame}
        actions={
          <button
            type="button"
            className="primary"
            onClick={() => {
              setNotice(null);
              setFormOpen(true);
            }}
          >
            <Icon name="plus" size={16} /> Add a room
          </button>
        }
      >
        {dialog}

        <Drawer open={formOpen} title="Add a room" onClose={() => setFormOpen(false)}>
          <form onSubmit={addRoom}>
            <div className="field-row">
              <div className="field grow">
                <label htmlFor="new-name">Name</label>
                <input type="text" id="new-name" required value={name} onChange={(e) => setName(e.target.value)} />
              </div>
              <div className="field narrow">
                <label htmlFor="new-capacity">Max guests</label>
                <input type="number" id="new-capacity" min={1} step={1} value={capacity} onChange={(e) => setCapacity(e.target.value)} />
              </div>
            </div>
            <div className="form-footer">
              <span className="small muted">
                A new room covers 2 guests, takes up to 4, and charges ₱250 per extra guest until you change it. It is offered once it has a rate.
              </span>
              <span className="form-actions">
                <button type="button" disabled={busy} onClick={() => setFormOpen(false)}>
                  Cancel
                </button>
                <button type="submit" className="primary" aria-busy={busy || undefined} disabled={busy}>
                  Add room
                </button>
              </span>
            </div>
            {notice?.kind === 'error' && formOpen && (
              <div className="notice error drawer-notice" role="alert">
                {notice.message}
              </div>
            )}
          </form>
        </Drawer>

        {rooms.length === 0 && <div className="small muted">No rooms yet. "Add a room" makes one.</div>}
        {rooms.map((room) => (
          // The key includes what the card's inputs were initialised from, so
          // after a save the card is rebuilt from the server's values rather
          // than keeping stale local text.
          <RoomCard
            key={`${room.id}:${room.name}:${room.capacity}:${room.standardCapacity}:${room.extraPersonRate}:${room.description}:${JSON.stringify(room.rates)}`}
            room={room}
            setup={setup}
            call={call}
            busy={busy}
            setBusy={setBusy}
            onNotice={setNotice}
            onChanged={() => void load()}
            limits={{ maxImageBytes, maxImageEdge, maxImagesPerUnit }}
            ask={ask}
          />
        ))}
      </StaffFrame>
    </>
  );
}
