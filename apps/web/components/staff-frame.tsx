'use client';

// The frame around every staff screen (plan/ui-refresh.md Phase 2,
// rearranged by plan/nav-layout.md).
//
// Signed in, it is a sidebar, a top bar and a content column:
//   - the sidebar is NAVIGATION only: the business, then the staff pages in
//     sections (groupNavItems: Overview, Front desk, Assistant, Setup);
//   - the top bar says where you are (section > page) and holds what is
//     about you, not a place: the Notifications bell with the ONE badge,
//     and the account menu (role, the guest pages, this device's sound and
//     push, Log out);
//   - the content column holds the page title and the screen.
// Below 900 px the sidebar is a drawer behind a menu
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
import { useCallback, useEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { SoundToggle, useAttention, useSound } from './attention';
import { BrandHeader } from './brand-header';
import { AccountMenu } from './account-menu';
import { BuildTag } from './build-tag';
import { PushControl } from './push-control';
import { Icon, type IconName } from './icons';
import { LinkProgress } from './route-progress';
import { PageBones } from './session-check';
import { StaffShellSkeleton } from './staff-skeleton';
import { TenantNav, type SessionState } from './tenant-nav';
import { Toaster } from './toast';
import { groupNavItems, groupOf, navItems, type NavFeatures, type NavItem, type NavPage } from '@/lib/nav-items';
import type { Role } from '@/lib/permissions';
import { titleWithCount } from '@/lib/attention';

const ICON_OF: Readonly<Record<NavPage, IconName>> = {
  chat: 'chat',
  book: 'book',
  manage: 'search',
  payments: 'check',
  dashboard: 'chart',
  notifications: 'bell',
  documents: 'file',
  unanswered: 'help',
  conversations: 'messages',
  bookings: 'calendar',
  calendar: 'calendar-grid',
  rooms: 'bed',
  holidays: 'flag',
  slots: 'clock',
  promos: 'tag',
  members: 'users',
  activity: 'eye',
  reset: 'user',
  legal: 'file',
};

/** The drawer's breakpoint; the same number as the media query in base.css. */
const DRAWER_BELOW = 900;

export interface StaffFrameProps {
  slug: string;
  businessName: string;
  logoUrl: string | null;
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

export function StaffFrame({ slug, businessName, logoUrl, features, current, title, session, mainClassName, actions, children }: StaffFrameProps) {
  const [open, setOpen] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);
  // The page a clicked link is bringing (D-149). While it is on its way (the
  // next page's server render, in flight) the content column shows THAT
  // page's title and the body bones instead of the old page, so a click
  // answers at once; the sidebar and the top bar stay put. Before, the old
  // page sat there until the new one arrived, the progress bar (D-145) the
  // only sign. Not a Next loading boundary: that streams a 200 before a
  // page can say 404, and a missing feature must still be a 404 (D-127).
  // The new page mounts its own frame, so this state goes with the old one.
  // The PAGE key, not the item: the items are rebuilt every render, and a
  // state set to a fresh object each time would never settle.
  const [pending, setPending] = useState<NavPage | null>(null);
  // What is new for this member (plan/notifications.md § 8): polled while
  // signed in on a tenant with bookings, the only one with anything to say.
  const sound = useSound();
  // With notifications switched off (D-127) nothing is polled, chimed or pushed.
  const notices = features.bookings && features.flags.notifications;
  const attention = useAttention(slug, session.auth === 'in' && notices, sound.on);
  const waiting = attention?.unread ?? 0;
  // "(2) Bookings · Villa" while two are unread; the title as it was when none are, and on the way out.
  useEffect(() => {
    document.title = titleWithCount(document.title, waiting);
  }, [waiting, current]);
  useEffect(() => () => void (document.title = titleWithCount(document.title, 0)), []);
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

  // While the session is checked, the whole shell as a skeleton (D-145): the
  // page that is coming, not a message. The screens pass no children here.
  if (session.auth === 'checking') return <StaffShellSkeleton businessName={businessName} logoUrl={logoUrl} title={title} />;

  if (session.auth !== 'in') {
    return (
      <>
        <BrandHeader businessName={businessName} logoUrl={logoUrl} bannerUrl={null} subtitle={title}>
          <TenantNav slug={slug} features={features} current={current} session={session} />
        </BrandHeader>
        <main className={mainClassName}>{children}</main>
      </>
    );
  }

  const items = navItems(slug, features, session.role, attention);
  const { groups, topItems, publicItems } = groupNavItems(items);
  const coming = pending ? (items.find((item) => item.page === pending) ?? null) : null;
  const bell = topItems.find((item) => item.page === 'notifications');
  const section = groupOf(coming?.page ?? current);
  const here = coming?.label ?? groups.flatMap((g) => g.items).find((item) => item.page === current)?.label ?? title;
  // Set in the link's own click, synchronously: a report from useLinkStatus()
  // arrives inside the navigation's optimistic render, and a state set from
  // there did not draw until the page arrived (the walk: the ring and the
  // bar showed, the bones never did). The hook still CLEARS it, for a
  // navigation that ends without a new page (cancelled, or back). A plain
  // left click only: a ctrl- or middle-click opens a tab and moves nothing
  // here. A link to the page already shown leaves it be.
  const goingTo = (item: NavItem) => (event: MouseEvent<HTMLAnchorElement>) => {
    if (item.page === current || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    setPending(item.page);
  };
  const whenPending = (item: NavItem) => (on: boolean) => {
    if (!on) setPending((was) => (was === item.page ? null : was));
  };
  const guestPages = publicItems.map((item) => ({ label: item.page === 'book' ? 'Booking page' : item.page === 'manage' ? 'Manage booking' : 'Chat page', href: item.href, icon: ICON_OF[item.page] }));
  const link = (item: { page: NavPage; label: string; href: string; badge?: number }) => (
    <Link
      key={item.page}
      href={item.href}
      className="sidebar-link"
      aria-current={item.page === (coming?.page ?? current) ? 'page' : undefined}
      onClick={(event) => {
        setOpen(false);
        goingTo(item)(event);
      }}
    >
      <Icon name={ICON_OF[item.page]} size={18} />
      <span>{item.label}</span>
      {item.badge ? (
        <>
          <span className="nav-badge" aria-hidden="true">
            {item.badge}
          </span>
          <span className="visually-hidden">, {item.badge} unread</span>
        </>
      ) : null}
      <LinkProgress onPending={whenPending(item)} />
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
        {/* D-148: which build this is, where a staff member looks last and a phone can read it. */}
        <div className="sidebar-foot">
          <BuildTag />
        </div>
      </aside>
      <div className="sidebar-backdrop" aria-hidden="true" onClick={close} />

      <div className="staff-main" inert={open || undefined}>
        {/* role, not <header>: the element selector would restyle it as the
            public header. The landmark keeps the top bar inside one (Phase
            10's audit). On every width since plan/nav-layout.md: where you
            are on the left; the bell and the account menu on the right. */}
        <div className="staff-topbar" role="banner">
          <button ref={menuButton} type="button" className="ghost topbar-menu" aria-label="Open menu" aria-controls="staff-sidebar" aria-expanded={open} onClick={() => setOpen(true)}>
            <Icon name="menu" />
          </button>
          <span className="staff-topbar-title">{businessName}</span>
          <nav className="topbar-crumbs" aria-label="Breadcrumb">
            {section && (
              <>
                <span className="topbar-section">{section}</span>
                <Icon name="chevron-right" size={14} />
              </>
            )}
            <span className="topbar-here" aria-current="page">
              {here}
            </span>
          </nav>
          <div className="topbar-actions">
            {bell && (
              <Link href={bell.href} className="button ghost topbar-bell" aria-current={current === 'notifications' ? 'page' : undefined} aria-label={waiting > 0 ? `Notifications, ${waiting} unread` : 'Notifications'} onClick={goingTo(bell)}>
                <Icon name="bell" size={18} />
                {waiting > 0 && (
                  <span className="nav-badge bell-badge" aria-hidden="true">
                    {waiting > 99 ? '99+' : waiting}
                  </span>
                )}
                <LinkProgress ring={false} onPending={whenPending(bell)} />
              </Link>
            )}
            <AccountMenu
              role={session.role}
              links={guestPages}
              onLogout={session.onLogout}
              device={
                notices ? (
                  <>
                    <SoundToggle on={sound.on} awake={sound.awake} onToggle={sound.toggle} />
                    <PushControl slug={slug} role={session.role} />
                  </>
                ) : null
              }
            />
          </div>
        </div>
        <main className={mainClassName ? `staff-content ${mainClassName}` : 'staff-content'}>
          <div className="page-head">
            <h1 className="page-title">{coming ? coming.label : title}</h1>
            {!coming && actions && <div className="page-actions">{actions}</div>}
          </div>
          {coming ? (
            // The same bones the coming page shows while it checks the
            // session (staff-skeleton.tsx), so the hand-off moves nothing.
            // Hidden and inert, as there: the page that arrives is the
            // announcement (D-145).
            <div className="page-pending" aria-hidden="true" inert>
              <PageBones />
            </div>
          ) : (
            children
          )}
        </main>
        {/* The page's ONE toast region (components/toast.tsx). Signed out
            there is nothing to report: the login form says its own errors. */}
        <Toaster />
      </div>
    </div>
  );
}
