'use client';

// The top bar's account menu (plan/nav-layout.md): what is about THIS member
// and THIS device, out of the sidebar, which is now navigation only.
//
//   - who is signed in, as what role;
//   - the public pages (Chat, Book, Manage booking): where guests go, opened from here;
//   - this device: the Sound toggle and push (components/attention.tsx,
//     push-control.tsx), which are settings, not places;
//   - Log out.
//
// A disclosure, not an ARIA menu: a button with aria-expanded that shows a
// panel of ordinary links and controls, which Tab walks as it would any
// region (a menu role would demand arrow keys and forbid the checkboxes
// inside). Escape closes it and gives focus back to the button; a press
// outside, or Tab moving focus out of it, closes it where focus already
// is. The panel stays MOUNTED while closed (`hidden`), so push's state,
// read once on load, is not lost by closing it.

import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Icon, type IconName } from './icons';
import { ROLE_LABELS, type Role } from '@/lib/permissions';

export interface AccountMenuLink {
  label: string;
  href: string;
  icon: IconName;
}

export function AccountMenu({ role, label, links, device, onLogout }: { role: Role | null; label?: string; links: AccountMenuLink[]; device: ReactNode; onLogout: () => void }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const box = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  // `label` for an account that is not a tenant role: the platform's super user.
  const roleLabel = label ?? (role ? ROLE_LABELS[role] : 'Staff');

  const close = useCallback((focusButton: boolean) => {
    setOpen(false);
    if (focusButton) button.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && close(true);
    const outside = (event: Event) => !box.current?.contains(event.target as Node) && close(false);
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', outside);
    document.addEventListener('focusin', outside);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('focusin', outside);
    };
  }, [open, close]);

  return (
    <div className="account-menu" ref={box}>
      <button ref={button} type="button" className="ghost account-button" aria-expanded={open} aria-controls={id} onClick={() => setOpen((o) => !o)}>
        <span className="account-avatar" aria-hidden="true">
          <Icon name="user" size={16} />
        </span>
        <span className="account-role">{roleLabel}</span>
        <Icon name="chevron-down" size={14} />
        <span className="visually-hidden">{device ? ', account and this device' : ', account'}</span>
      </button>
      <div id={id} className="account-panel" hidden={!open}>
        <div className="account-section">
          <span className="account-signed">Signed in as</span>
          <span className="badge accent">{roleLabel}</span>
        </div>
        {links.length > 0 && (
          <div className="account-section" role="group" aria-label="Guest pages">
            <span className="account-heading">Guest pages</span>
            {/* A guest page opens in a NEW tab (the user, 2026-10-21): staff look at it beside their
                work, not instead of it. A plain <a>, not <Link>: nothing to prefetch or soft-navigate
                when the page leaves this tab. The hidden words say so to a screen reader (WCAG G201). */}
            {links.map((link) => (
              <a key={link.href} href={link.href} className="account-link" target="_blank" rel="noopener" onClick={() => close(false)}>
                <Icon name={link.icon} size={16} />
                <span>{link.label}</span>
                <span className="visually-hidden"> (opens in a new tab)</span>
              </a>
            ))}
          </div>
        )}
        {device && (
          <div className="account-section" role="group" aria-label="This device">
            <span className="account-heading">This device</span>
            {device}
          </div>
        )}
        <div className="account-section">
          <button type="button" className="ghost sm account-link" onClick={onLogout}>
            <Icon name="logout" size={16} />
            <span>Log out</span>
          </button>
        </div>
      </div>
    </div>
  );
}
