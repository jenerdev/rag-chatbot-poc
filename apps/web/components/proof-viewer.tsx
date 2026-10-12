'use client';

// A proof of payment, large, in a popup on the page (not a new tab): a photo
// as an image, a PDF in a frame. Used by Manage booking (the file a guest
// picked, from memory) and a booking's Review proof drawer (a 5-minute
// signed link). A native modal <dialog>, opened with showModal(), because
// the review drawer is itself one: a plain overlay could not rise above it,
// and the top layer stacks in opening order. Closed by ×, Escape or a click
// on the backdrop; focus returns to what opened it.
//
// `src` is a blob: URL or a signed Supabase URL, set as an attribute, never
// as markup. The thumbnail is a button, so it is reachable by keyboard.

import { useEffect, useRef, useState } from 'react';
import { Icon } from './icons';

export type ProofKind = 'image' | 'pdf';

/** What a proof is, from its type or its file name ("…/proof.pdf?token=…"). */
export function proofKind(typeOrUrl: string): ProofKind {
  if (typeOrUrl === 'application/pdf') return 'pdf';
  try {
    return new URL(typeOrUrl, 'http://x').pathname.toLowerCase().endsWith('.pdf') ? 'pdf' : 'image';
  } catch {
    return 'image';
  }
}

/** The popup alone, open while `open` is true. */
export function ProofViewer({ src, kind, open, onClose, label }: { src: string; kind: ProofKind; open: boolean; onClose: () => void; label: string }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    else if (!open && dialog.open) dialog.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      className="proof-viewer"
      aria-label={label}
      // Escape and clicks stop here: React passes them up its tree, and this
      // dialog sits inside the review drawer, whose own onCancel would close
      // the drawer too (seen in the walk: Escape closed both).
      onCancel={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }}
      onClick={(event) => {
        event.stopPropagation();
        if (event.target === ref.current) onClose();
      }}
    >
      <button type="button" className="proof-viewer-close" aria-label="Close" onClick={onClose}>
        <Icon name="close" size={20} />
      </button>
      {open && (kind === 'pdf' ? <iframe className="proof-viewer-pdf" src={src} title={label} /> : <img className="proof-viewer-img" src={src} alt={label} />)}
    </dialog>
  );
}

/**
 * A proof as a thumbnail that opens the popup: the image itself, or a PDF
 * tile. `label` names it for the alt text and the dialog ("Proof of payment").
 */
export function ProofThumb({ src, kind, label, size = 'small' }: { src: string; kind: ProofKind; label: string; size?: 'small' | 'large' }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className={`proof-thumb${size === 'large' ? ' large' : ''}`} onClick={() => setOpen(true)} aria-label={`View ${label.toLowerCase()} larger`}>
        {kind === 'pdf' ? (
          <span className="proof-thumb-pdf">
            <Icon name="file" size={28} />
            <span>PDF</span>
          </span>
        ) : (
          <img src={src} alt="" />
        )}
        <span className="proof-thumb-hint">
          <Icon name="eye" size={14} /> View
        </span>
      </button>
      <ProofViewer src={src} kind={kind} open={open} onClose={() => setOpen(false)} label={label} />
    </>
  );
}
