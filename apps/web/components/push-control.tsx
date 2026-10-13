'use client';

// "Notify me on this device" (plan/notifications.md Phase 4, layer 2): a
// system notification, with the device's own sound, even with the tab
// closed. The sidebar's control for THIS browser:
//
//   - the permission prompt only from the button (§ 2b.2): a page that asks
//     on load is quieted by Chrome and refused by iOS;
//   - iPhone Safari outside the Home Screen cannot subscribe (§ 2b.3), so it
//     says how, instead of failing;
//   - one service worker per tenant, scope /t/<slug>/ (§ 2b.4);
//   - on, the kinds this device wants: requests, change requests, and (for
//     the roles that verify them) proofs. Who hears what is decided again on
//     the server at send time (Rule 3); the boxes only narrow it;
//   - "Turn off on all my devices" whenever the member has a device other
//     than this one (R-51): a lost or sold phone stops hearing this tenant.
//
// The server's VAPID public key comes from GET /admin/push; with none, push
// is not set up here and the control says so (Rule 4).

import { useCallback, useEffect, useState } from 'react';
import { Icon } from './icons';
import { can, type Role } from '@/lib/permissions';

type Kind = 'request' | 'change' | 'proof';
type State = 'checking' | 'hidden' | 'unsupported' | 'ios-install' | 'off-server' | 'denied' | 'off' | 'on';

const KIND_LABELS: Record<Kind, string> = {
  request: 'New booking requests',
  change: 'Change requests',
  proof: 'Proofs of payment',
};
const ALL: Kind[] = ['request', 'change', 'proof'];

/** base64url → bytes, for applicationServerKey. */
function keyBytes(key: string): Uint8Array {
  const b64 = key.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(key.length / 4) * 4, '=');
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

function isIosOutsideHomeScreen(): boolean {
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const standalone = (navigator as Navigator & { standalone?: boolean }).standalone === true || window.matchMedia('(display-mode: standalone)').matches;
  return ios && !standalone;
}

/** A registration whose worker is active: subscribe() needs one. */
async function activeRegistration(scope: string): Promise<ServiceWorkerRegistration> {
  const reg = await navigator.serviceWorker.register(`${scope}sw.js`, { scope });
  if (reg.active) return reg;
  const worker = reg.installing ?? reg.waiting;
  await new Promise<void>((resolve) => {
    if (!worker) return resolve();
    worker.addEventListener('statechange', () => worker.state === 'activated' && resolve());
  });
  return reg;
}

