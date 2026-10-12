// send.ts — one push to one device, and what the push service said.
//
//   TTL: 86400        a device that is off gets it within a day, never later (§ 2b.6)
//   Urgency: high     delivered at once, even to a phone saving its battery
//   Topic             one per stay: a newer push for the same reference
//                     replaces an undelivered older one at the service
//
// The answer is one of three, which notify_done() records:
//   ok     2xx
//   gone   404 or 410: the subscription no longer exists; its row is deleted
//   retry  anything else (429, 5xx, a network error): try again later

import { encryptPayload } from './encrypt.js';
import { vapidAuthorization, type VapidKeys } from './vapid.js';

export type PushResult = 'ok' | 'gone' | 'retry';

export interface PushTarget {
  endpoint: string;
  p256dh: string;
  auth: string;
}

/** Seconds a push service keeps a message for a device that is offline. */
export const PUSH_TTL_SECONDS = 24 * 60 * 60;

export async function sendPush(target: PushTarget, payload: object, keys: VapidKeys, topic?: string, fetchImpl: typeof fetch = fetch): Promise<PushResult> {
  const body = encryptPayload(JSON.stringify(payload), target.p256dh, target.auth);
  const headers: Record<string, string> = {
    Authorization: vapidAuthorization(target.endpoint, keys),
    'Content-Encoding': 'aes128gcm',
    'Content-Type': 'application/octet-stream',
    TTL: String(PUSH_TTL_SECONDS),
    Urgency: 'high',
  };
  // RFC 8030 § 5.4: up to 32 base64url characters.
  if (topic) headers.Topic = topic.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32);
  try {
    const response = await fetchImpl(target.endpoint, { method: 'POST', headers, body, redirect: 'error', signal: AbortSignal.timeout(10_000) });
    if (response.ok) return 'ok';
    if (response.status === 404 || response.status === 410) return 'gone';
    return 'retry';
  } catch {
    return 'retry';
  }
}
