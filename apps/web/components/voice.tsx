'use client';

// voice.tsx — talk to the assistant and hear it answer (plan/voice.md, D-134).
//
// Voice is a way in and a way out, never a second pipeline (Rule 1): a
// recording becomes text on the server (voice/transcribe), the chat screen
// sends that text exactly as if it had been typed, and the reply, once it is
// complete, is read aloud from the server (voice/speak). When that fails or
// stalls (Phase 0 saw OpenAI's speech take minutes), the browser reads the
// same speakable() text with a voice of its own, but only one that runs on
// the device (Rule 6). The question has no such fallback: the guest types.
//
// Nothing is kept: the recording is a Blob in this tab until it is sent, and
// the reply's audio an object URL revoked once it has played (Rule 4).

import { useCallback, useEffect, useRef, useState } from 'react';
import { Icon } from './icons';
import { speakable } from '@/lib/speakable';
import { MAX_RECORDING_SECONDS, SPEAK_TIMEOUT_MS } from '@/lib/voice';

export type VoiceState = 'idle' | 'listening' | 'transcribing' | 'speaking';

/** The guest's "read replies aloud" choice, per viewer (a convenience, so localStorage). */
const READ_ALOUD_KEY = 'rag-voice-read-aloud';
const COULD_NOT_HEAR = "I couldn't hear that. Please try again or type your question.";

/** What this browser records in: WebM/Opus where it can, Safari's MP4 otherwise. */
function recorderType(): string | undefined {
  if (typeof MediaRecorder === 'undefined') return undefined;
  return ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find((type) => MediaRecorder.isTypeSupported(type));
}

// Enough to tell a Tagalog or Taglish reply from an English one when picking
// a voice; the reply's language itself was decided on the server (D-043).
const TAGALOG = /\b(po|opo|ang|mga|kayo|namin|natin|ninyo|bukas|salamat|pwede|puwede|wala|meron|kami)\b/i;

/**
 * The device's own voice for this text: Filipino for a Tagalog reply when
 * the device has one, else English. ONLY a `localService` voice: some
 * browsers' voices are online services (Chrome's "Google" voices), and using
 * one would send the reply to a party the notice does not name (Rule 6).
 */
function localVoice(text: string): SpeechSynthesisVoice | null {
  if (typeof speechSynthesis === 'undefined') return null;
  const voices = speechSynthesis.getVoices().filter((voice) => voice.localService);
  const lang = (voice: SpeechSynthesisVoice, prefix: string) => voice.lang.toLowerCase().replace('_', '-').startsWith(prefix);
  const filipino = TAGALOG.test(text) ? voices.find((voice) => lang(voice, 'fil') || lang(voice, 'tl')) : undefined;
  return filipino ?? voices.find((voice) => lang(voice, 'en')) ?? null;
}

