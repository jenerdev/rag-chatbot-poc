'use client';

// The two modal pieces of the staff screens (plan/ui-refresh.md Phase 7),
// both the native <dialog> opened with showModal(): the browser puts it in
// the top layer, makes the page behind it inert, and hands focus back to the
// control that opened it when it closes. Escape fires `cancel`, which is
// always "no", never "yes" (the plan's trap 5).
//
// useConfirmDialog() replaces window.prompt for a decision and its note
// (D-096): the same answer, a string or null, so a caller changes one line.
// Drawer is a side panel for a form that stays mounted while closed, so
// what was typed survives closing it.

import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Icon } from './icons';

export interface Question {
  title: string;
  /** What is being decided, in words: who, what, when. */
  body?: ReactNode;
  /** A note field's label ("Reason", "Note"); none = no field. Always optional. */
  noteLabel?: string;
  actionLabel: string;
  /** The way out; "Back" unless the question reads better otherwise ("Keep it"). */
  backLabel?: string;
  danger?: boolean;
}

/**
 * `const note = await ask({...})`: the note typed ('' for none) if the action
 * was chosen, null if not (Back, Escape, the backdrop). The answer
 * window.prompt gave, so the callers' logic is unchanged.
 */
export function useConfirmDialog() {
  const [open, setOpen] = useState<(Question & { resolve: (answer: string | null) => void }) | null>(null);
  const ask = useCallback((question: Question) => new Promise<string | null>((resolve) => setOpen({ ...question, resolve })), []);
  const dialog = open ? (
    <ConfirmDialog
      {...open}
      onDone={(answer) => {
        open.resolve(answer);
        setOpen(null);
      }}
    />
  ) : null;
  return { ask, dialog };
}

function ConfirmDialog({ title, body, noteLabel, actionLabel, backLabel = 'Back', danger, onDone }: Question & { onDone: (answer: string | null) => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [note, setNote] = useState('');
  const titleId = useId();
  const noteId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  // close() first: it is what returns focus to the opener; unmounting alone would not.
  const finish = (answer: string | null) => {
    ref.current?.close();
    onDone(answer);
  };

  return (
    <dialog
      ref={ref}
      className="dialog"
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        finish(null);
      }}
      // A click on the backdrop lands on the <dialog> itself (its box has no padding).
      onClick={(event) => event.target === ref.current && finish(null)}
    >
      <form
        className="dialog-inner"
        onSubmit={(event) => {
          event.preventDefault();
          finish(note);
        }}
      >
        <h2 id={titleId}>{title}</h2>
        {body && <div className="dialog-body">{body}</div>}
        {noteLabel && (
          <div className="field">
            <label htmlFor={noteId}>
              {noteLabel} <span className="muted">(optional)</span>
            </label>
            <textarea id={noteId} rows={3} autoFocus value={note} onChange={(event) => setNote(event.target.value)} />
          </div>
        )}
        <div className="dialog-actions">
          <button type="button" onClick={() => finish(null)}>
            {backLabel}
          </button>
          <button type="submit" className={danger ? 'danger solid' : 'primary'} autoFocus={!noteLabel}>
            {actionLabel}
          </button>
        </div>
      </form>
    </dialog>
  );
}

/** A side panel for a form. Mounted while closed, so its fields keep what was typed. */
export function Drawer({ open, title, onClose, children }: { open: boolean; title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    else if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      className="drawer"
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => event.target === ref.current && onClose()}
    >
      <div className="drawer-inner">
        <div className="drawer-head">
          <h2 id={titleId}>{title}</h2>
          <button type="button" className="ghost sm" aria-label="Close" onClick={onClose}>
            <Icon name="close" size={18} />
          </button>
        </div>
        {children}
      </div>
    </dialog>
  );
}
