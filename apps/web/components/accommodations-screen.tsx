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
// room is an accordion row whose closed head is the room at a glance (photo,
// guests, lowest rate, photo count, what it lacks), and whose open panel edits
// its details, rates and photos in place, with Retire at the foot. Retired
// rooms are listed after the offered ones. Retire and Remove photo ask in the
// dialog; a photo can be dropped on the dashed tile as well as chosen.

import { useCallback, useEffect, useState } from 'react';
import type { Accommodation, BookingSummary, ImageSummary, SlotSummary } from '@rag/bookings';
import { LoginForm, describeFailure } from '@/components/admin-login';
import { fetchRole } from '@/components/tenant-nav';
import { Drawer, useConfirmDialog, type Question } from '@/components/dialogs';
import { useNotice, type Notice } from '@/components/toast';
import { Icon } from '@/components/icons';
import { Tip } from '@/components/tooltip';
import { EmptyState, LOADING, LoadState, failed, type Load } from '@/components/load-state';
import { StaffFrame } from '@/components/staff-frame';
import type { NavFeatures } from '@/lib/nav-items';
import { isRole, type Role } from '@/lib/permissions';
import { centavosToInput, formatMoney, parseMoneyInput } from '@/lib/money';
import { resizeImage } from '@/lib/resize-image';

export interface AccommodationsScreenProps {
  slug: string;
  businessName: string;
  logoUrl: string | null;
  /** What the tenant has, for the header's links (lib/nav.ts). */
  nav: NavFeatures;
  /** From @rag/bookings, via the server page: the one copy of each limit. */
  maxImageBytes: number;
  maxImageEdge: number;
  maxImagesPerUnit: number;
  /** A new room's defaults (@rag/bookings), from the server page, never a copy: shown as placeholders and in the read-back. */
  roomDefaults: { standard: number; max: number; extraFee: number };
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
  /** Open or closed: kept by the screen, because a save rebuilds the card (its key). */
  open: boolean;
  onToggle: () => void;
}

/** A room's inputs as the server last stored them: what "unsaved" is measured against. */
function initialDetails(room: Accommodation) {
  return {
    name: room.name,
    capacity: room.capacity === null ? '' : String(room.capacity),
    standard: room.standardCapacity === null ? '' : String(room.standardCapacity),
    extraRate: room.extraPersonRate === null ? '' : centavosToInput(room.extraPersonRate),
    description: room.description ?? '',
  };
}

function initialRates(room: Accommodation, slots: SlotSummary[]): Record<number, { weekday: string; weekend: string }> {
  return Object.fromEntries(
    slots.map((s) => {
      const rate = room.rates.find((r) => r.slotId === s.id);
      return [s.id, { weekday: rate ? centavosToInput(rate.weekdayPrice) : '', weekend: rate ? centavosToInput(rate.weekendPrice) : '' }];
    }),
  );
}

/** "2 included, up to 4 guests", the closed row's guest line. */
function guestsLine(room: Accommodation): string {
  if (room.capacity === null) return 'Any party size';
  if (room.standardCapacity !== null && room.extraPersonRate !== null && room.standardCapacity < room.capacity) {
    return `${room.standardCapacity} included, up to ${room.capacity} guests`;
  }
  return `Up to ${room.capacity} ${room.capacity === 1 ? 'guest' : 'guests'}`;
}

