'use client';

// A Copy button for text that is also on screen: a reference, an account
// number. Shared by Manage booking (S-13) and a booking's page (S-15).

import { useState } from 'react';
import { Icon } from './icons';

/** Copies a reference or an account number; the label says when it worked. */
export function CopyButton({ text, what }: { text: string; what: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="ghost sm"
      aria-label={copied ? `Copied ${what}` : `Copy ${what}`}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        } catch {
          // No clipboard (an insecure origin, a refused permission): the text is on screen to copy by hand.
        }
      }}
    >
      <Icon name={copied ? 'check' : 'copy'} size={14} /> {copied ? 'Copied' : 'Copy'}
    </button>
  );
}