export function PushControl({ slug, role }: { slug: string; role: Role | null }) {
  const scope = `/t/${slug}/`;
  const api = `/api/t/${slug}/admin/push`;
  const [state, setState] = useState<State>('checking');
  const [kinds, setKinds] = useState<Kind[]>(ALL);
  const [publicKey, setPublicKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // How many devices this member has here (this one included, when on).
  const [devices, setDevices] = useState(0);
  const [note, setNote] = useState<string | null>(null);
  const proofsToo = role !== null && can(role, 'payments:write');

  const load = useCallback(async () => {
    if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
      return setState(isIosOutsideHomeScreen() ? 'ios-install' : 'unsupported');
    }
    try {
      const reg = await navigator.serviceWorker.getRegistration(scope);
      const sub = await reg?.pushManager.getSubscription();
      const response = await fetch(sub ? `${api}?endpoint=${encodeURIComponent(sub.endpoint)}` : api, { cache: 'no-store' });
      if (!response.ok) return setState('hidden');
      const body: { publicKey: string | null; kinds: Kind[] | null; devices?: number } = await response.json();
      setPublicKey(body.publicKey);
      setDevices(body.devices ?? 0);
      if (!body.publicKey) return setState('off-server');
      if (Notification.permission === 'denied') return setState('denied');
      if (sub && body.kinds) {
        setKinds(body.kinds);
        return setState('on');
      }
      setState('off');
    } catch {
      setState('hidden');
    }
  }, [api, scope]);

  useEffect(() => {
    void load();
  }, [load]);

  /** Subscribe if needed, then store the subscription with these kinds. */
  const save = useCallback(
    async (wanted: Kind[]) => {
      if (!publicKey) return;
      setBusy(true);
      setError(null);
      try {
        // Asked from this click, never on load (§ 2b.2).
        const permission = await Notification.requestPermission();
        if (permission !== 'granted') {
          setState(permission === 'denied' ? 'denied' : 'off');
          return;
        }
        const reg = await activeRegistration(scope);
        let sub = await reg.pushManager.getSubscription();
        try {
          sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) as BufferSource });
        } catch {
          // A subscription made for an older server key: replace it.
          await sub?.unsubscribe();
          sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) as BufferSource });
        }
        const json = sub.toJSON();
        const response = await fetch(api, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ endpoint: json.endpoint, keys: json.keys, kinds: wanted }),
        });
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(typeof body.error === 'string' ? body.error : 'Could not turn notifications on.');
        setKinds(body.kinds ?? wanted);
        setState('on');
        setNote(null);
        void load();
      } catch (e) {
        setError((e as Error).message || 'Could not turn notifications on.');
      } finally {
        setBusy(false);
      }
    },
    [api, load, publicKey, scope],
  );

  const turnOff = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const reg = await navigator.serviceWorker.getRegistration(scope);
      const sub = await reg?.pushManager.getSubscription();
      if (sub) {
        await fetch(api, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ endpoint: sub.endpoint }) });
        await sub.unsubscribe();
      }
      setState('off');
      void load();
    } catch {
      setError('Could not turn notifications off.');
    } finally {
      setBusy(false);
    }
  }, [api, load, scope]);

  /** Every device of this member, here and elsewhere (R-51). */
  const turnOffAll = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(api, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ all: true }) });
      if (!response.ok) throw new Error('failed');
      const { removed } = (await response.json()) as { removed: number };
      const reg = await navigator.serviceWorker.getRegistration(scope);
      await (await reg?.pushManager.getSubscription())?.unsubscribe();
      setDevices(0);
      setState('off');
      setNote(removed === 1 ? 'Turned off on 1 device.' : `Turned off on ${removed} devices.`);
    } catch {
      setError('Could not turn notifications off on your devices.');
    } finally {
      setBusy(false);
    }
  }, [api, scope]);

  // Shown when another device would be reached: off here and any elsewhere, or on here and more than this one.
  const others = state === 'on' ? devices - 1 : devices;
  const allButton =
    others > 0 ? (
      <button type="button" className="ghost sm" disabled={busy} onClick={() => void turnOffAll()}>
        Turn off on all my devices ({devices})
      </button>
    ) : null;

  if (state === 'checking' || state === 'hidden') return null;
  if (state === 'unsupported') return <p className="push-note">This browser cannot show notifications.</p>;
  if (state === 'ios-install') return <p className="push-note">On iPhone: Share, then Add to Home Screen, and open it from there to get notifications.</p>;
  if (state === 'off-server') return <p className="push-note">Phone notifications are not set up on this server.</p>;
  if (state === 'denied') return <p className="push-note">Notifications are blocked for this site. Allow them in the browser’s site settings.</p>;

  if (state === 'off') {
    return (
      <>
        <button type="button" className="ghost sm push-toggle" disabled={busy} onClick={() => void save(kinds)}>
          <Icon name="phone" size={16} /> {busy ? 'Turning on…' : 'Notify me on this device'}
        </button>
        {allButton}
        {note && (
          <p className="push-note" role="status">
            {note}
          </p>
        )}
        {error && (
          <p className="push-note error" role="alert">
            {error}
          </p>
        )}
      </>
    );
  }

  const shown = ALL.filter((k) => k !== 'proof' || proofsToo);
  return (
    <details className="push-on">
      <summary>
        <Icon name="phone" size={16} /> Notifications on
      </summary>
      <fieldset disabled={busy}>
        <legend className="visually-hidden">Notify this device of</legend>
        {shown.map((k) => (
          <label key={k} className="push-kind">
            <input
              type="checkbox"
              checked={kinds.includes(k)}
              onChange={(e) => {
                const next = e.target.checked ? [...kinds, k] : kinds.filter((x) => x !== k);
                if (next.length === 0) return void turnOff();
                void save(next);
              }}
            />
            {KIND_LABELS[k]}
          </label>
        ))}
      </fieldset>
      <button type="button" className="ghost sm" disabled={busy} onClick={() => void turnOff()}>
        Turn off on this device
      </button>
      {allButton}
      {error && (
        <p className="push-note error" role="alert">
          {error}
        </p>
      )}
    </details>
  );
}