function RoomCard({ room, setup, call, busy, setBusy, onNotice, onChanged, limits, ask, open, onToggle }: RoomCardProps) {
  // A photo dragged over the drop tile.
  const [dragging, setDragging] = useState(false);
  const initial = initialDetails(room);
  const [name, setName] = useState(initial.name);
  const [capacity, setCapacity] = useState(initial.capacity);
  // plan/extra-guests.md: guests the rate covers, and the fee per guest above
  // them, typed in pesos and sent as centavos like every price.
  const [standard, setStandard] = useState(initial.standard);
  const [extraRate, setExtraRate] = useState(initial.extraRate);
  const [description, setDescription] = useState(initial.description);
  // One weekday and one weekend input per slot, as TEXT in pesos.
  const [rates, setRates] = useState(() => initialRates(room, setup.slots));

  // Unsaved edits, compared with what the server stored. A closed row says so,
  // because its inputs are out of sight; and a Save with nothing changed is off.
  const detailsDirty =
    name !== initial.name ||
    capacity !== initial.capacity ||
    standard !== initial.standard ||
    extraRate !== initial.extraRate ||
    description !== initial.description;
  const storedRates = initialRates(room, setup.slots);
  const ratesDirty = setup.slots.some(
    (s) => rates[s.id]?.weekday !== storedRates[s.id]?.weekday || rates[s.id]?.weekend !== storedRates[s.id]?.weekend,
  );
  // The lowest stored price, for the closed row: what the cheapest stay starts at.
  const lowest = room.rates.length ? Math.min(...room.rates.flatMap((r) => [r.weekdayPrice, r.weekendPrice])) : null;
  const panelId = `room-${room.id}-panel`;
  const headId = `room-${room.id}-head`;

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
    <div className={`room-item${room.active ? '' : ' retired'}${open ? ' open' : ''}`}>
      {/* The WAI-ARIA accordion: a heading holding the button that opens its panel. */}
      <h2 className="room-item-heading">
        <button type="button" id={headId} className="room-toggle" aria-expanded={open} aria-controls={panelId} onClick={onToggle}>
          <Icon name="chevron-right" size={16} className="room-chevron" />
          <span className="room-thumb" aria-hidden="true">
            {room.images[0] ? (
              // eslint-disable-next-line @next/next/no-img-element -- a plain public URL, as below
              <img src={room.images[0].url} alt="" />
            ) : (
              <Icon name="bed" size={18} />
            )}
          </span>
          <span className="room-title">
            <span className="room-name">{room.name}</span>
            <span className="room-meta">
              {guestsLine(room)}
              {lowest !== null && <> · from {formatMoney(lowest, setup.currency)}</>}
              {` · ${room.images.length} ${room.images.length === 1 ? 'photo' : 'photos'}`}
            </span>
          </span>
          <span className="room-badges">
            {(detailsDirty || ratesDirty) && <span className="badge accent">Unsaved changes</span>}
            {!room.active && <span className="badge">Retired</span>}
            {room.active && room.rates.length === 0 && (
              <span className="badge warn">
                <Icon name="alert" size={12} /> No rate yet
              </span>
            )}
          </span>
        </button>
      </h2>

      {/* Hidden, not unmounted: an edit survives closing the row. */}
      <div id={panelId} className="room-panel" role="region" aria-labelledby={headId} hidden={!open}>
        <form onSubmit={saveDetails} className="room-section">
          <div className="room-section-head">
            <h3>Details</h3>
            <p className="small muted">
              {room.standardCapacity !== null && room.extraPersonRate !== null
                ? `The rate covers ${room.standardCapacity} guest(s); each guest above that adds ${formatMoney(room.extraPersonRate, setup.currency)}, up to ${room.capacity ?? 'any number of'} guests.`
                : 'No extra-guest fee: the rate is the same for any party up to the maximum.'}
            </p>
          </div>
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
          <div className="field">
            <label htmlFor={`description-${room.id}`}>
              Description <span className="muted">(staff only; guests read the documents)</span>
            </label>
            <textarea id={`description-${room.id}`} rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
          </div>
          <div className="form-footer room-section-foot">
            <button type="submit" className={detailsDirty ? 'primary' : undefined} disabled={busy || !detailsDirty}>
              Save details
            </button>
          </div>
        </form>

        <form onSubmit={saveRates} className="room-section">
          <div className="room-section-head">
            <h3>Rates</h3>
            <p className="small muted">
              {room.rates.length === 0
                ? 'No rate yet: this room cannot be booked. Leave a slot empty to not offer it.'
                : `Per night, in ${setup.currency}. Leave a slot empty to not offer it. Existing bookings keep their price.`}
            </p>
          </div>
          <div className="rates-grid">
            <span className="small muted rates-col">Slot</span>
            <span className="small muted rates-col">Weekday</span>
            <span className="small muted rates-col">Weekend</span>
            {setup.slots.map((slot) => (
              <div key={slot.id} className="rates-row">
                <span className="rates-slot">{slot.name}</span>
                {(['weekday', 'weekend'] as const).map((kind) => (
                  <label key={kind} className="rates-cell">
                    {/* The column head, again, for a phone, where the row stacks. */}
                    <span className="rates-cell-label small muted" aria-hidden="true">
                      {kind === 'weekday' ? 'Weekday' : 'Weekend'}
                    </span>
                    <input
                      type="text"
                      inputMode="decimal"
                      aria-label={`${slot.name} ${kind} price`}
                      placeholder="not offered"
                      value={rates[slot.id]?.[kind] ?? ''}
                      onChange={(e) => setRates((current) => ({ ...current, [slot.id]: { ...current[slot.id]!, [kind]: e.target.value } }))}
                    />
                  </label>
                ))}
              </div>
            ))}
          </div>
          <div className="form-footer room-section-foot">
            <button type="submit" className={ratesDirty ? 'primary' : undefined} disabled={busy || !ratesDirty}>
              Save rates
            </button>
          </div>
        </form>

        <div className="room-section">
          <div className="room-section-head">
            <h3>Photos</h3>
            <p className="small muted">
              {room.images.length} of {limits.maxImagesPerUnit}. The first is the one guests see first; use the arrows to reorder.
            </p>
          </div>
          <div className="photos">
            {room.images.map((image, index) => (
              <figure key={image.id} className="photo">
                {/* eslint-disable-next-line @next/next/no-img-element -- a plain public URL; next/image would need remotePatterns for the bucket */}
                <img src={image.url} alt={`${room.name}, photo ${index + 1}`} />
                <figcaption>
                  <Tip label="Move left">
                    <button type="button" className="ghost sm" disabled={busy || index === 0} onClick={() => movePhoto(index, -1)} aria-label="Move left">
                      <Icon name="chevron-left" size={16} />
                    </button>
                  </Tip>
                  <Tip label="Remove">
                    <button type="button" className="ghost sm danger" disabled={busy} onClick={() => void removePhoto(image)} aria-label={`Remove photo ${index + 1}`}>
                      <Icon name="trash" size={16} />
                    </button>
                  </Tip>
                  <Tip label="Move right">
                    <button
                      type="button"
                      className="ghost sm"
                      disabled={busy || index === room.images.length - 1}
                      onClick={() => movePhoto(index, 1)}
                      aria-label="Move right"
                    >
                      <Icon name="chevron-right" size={16} />
                    </button>
                  </Tip>
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
                <span className="small muted">or drop one here</span>
              </label>
            )}
          </div>
        </div>

        <div className="room-retire">
          <p className="small muted">
            {room.active
              ? 'Retiring stops new bookings for this room. Its existing bookings stay valid.'
              : 'Retired: not offered for new bookings. Offer it again to take bookings.'}
          </p>
          <button type="button" className={room.active ? 'danger' : undefined} disabled={busy} onClick={() => setActive(!room.active)}>
            {room.active ? 'Retire room' : 'Offer again'}
          </button>
        </div>
      </div>
    </div>
  );
}

