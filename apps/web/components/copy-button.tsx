'use client';

// Copy for text a person would paste somewhere else: a booking reference,
// an email, a mobile number, a transaction or account number. ONE behaviour
// everywhere it appears (2026-10-12):
//
//   CopyButton   "Copy" with its icon, beside a headline value (the reference
//                on a booking's page and on Manage booking, an account number)
//   CopyText     the value itself, then a small icon-only copy button: for
//                values inside a row or a list of facts
//
// The button says it worked ("Copied", a check) for two seconds; its label
// names what it copies, for a screen reader. No clipboard (an insecure
// origin, a refused permission): nothing happens, and the text is on screen
// to copy by hand. The value is a React child, never markup.

import { useState, type ReactNode } from 'react';
import { Icon } from './icons';
import { Tip } from './tooltip';

function useCopy(text: string) {
  const [copied, setCopied] = useState(false);
  const copy = async (event: React.MouseEvent) => {
    // Inside a clickable row (a link or a card), copying is not opening.
    event.preventDefault();
    event.stopPropagation();
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // The text is on screen to copy by hand.
    }
  };
  return { copied, copy };
}

/** "Copy" beside a headline value; the label names what is copied. */
export function CopyButton({ text, what }: { text: string; what: string }) {
  const { copied, copy } = useCopy(text);
  return (
    <button type="button" className="ghost sm" aria-label={copied ? `Copied ${what}` : `Copy ${what}`} onClick={copy}>
      <Icon name={copied ? 'check' : 'copy'} size={14} /> {copied ? 'Copied' : 'Copy'}
    </button>
  );
}

/**
 * A value with a small copy button after it. `children` is how the value is
 * shown (a link for an email, a monospace reference); `text` is what is
 * copied, the bare value. `what` names it ("reference", "email").
 */
export function CopyText({ text, what, children, className }: { text: string; what: string; children?: ReactNode; className?: string }) {
  const { copied, copy } = useCopy(text);
  return (
    <span className={`copy-text${className ? ` ${className}` : ''}`}>
      {children ?? text}
      <Tip label={copied ? 'Copied' : `Copy ${what}`}>
        <button type="button" className="copy-icon" aria-label={copied ? `Copied ${what}` : `Copy ${what} ${text}`} onClick={copy}>
          <Icon name={copied ? 'check' : 'copy'} size={13} />
        </button>
      </Tip>
    </span>
  );
}
