// base64url (RFC 4648 § 5): what Web Push writes every key and every JWT
// part in. No padding on the way out; padding tolerated on the way in,
// because a browser's PushSubscription.toJSON() and a JWK do not agree.

export function toBase64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

export function fromBase64url(text: string): Buffer {
  return Buffer.from(text.replace(/=+$/, ''), 'base64url');
}