export function AccommodationsScreen({
  slug,
  businessName,
  logoUrl,
  nav,
  maxImageBytes,
  maxImageEdge,
  maxImagesPerUnit,
  roomDefaults,
}: AccommodationsScreenProps) {
  const api = `/api/t/${slug}`;
  const [auth, setAuth] = useState<Auth>('checking');
  // What this member is, for the header's links only; the routes decide for themselves.
  const [role, setRole] = useState<Role | null>(null);
  const [setup, setSetup] = useState<Setup | null>(null);
  const [rooms, setRooms] = useState<Accommodation[] | null>(null);
  const [loadState, setLoadState] = useState<Load>(LOADING);
  const [busy, setBusy] = useState(false);
  // Which rooms are open. Several may be: comparing two rooms' rates is a real task.
  const [openIds, setOpenIds] = useState<Set<number>>(() => new Set());
  const toggle = (id: number) =>
    setOpenIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  // The new-room form, in a drawer.
  const [name, setName] = useState('');
  const [capacity, setCapacity] = useState('');
  // The rest of a new room, each optional: left empty, @rag/bookings' default
  // (roomDefaults, from the server page). The fee is typed in pesos.
  const [description, setDescription] = useState('');
  const [standard, setStandard] = useState('');
  const [extraFee, setExtraFee] = useState('');
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
      setLoadState(failed((error as Error).message));
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
      const response = await call('/accommodations', {
        method: 'POST',
        // Left empty, the maximum is @rag/bookings' default (4), and so are
        // the standard (2) and the extra-guest fee (₱250).
        body: JSON.stringify({
          name,
          ...(description.trim() === '' ? {} : { description: description.trim() }),
          ...(capacity === '' ? {} : { maxCapacity: Number(capacity) }),
          ...(standard === '' ? {} : { standardCapacity: Number(standard) }),
          ...(extraFee.trim() === '' || parseMoneyInput(extraFee) === null ? {} : { extraPersonRate: parseMoneyInput(extraFee) }),
          sortOrder: rooms?.length ?? 0,
        }),
      });
      // Opened, so its rates are the next thing in view.
      const added = (await response.json()) as Accommodation;
      setOpenIds((current) => new Set(current).add(added.id));
      setNotice({ message: `Added ${name}. Give it a rate so it can be booked.`, kind: 'ok' });
      setName('');
      setCapacity('');
      setDescription('');
      setStandard('');
      setExtraFee('');
      setFormOpen(false);
      void load();
    } catch (error) {
      setNotice({ message: (error as Error).message, kind: 'error' });
    } finally {
      setBusy(false);
    }
  };

  const frame = { slug, businessName, logoUrl, features: nav, current: 'rooms' as const, title: 'Rooms', session: { auth, role, onLogout: logout } };

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
          <LoadState load={loadState} what="rooms" onRetry={() => { setLoadState(LOADING); void load(); }} />
        </StaffFrame>
      </>
    );
  }

  const offered = rooms.filter((r) => r.active);
  const retired = rooms.filter((r) => !r.active);
  const unpriced = offered.filter((r) => r.rates.length === 0).length;
  const allOpen = rooms.length > 0 && rooms.every((r) => openIds.has(r.id));
  const card = (room: Accommodation) => (
    // The key includes what the card's inputs were initialised from, so
    // after a save the card is rebuilt from the server's values rather
    // than keeping stale local text. Open or closed survives that: it is here.
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
      open={openIds.has(room.id)}
      onToggle={() => toggle(room.id)}
    />
  );

  const addRoomAction = (
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
  );

  return (
    <>
      <StaffFrame
        {...frame}
        actions={addRoomAction}
      >
        {dialog}

        <Drawer open={formOpen} title="Add a room" onClose={() => setFormOpen(false)}>
          <form onSubmit={addRoom} className="setup-form">
            <p className="small muted setup-intro">A room guests can book on its own. Next you give it a rate for each slot and add photos.</p>
            <div className="field">
              <label htmlFor="new-name">Name</label>
              <input type="text" id="new-name" required autoComplete="off" placeholder="Garden Room" value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="field">
              <label htmlFor="new-description">
                Description <span className="muted">(optional)</span>
              </label>
              <textarea id="new-description" rows={2} placeholder="A queen bed and a view of the garden." value={description} onChange={(e) => setDescription(e.target.value)} />
              <p className="hint">Shown with the room's photos on the booking page and in the chat.</p>
            </div>
            <fieldset className="setup-group">
              <legend>Guests</legend>
              <div className="field-row">
                <div className="field narrow">
                  <label htmlFor="new-standard">Included</label>
                  <input type="number" id="new-standard" min={1} step={1} placeholder={String(roomDefaults.standard)} value={standard} onChange={(e) => setStandard(e.target.value)} />
                </div>
                <div className="field narrow">
                  <label htmlFor="new-capacity">At most</label>
                  <input type="number" id="new-capacity" min={1} step={1} placeholder={String(roomDefaults.max)} value={capacity} onChange={(e) => setCapacity(e.target.value)} />
                </div>
                <div className="field">
                  <label htmlFor="new-fee">Each extra guest</label>
                  <div className="input-prefix">
                    <span aria-hidden="true">{setup.currency === 'PHP' ? '₱' : setup.currency}</span>
                    <input type="text" id="new-fee" inputMode="decimal" placeholder={centavosToInput(roomDefaults.extraFee)} value={extraFee} onChange={(e) => setExtraFee(e.target.value)} />
                  </div>
                </div>
              </div>
              <p className="hint">Empty fields keep the defaults shown. You can change all of these later.</p>
            </fieldset>
            {/* Read back with the defaults filled in: what a guest will be told. */}
            <p className="setup-summary" aria-live="polite">
              <Icon name="bed" size={14} />
              {`${name.trim() || 'This room'} covers ${standard || roomDefaults.standard} guest${(standard || String(roomDefaults.standard)) === '1' ? '' : 's'}, takes up to ${capacity || roomDefaults.max}, and charges ${
                extraFee.trim() && parseMoneyInput(extraFee) !== null ? formatMoney(parseMoneyInput(extraFee)!, setup.currency) : formatMoney(roomDefaults.extraFee, setup.currency)
              } a night for each guest above ${standard || roomDefaults.standard}.`}
            </p>
            {notice?.kind === 'error' && formOpen && (
              <div className="notice error drawer-notice" role="alert">
                {notice.message}
              </div>
            )}
            <div className="drawer-footer">
              <div className="drawer-footer-total">
                <span className="small muted">{name.trim() === '' ? 'Give it a name' : 'It is offered once it has a rate.'}</span>
              </div>
              <button type="button" disabled={busy} onClick={() => setFormOpen(false)}>
                Cancel
              </button>
              <button type="submit" className="primary" aria-busy={busy || undefined} disabled={busy || name.trim() === ''}>
                {busy ? 'Adding…' : 'Add room'}
              </button>
            </div>
          </form>
        </Drawer>

        {rooms.length === 0 && (
          <section className="card">
            <EmptyState icon="bed" title="No rooms yet" action={addRoomAction}>
              A room needs a rate before the booking page offers it.
            </EmptyState>
          </section>
        )}
        {offered.length > 0 && (
          <div className="room-list-head">
            <span className="small muted">
              {offered.length} offered{unpriced > 0 ? ` · ${unpriced} without a rate` : ''}
            </span>
            {rooms.length > 1 && (
              <button type="button" className="ghost sm" onClick={() => setOpenIds(allOpen ? new Set() : new Set(rooms.map((r) => r.id)))}>
                {allOpen ? 'Collapse all' : 'Expand all'}
              </button>
            )}
          </div>
        )}
        {offered.map(card)}
        {retired.length > 0 && (
          <>
            <h2 className="room-group-title">
              Retired <span className="muted">· {retired.length}</span>
            </h2>
            {retired.map(card)}
          </>
        )}
      </StaffFrame>
    </>
  );
}