export function useVoice(api: string) {
  const [state, setState] = useState<VoiceState>('idle');
  const [seconds, setSeconds] = useState(0);
  const [message, setMessage] = useState<string | null>(null);
  const [readAloud, setReadAloudState] = useState(false);

  const recorder = useRef<MediaRecorder | null>(null);
  const discard = useRef(false);
  const audio = useRef<HTMLAudioElement | null>(null);
  // The speak request in flight. Stopping clears it, so its failure is not
  // mistaken for a stall and handed to the fallback voice.
  const speaking = useRef<AbortController | null>(null);

  useEffect(() => {
    try {
      setReadAloudState(localStorage.getItem(READ_ALOUD_KEY) === '1');
    } catch {
      // Private mode or blocked storage: the default, off.
    }
    // Chrome fills its voice list asynchronously; asking once starts it.
    if (typeof speechSynthesis !== 'undefined') speechSynthesis.getVoices();
  }, []);

  const stopSpeaking = useCallback(() => {
    speaking.current?.abort();
    speaking.current = null;
    if (audio.current) {
      audio.current.pause();
      if (audio.current.src) URL.revokeObjectURL(audio.current.src);
      audio.current.removeAttribute('src');
    }
    if (typeof speechSynthesis !== 'undefined') speechSynthesis.cancel();
    setState((current) => (current === 'speaking' ? 'idle' : current));
  }, []);

  const setReadAloud = useCallback(
    (on: boolean) => {
      setReadAloudState(on);
      try {
        localStorage.setItem(READ_ALOUD_KEY, on ? '1' : '0');
      } catch {
        // Remembered for this page only.
      }
      if (!on) stopSpeaking();
    },
    [stopSpeaking],
  );

  /** Stop recording and send what was said. */
  const finish = useCallback(() => {
    if (recorder.current?.state === 'recording') recorder.current.stop();
  }, []);

  /** Stop recording and throw it away (Escape, New chat). */
  const cancel = useCallback(() => {
    discard.current = true;
    finish();
  }, [finish]);

  /**
   * Record until finish(), cancel() or MAX_RECORDING_SECONDS, then turn it
   * into text on the server. The text, or null (nothing heard, refused, the
   * microphone blocked), with `message` saying why in words.
   */
  const listen = useCallback(async (): Promise<string | null> => {
    stopSpeaking();
    setMessage(null);
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      setMessage('This browser cannot record. Please type your question.');
      return null;
    }
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      setMessage('The microphone is blocked. Allow it in your browser’s settings for this site, or type your question.');
      return null;
    }

    const type = recorderType();
    const rec = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
    const chunks: Blob[] = [];
    rec.ondataavailable = (event) => {
      if (event.data.size > 0) chunks.push(event.data);
    };
    const stopped = new Promise<Blob | null>((resolve) => {
      rec.onstop = () => {
        // The browser's recording light goes off with the tracks.
        stream.getTracks().forEach((track) => track.stop());
        resolve(chunks.length > 0 ? new Blob(chunks, { type: rec.mimeType }) : null);
      };
    });
    discard.current = false;
    recorder.current = rec;
    rec.start();
    setSeconds(0);
    setState('listening');
    const started = Date.now();
    const tick = window.setInterval(() => {
      const elapsed = Math.floor((Date.now() - started) / 1000);
      setSeconds(elapsed);
      // The cap is the composer's; the route's is the size (Rule 5).
      if (elapsed >= MAX_RECORDING_SECONDS && rec.state === 'recording') rec.stop();
    }, 250);

    const blob = await stopped;
    window.clearInterval(tick);
    recorder.current = null;
    if (!blob || discard.current) {
      setState('idle');
      return null;
    }

    setState('transcribing');
    try {
      const form = new FormData();
      form.append('audio', blob, 'question');
      const response = await fetch(`${api}/voice/transcribe`, { method: 'POST', body: form });
      const body = (await response.json().catch(() => null)) as { text?: string; error?: string } | null;
      if (!response.ok || !body?.text) {
        // A refusal in words (too long, too many) is shown as it is; anything else is the one sentence.
        setMessage(response.status === 400 || response.status === 429 ? (body?.error ?? COULD_NOT_HEAR) : COULD_NOT_HEAR);
        return null;
      }
      return body.text;
    } catch {
      setMessage(COULD_NOT_HEAR);
      return null;
    } finally {
      setState('idle');
    }
  }, [api, stopSpeaking]);

  /** The device's own voice reads what the screen shows (Rule 6), or nothing. */
  const speakHere = useCallback((shown: string) => {
    const text = speakable(shown);
    const voice = text ? localVoice(text) : null;
    if (!voice) {
      setState('idle');
      return;
    }
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.voice = voice;
    utterance.lang = voice.lang;
    utterance.onend = utterance.onerror = () => setState((current) => (current === 'speaking' ? 'idle' : current));
    speechSynthesis.speak(utterance);
  }, []);

  /**
   * Read the conversation's latest reply aloud: the server's voice, or, when
   * that fails, stalls past SPEAK_TIMEOUT_MS or is refused, this device's.
   * `shown` is the reply as displayed, for the fallback only; the server
   * reads its own stored copy (Rule 2).
   */
  const speak = useCallback(
    async (conversationId: string, shown: string) => {
      stopSpeaking();
      const controller = new AbortController();
      speaking.current = controller;
      // The server gives up at SPEAK_TIMEOUT_MS; the margin is the network's.
      const timer = window.setTimeout(() => controller.abort(), SPEAK_TIMEOUT_MS + 3000);
      setState('speaking');
      try {
        const response = await fetch(`${api}/voice/speak`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ conversationId }),
          signal: controller.signal,
        });
        if (response.status === 204) {
          setState('idle');
          return;
        }
        if (!response.ok) throw new Error(`speak ${response.status}`);
        const url = URL.createObjectURL(await response.blob());
        if (speaking.current !== controller) {
          URL.revokeObjectURL(url);
          return;
        }
        const element = audio.current ?? (audio.current = new Audio());
        element.src = url;
        element.onended = () => {
          URL.revokeObjectURL(url);
          setState((current) => (current === 'speaking' ? 'idle' : current));
        };
        await element.play();
      } catch {
        // Stopped by the guest: silence. Anything else: the device's voice.
        if (speaking.current === controller) speakHere(shown);
      } finally {
        window.clearTimeout(timer);
      }
    },
    [api, speakHere, stopSpeaking],
  );

  // Escape stops whatever is happening: a recording is thrown away, a reply silenced.
  useEffect(() => {
    if (state !== 'listening' && state !== 'speaking') return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (state === 'listening') cancel();
      else stopSpeaking();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [state, cancel, stopSpeaking]);

  // Leaving the page: nothing keeps recording or talking.
  useEffect(() => () => {
    discard.current = true;
    if (recorder.current?.state === 'recording') recorder.current.stop();
    speaking.current?.abort();
    audio.current?.pause();
    if (typeof speechSynthesis !== 'undefined') speechSynthesis.cancel();
  }, []);

  return { state, seconds, message, readAloud, setReadAloud, listen, finish, cancel, speak, stopSpeaking, clearMessage: () => setMessage(null) };
}

