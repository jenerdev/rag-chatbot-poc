'use client';

// A tenant's logo or banner on the platform form (D-123): a preview, an
// Upload button, and Remove; pasting an image's address is still there,
// folded away, for an image that already lives somewhere.
//
// Upload saves AT ONCE (POST /api/platform/tenants/<id>/images): the image
// is resized and re-encoded in the browser first (lib/resize-image.ts,
// which also drops EXIF/GPS), the server checks it by its bytes, stores it
// in the brand-images bucket and points the tenant's field at it. Remove
// and a pasted address are ordinary form edits, saved with the form's Save,
// which also removes an uploaded image the tenant no longer uses.

import { useId, useState } from 'react';
import type { TenantDetail } from '@rag/pipeline';
import { describeFailure } from '@/components/admin-login';
import { Icon } from '@/components/icons';
import { resizeImage } from '@/lib/resize-image';

export function BrandImageField({
  api,
  tenantId,
  kind,
  label,
  hint,
  maxEdge,
  value,
  onChange,
  onUploaded,
  onMessage,
  onUnauthorized,
}: {
  api: string;
  tenantId: number;
  kind: 'logo' | 'banner' | 'avatar';
  label: string;
  hint: string;
  /** the longest edge kept, in px: a logo needs far less than a banner */
  maxEdge: number;
  value: string;
  onChange: (url: string) => void;
  onUploaded: (saved: TenantDetail) => void;
  onMessage: (message: string, kind: 'ok' | 'error') => void;
  onUnauthorized: () => void;
}) {
  const id = useId();
  const [busy, setBusy] = useState(false);

  async function upload(file: File) {
    setBusy(true);
    let response: Response | null = null;
    try {
      // A file the browser cannot draw is not an image, whatever its name says: say so, not "cannot reach the server".
      const resized = await resizeImage(file, maxEdge).catch(() => null);
      if (!resized) return onMessage('That file is not an image this page can read. Choose a JPEG, PNG or WebP.', 'error');
      const body = new FormData();
      body.set('kind', kind);
      body.set('file', resized.blob, `${kind}.${resized.blob.type.split('/')[1] ?? 'webp'}`);
      response = await fetch(`${api}/tenants/${tenantId}/images`, { method: 'POST', body });
      if (response.status === 401) return onUnauthorized();
      if (!response.ok) throw new Error('failed');
      const saved: TenantDetail = await response.json();
      onUploaded(saved);
      onMessage(`${label} uploaded and saved.`, 'ok');
    } catch (error) {
      onMessage(await describeFailure(error as Error, response), 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="field brand-image-field" role="group" aria-labelledby={`${id}-label`}>
      <span className="field-label" id={`${id}-label`}>
        {label}
      </span>
      <div className="brand-image-row">
        <div className={`brand-image-preview ${kind}`}>
          {value ? (
            // A plain <img>: an uploaded image is the tenant's bucket, a pasted one any https host.
            // eslint-disable-next-line @next/next/no-img-element
            <img src={value} alt={`Current ${label.toLowerCase()}`} />
          ) : (
            <span className="small muted">No {label.toLowerCase()}</span>
          )}
        </div>
        <div className="brand-image-actions">
          {/* The label opens the file picker; the span inside is what looks like a button (base.css styles span.button). */}
          <label className={`brand-upload${busy ? ' busy' : ''}`}>
            <input
              type="file"
              className="visually-hidden"
              accept="image/jpeg,image/png,image/webp"
              disabled={busy}
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = '';
                if (file) void upload(file);
              }}
            />
            <span className="button sm">
              <Icon name="image" size={14} /> {busy ? 'Uploading…' : value ? 'Replace' : 'Upload image'}
            </span>
          </label>
          {value && !busy && (
            <button type="button" className="ghost sm" onClick={() => onChange('')}>
              Remove
            </button>
          )}
        </div>
      </div>
      <details className="brand-image-url">
        <summary>Or paste an image address</summary>
        <input id={`${id}-url`} type="url" aria-label={`${label} address`} value={value} onChange={(e) => onChange(e.target.value)} placeholder="https://…" />
      </details>
      <p className="hint">{hint}</p>
    </div>
  );
}
