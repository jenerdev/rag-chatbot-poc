'use client';

// The staff frame's ear (plan/notifications.md Phase 1, layer 1; § 8): while
// a staff page is open, ask every 30 s what is new for this member, and when
// a notification arrives, say so: a toast, and a two-tone chime if this
// device has the sound on. The Notifications badge and the tab title are
// drawn by StaffFrame from the same answer.
//
// Polling, not Supabase Realtime (§ 7 q1): Realtime would need a staff token
// in the browser, and a TenantContext never reaches a Client Component.
// A HIDDEN tab keeps asking (§ 8, which reversed § 2b.9): the chime is for a
// member who is in another tab or app, and a paused poll never rang for
// them. The browser may slow a hidden tab's timer to once a minute; a push
// to this device asks at once (the worker tells the tab), and so does a
// screen that marked something read.
//
// The chime is an OscillatorNode, no audio file. Browsers keep audio silent
// until the page has had a click (§ 2b.1). The sound is ON unless this
// device turned it off, and the first click anywhere on a staff page wakes
// it; until then the toggle says so.

import { useCallback, useEffect, useRef, useState } from 'react';
import { Icon } from './icons';
import { notify } from './toast';
import { ATTENTION_POLL_MS, NOTIFICATIONS_CHANGED, risen, type Attention } from '@/lib/attention';

const SOUND_KEY = 'rag-staff-sound';

// --- the chime ------------------------------------------------------------

let audio: AudioContext | null = null;

/** Made or resumed inside a click: the only moment a browser allows it. */
function wakeAudio(): void {
  try {
    audio ??= new AudioContext();
    if (audio.state === 'suspended') void audio.resume();
  } catch {
    audio = null;
  }
}

/**
 * Two short tones, a fifth apart. A context made in a click can still be
 * "suspended" for a moment while the browser starts it, so it is resumed
 * first; one the browser refuses stays silent (the toggle says so).
 */
function chime(): void {
  if (!audio) return;
  if (audio.state === 'running') return tones(audio);
  void audio
    .resume()
    .then(() => audio?.state === 'running' && tones(audio))
    .catch(() => undefined);
}

/** Softly in and out, so neither tone clicks. */
function tones(audio: AudioContext): void {
  const start = audio.currentTime;
  for (const [i, hz] of [880, 1320].entries()) {
    const at = start + i * 0.16;
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.type = 'sine';
    osc.frequency.value = hz;
    gain.gain.setValueAtTime(0, at);
    gain.gain.linearRampToValueAtTime(0.35, at + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.001, at + 0.3);
    osc.connect(gain).connect(audio.destination);
    osc.start(at);
    osc.stop(at + 0.32);
  }
}

/** On unless this device said off: a member who never found the toggle still hears it. */
function storedSound(): boolean {
  try {
    return window.localStorage.getItem(SOUND_KEY) !== 'off';
  } catch {
    return true;
  }
}

function storeSound(on: boolean): void {
  try {
    window.localStorage.setItem(SOUND_KEY, on ? 'on' : 'off');
  } catch {
    // A private window: the choice lasts for this page only.
  }
}

// --- the poll ---------------------------------------------------------------

/**
 * The unread count and the newest rows, or null before the first answer
 * (and for a tenant without bookings, which has nothing to say). `enabled`
 * false asks nothing.
 */
export function useAttention(slug: string, enabled: boolean, sound: boolean): Attention | null {
  const [counts, setCounts] = useState<Attention | null>(null);
  const last = useRef<Attention | null>(null);
  const soundOn = useRef(sound);
  soundOn.current = sound;

  const ask = useCallback(async () => {
    try {
      const response = await fetch(`/api/t/${slug}/admin/attention`, { cache: 'no-store' });
      // 401: the session ended; the screen's own reads say so. Nothing to announce.
      if (!response.ok) return;
      const next: Attention = await response.json();
      const news = risen(last.current, next);
      for (const message of news) notify(message, 'ok');
      if (news.length > 0 && soundOn.current) chime();
      last.current = next;
      setCounts(next);
    } catch {
      // Offline for a moment: the next tick tries again.
    }
  }, [slug]);

  useEffect(() => {
    if (!enabled) return;
    void ask();
    const timer = setInterval(() => void ask(), ATTENTION_POLL_MS);
    // Shown again: ask now rather than at the (possibly slowed) next tick.
    const onVisibility = () => document.visibilityState === 'visible' && void ask();
    // The service worker says a push reached this device (lib/service-worker.ts).
    const onWorker = (event: MessageEvent) => event.data?.type === 'rag-notification' && void ask();
    const onChanged = () => void ask();
    document.addEventListener('visibilitychange', onVisibility);
    navigator.serviceWorker?.addEventListener('message', onWorker);
    window.addEventListener(NOTIFICATIONS_CHANGED, onChanged);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
      navigator.serviceWorker?.removeEventListener('message', onWorker);
      window.removeEventListener(NOTIFICATIONS_CHANGED, onChanged);
    };
  }, [enabled, ask]);

  return counts;
}

// --- the toggle -------------------------------------------------------------

/** This device's choice, and whether the browser has let the sound start yet. */
export function useSound(): { on: boolean; awake: boolean; toggle: () => void } {
  const [on, setOn] = useState(false);
  const [awake, setAwake] = useState(false);

  // Read after mount: the server has no localStorage, and the first render must match it.
  useEffect(() => setOn(storedSound()), []);

  // On, but not yet allowed: the first click anywhere wakes it (§ 2b.1).
  useEffect(() => {
    if (!on || awake) return;
    const wake = () => {
      wakeAudio();
      setAwake(audio !== null);
    };
    document.addEventListener('pointerdown', wake, { once: true });
    return () => document.removeEventListener('pointerdown', wake);
  }, [on, awake]);

  // Side effects here, not in a state updater: React may call an updater twice.
  const toggle = useCallback(() => {
    const next = !on;
    setOn(next);
    storeSound(next);
    if (next) {
      wakeAudio();
      setAwake(audio !== null);
      // The click that turned it on also says what it will sound like.
      chime();
    }
  }, [on]);

  return { on, awake, toggle };
}

export function SoundToggle({ on, awake, onToggle }: { on: boolean; awake: boolean; onToggle: () => void }) {
  return (
    <button type="button" className="ghost sm sound-toggle" aria-pressed={on} onClick={onToggle}>
      <Icon name={on ? 'bell' : 'bell-off'} size={16} />
      {on ? (awake ? 'Sound on' : 'Sound on · click to allow') : 'Sound off'}
    </button>
  );
}
