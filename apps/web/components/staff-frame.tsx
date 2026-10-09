'use client';

// The frame around every staff screen (plan/ui-refresh.md Phase 2).
//
// Signed in, it is a sidebar and a content column: the sidebar holds the
// business, the staff links in sections (groupNavItems), and a footer with
// the public pages, the role and Log out; the content column holds the page
// title and the screen. Below 900 px the sidebar is a drawer behind a menu
// button: it takes focus when it opens, Escape or the backdrop closes it, and
// the page behind it is `inert` while it is open, so neither a keyboard nor a
// screen reader can wander out of it.
//
// Signed out, or while the session is checked, it is the header and <main>
// every screen had before, unchanged: the login card needs no sidebar, and a
// sidebar of links the visitor cannot open would only invite 401s.
//
// WHICH links appear is navItems()'s decision alone, as before; this file
// decides only how they look. Hiding a link is never the guard: every route
// still asks requireAdmin() for its permission.

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { BrandHeader } from './brand-header';
import { Icon, type IconName } from './icons';
import { TenantNav, type SessionState } from './tenant-nav';
import { Toaster } from './toast';
import { groupNavItems, navItems, type NavFeatures, type NavPage } from '@/lib/nav-items';
import { ROLE_LABELS, type Role } from '@/lib/permissions';

const ICON_OF: Readonly<Record<NavPage, IconName>> = {
  chat: 'chat',
  book: 'book',
  manage: 'search',
  payments: 'check',
  dashboard: 'chart',
  documents: 'file',
  unanswered: 'help',
  bookings: 'calendar',
  calendar: 'calendar-grid',
  rooms: 'bed',
  holidays: 'flag',
  slots: 'clock',
  promos: 'tag',
  members: 'users',
  reset: 'user',
};

/** The drawer's breakpoint; the same number as the media query in base.css. */
const DRAWER_BELOW = 900;

export interface StaffFrameProps {
  slug: string;
  businessName: string;
  logoUrl: string | null;
  bannerUrl: string | null;
  features: NavFeatures;
  current: NavPage;
  /** The page's name: the header's subtitle signed out, the page title signed in. */
  title: string;
  session: { auth: SessionState; role: Role | null; onLogout: () => void };
  /** A class for <main>, as the screen had it (the dashboard's). */
  mainClassName?: string;
  /** The page's primary action, beside its title (Phase 7: "New booking"). Signed in only. */
  actions?: ReactNode;
  children: ReactNode;
}

export function StaffFrame({ slug, businessName, logoUrl, bannerUrl, features, current, title, session, mainClassName, actions, children }: StaffFrameProps) {
  const [open, setOpen] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);
  const drawer = useRef<HTMLElement>(null);

  const returnFocus = useRef(false);

  // Closing hands focus back to the menu button, but only AFTER the render
  // that lifts `inert` from the page: a focus() before it is refused.
  const close = useCallback(() => {
    returnFocus.current = true;
    setOpen(false);
  }, []);
  useEffect(() => {
    if (!open && returnFocus.current) {
      returnFocus.current = false;
      menuButton.current?.focus();
    }
  }, [open]);

  // Open: focus the first control. Escape closes; Tab wraps from the last
  // control to the first and back, because `inert` keeps focus out of the
  // page but not out of whatever else the browser puts after the drawer.
  // Widening past the breakpoint closes too, so a desktop never keeps an
  // invisible "open" drawer (and an inert page with it).
  useEffect(() => {
    if (!open) return;
    drawer.current?.querySelector<HTMLElement>('a, button')?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') return close();
      if (event.key !== 'Tab' || !drawer.current) return;
      const controls = [...drawer.current.querySelectorAll<HTMLElement>('a[href], button:not(:disabled)')];
      const first = controls[0];
      const last = controls[controls.length - 1];
      const inside = drawer.current.contains(document.activeElement);
      if (event.shiftKey && (document.activeElement === first || !inside)) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !inside)) {
        event.preventDefault();
        first?.focus();
      }
    };
    const wide = window.matchMedia(`(min-width: ${DRAWER_BELOW}px)`);
    const onWide = () => wide.matches && setOpen(false);
    document.addEventListener('keydown', onKey);
    wide.addEventListener('change', onWide);
    return () => {
      document.removeEventListener('keydown', onKey);
      wide.removeEventListener('change', onWide);
    };
  }, [open, close]);

  if (session.auth !== 'in') {
    return (
      <>
        <BrandHeader businessName={businessName} logoUrl={logoUrl} bannerUrl={bannerUrl} subtitle={title}>
          <TenantNav slug={slug} features={features} current={current} session={session} />
        </BrandHeader>
        <main className={mainClassName}>{children}</main>
      </>
    );
  }

  const { groups, publicItems } = groupNavItems(navItems(slug, features, session.role));
  const link = (item: { page: NavPage; label: string; href: string }) => (
    <Link
      key={item.page}
      href={item.href}
      className="sidebar-link"
      aria-current={item.page === current ? 'page' : undefined}
      onClick={() => setOpen(false)}
    >
      <Icon name={ICON_OF[item.page]} size={18} />
      <span>{item.label}</span>
    </Link>
  );

  return (
    <div className={open ? 'staff-shell drawer-open' : 'staff-shell'}>
      <aside ref={drawer} id="staff-sidebar" className="staff-sidebar" aria-label="Staff navigation">
        <div className="sidebar-brand">
          {logoUrl && (
            // eslint-disable-next-line @next/next/no-img-element
            <img className="brand-logo" src={logoUrl} alt="" />
          )}
          <span className="sidebar-business">{businessName}</span>
          <button type="button" className="ghost sm sidebar-close" aria-label="Close menu" onClick={close}>
            <Icon name="close" size={18} />
          </button>
        </div>
        <nav className="sidebar-nav">
          {groups.map(({ group, items }) => (
            <div key={group} className="sidebar-group">
              <div className="sidebar-group-label">{group}</div>
              {items.map(link)}
            </div>
          ))}
        </nav>
        <div className="sidebar-footer">
          {publicItems.map(link)}
          <div className="sidebar-account">
            {session.role && <span className="badge accent">{ROLE_LABELS[session.role]}</span>}
            <button type="button" className="ghost sm" onClick={session.onLogout}>
              <Icon name="logout" size={16} /> Log out
            </button>
          </div>
        </div>
      </aside>
      <div className="sidebar-backdrop" aria-hidden="true" onClick={close} />

      <div className="staff-main" inert={open || undefined}>
        {/* role, not <header>: the element selector would restyle it as the
            public header. The landmark keeps the phone's top bar inside one
            (Phase 10's audit). */}
        <div className="staff-topbar" role="banner">
          <button
            ref={menuButton}
            type="button"
            className="ghost"
            aria-label="Open menu"
            aria-controls="staff-sidebar"
            aria-expanded={open}
            onClick={() => setOpen(true)}
          >
            <Icon name="menu" />
          </button>
          <span className="staff-topbar-title">{businessName}</span>
        </div>
        {bannerUrl && (
          // eslint-disable-next-line @next/next/no-img-element
          <img className="brand-banner" src={bannerUrl} alt="" />
        )}
        <main className={mainClassName ? `staff-content ${mainClassName}` : 'staff-content'}>
          <div className="page-head">
            <h1 className="page-title">{title}</h1>
            {actions && <div className="page-actions">{actions}</div>}
          </div>
          {children}
        </main>
        {/* The page's ONE toast region (components/toast.tsx). Signed out
            there is nothing to report: the login form says its own errors. */}
        <Toaster />
      </div>
    </div>
  );
}