/** The microphone in the composer: press to speak, press again to send. */
export function MicButton({ state, seconds, disabled, onStart, onFinish }: { state: VoiceState; seconds: number; disabled: boolean; onStart: () => void; onFinish: () => void }) {
  const listening = state === 'listening';
  const label = listening ? `Stop and send, ${seconds} of ${MAX_RECORDING_SECONDS} seconds` : state === 'transcribing' ? 'Turning your words into text' : 'Speak your question';
  return (
    <button
      type="button"
      className={listening ? 'composer-mic listening' : 'composer-mic'}
      aria-label={label}
      aria-busy={state === 'transcribing' || undefined}
      disabled={disabled || state === 'transcribing'}
      onClick={listening ? onFinish : onStart}
    >
      <Icon name={listening ? 'stop' : 'mic'} size={18} />
    </button>
  );
}

/** Under the field: what voice is doing, in words, with Stop while a reply is read. */
export function VoiceStatus({ state, seconds, message, onStop }: { state: VoiceState; seconds: number; message: string | null; onStop: () => void }) {
  const text =
    state === 'listening'
      ? `Listening… ${seconds} s. Press the button again to send, or Escape to cancel.`
      : state === 'transcribing'
        ? 'Turning your words into text…'
        : state === 'speaking'
          ? 'Reading the reply aloud.'
          : message;
  return (
    <div className={message && state === 'idle' ? 'voice-status error' : 'voice-status'} role="status" aria-live="polite">
      {text}
      {state === 'speaking' && (
        <button type="button" className="sm" onClick={onStop}>
          <Icon name="stop" size={14} /> Stop
        </button>
      )}
    </div>
  );
}

/** "Read replies aloud": typed questions' answers too. A spoken question's answer is always read. */
export function ReadAloudToggle({ on, onChange }: { on: boolean; onChange: (on: boolean) => void }) {
  return (
    <button type="button" className="link read-aloud" aria-pressed={on} onClick={() => onChange(!on)}>
      <Icon name={on ? 'speaker' : 'speaker-off'} size={14} /> Read replies aloud
    </button>
  );
}
