// icons.tsx — the app's icons, hand-drawn (plan/ui-refresh.md Rule 1).
//
// No icon font and no icon package: each icon is a few SVG strokes on a
// 20 x 20 grid, drawn in `currentColor`, so it takes the colour of the text
// beside it and follows the tenant theme and dark mode with no rule of its
// own. Decorative by default (aria-hidden); pass `label` when the icon is the
// only thing that says what a control does, and it becomes role="img".
//
// A Server or Client Component alike: no state, no effects.

import type { ReactNode } from 'react';

const PATHS = {
  menu: <path d="M3 5h14M3 10h14M3 15h14" />,
  close: <path d="M5 5l10 10M15 5L5 15" />,
  'chevron-left': <path d="M12 5l-5 5 5 5" />,
  'chevron-right': <path d="M8 5l5 5-5 5" />,
  'chevron-down': <path d="M5 8l5 5 5-5" />,
  'arrow-up': <path d="M10 16V4M5 9l5-5 5 5" />,
  check: <path d="M4 10.5l4 4 8-9" />,
  plus: <path d="M10 4v12M4 10h12" />,
  edit: <path d="M13.5 3.5l3 3L7 16H4v-3z" />,
  trash: <path d="M3.5 6h13M8 6V4h4v2M5.5 6l.8 10.5h7.4L14.5 6" />,
  copy: (
    <>
      <rect x="7" y="7" width="9.5" height="9.5" rx="1.5" />
      <path d="M13 7V5a1.5 1.5 0 00-1.5-1.5H5A1.5 1.5 0 003.5 5v6.5A1.5 1.5 0 005 13h2" />
    </>
  ),
  // Two arrows round: reload a list (Unanswered's Refresh).
  refresh: <path d="M16 4v4h-4M4 16v-4h4M15.3 8A6 6 0 004.6 7.5M4.7 12a6 6 0 0010.7.5" />,
  // A handset, and an envelope: the guest's two contacts on a booking's page (D-114).
  phone: <path d="M6.5 3.5H4.8a1.3 1.3 0 00-1.3 1.4c.6 6.2 5.4 11 11.6 11.6a1.3 1.3 0 001.4-1.3v-1.7l-3.2-1.3-1.6 1.6a9 9 0 01-4.6-4.6l1.6-1.6z" />,
  mail: (
    <>
      <rect x="3" y="5" width="14" height="10" rx="1.5" />
      <path d="M3.5 6l6.5 5 6.5-5" />
    </>
  ),
  search: (
    <>
      <circle cx="9" cy="9" r="5.5" />
      <path d="M13 13l3.5 3.5" />
    </>
  ),
  eye: (
    <>
      <path d="M1.8 10S4.8 4.5 10 4.5 18.2 10 18.2 10 15.2 15.5 10 15.5 1.8 10 1.8 10z" />
      <circle cx="10" cy="10" r="2.5" />
    </>
  ),
  'eye-off': (
    <>
      <path d="M1.8 10S4.8 4.5 10 4.5 18.2 10 18.2 10 15.2 15.5 10 15.5 1.8 10 1.8 10z" />
      <circle cx="10" cy="10" r="2.5" />
      <path d="M3 3l14 14" />
    </>
  ),
  home: <path d="M3 9.5l7-6 7 6M5 8v8.5h10V8" />,
  chat: <path d="M3.5 5.5a2 2 0 012-2h9a2 2 0 012 2v6a2 2 0 01-2 2H8l-4.5 3.5z" />,
  messages: <path d="M2.5 4.5a1.5 1.5 0 011.5-1.5h7a1.5 1.5 0 011.5 1.5v4.5a1.5 1.5 0 01-1.5 1.5H6.5L3.5 13zM14.5 7.5H16a1.5 1.5 0 011.5 1.5v4.5a1.5 1.5 0 01-1.5 1.5V17l-3-2h-3.5a1.5 1.5 0 01-1.5-1.5" />,
  chart: <path d="M3.5 16.5h13M6 13.5v-4M10 13.5v-8M14 13.5v-6" />,
  file: <path d="M5 2.5h6.5L15 6v11.5H5zM11.5 2.5V6H15M7.5 10h5M7.5 13h5" />,
  help: (
    <>
      <circle cx="10" cy="10" r="7" />
      <path d="M7.8 7.8a2.3 2.3 0 114 1.6c-.8.5-1.8 1-1.8 2.1M10 14.2v.1" />
    </>
  ),
  calendar: (
    <>
      <rect x="3" y="4.5" width="14" height="12" rx="2" />
      <path d="M3 8.5h14M7 2.5v4M13 2.5v4" />
    </>
  ),
  book: (
    <>
      <rect x="3" y="4.5" width="14" height="12" rx="2" />
      <path d="M3 8.5h14M7 2.5v4M13 2.5v4M7.5 12.5l2 2 3.5-3.5" />
    </>
  ),
  bed: (
    <>
      <path d="M2.5 15.5v-11M2.5 12h15v3.5M17.5 12V9.5a2 2 0 00-2-2H9V12" />
      <circle cx="5.8" cy="9.2" r="1.4" />
    </>
  ),
  flag: <path d="M4.5 17V3.5M4.5 4h9.5l-1.8 3.2L14 10.5H4.5" />,
  clock: (
    <>
      <circle cx="10" cy="10" r="7" />
      <path d="M10 6v4l2.5 2.5" />
    </>
  ),
  tag: (
    <>
      <path d="M3.5 3.5h6l7 7-6 6-7-7z" />
      <circle cx="7" cy="7" r="1" />
    </>
  ),
  user: (
    <>
      <circle cx="10" cy="7" r="3" />
      <path d="M4 17c.8-3 3.2-4.5 6-4.5s5.2 1.5 6 4.5" />
    </>
  ),
  users: (
    <>
      <circle cx="7.5" cy="7.5" r="2.5" />
      <path d="M2.5 16c.6-2.5 2.6-3.8 5-3.8s4.4 1.3 5 3.8M13 5.2a2.5 2.5 0 010 4.6M14.5 12.4c1.5.4 2.6 1.6 3 3.6" />
    </>
  ),
  image: (
    <>
      <rect x="3" y="4" width="14" height="12" rx="2" />
      <circle cx="7.5" cy="8.5" r="1.5" />
      <path d="M17 13l-4-4-7 7" />
    </>
  ),
  info: (
    <>
      <circle cx="10" cy="10" r="7" />
      <path d="M10 9v4.5M10 6.5v.1" />
    </>
  ),
  alert: <path d="M10 3.5l7.5 13h-15zM10 8.5V12M10 14.2v.1" />,
  bell: <path d="M10 3.5A4.5 4.5 0 005.5 8v3L4 13.5h12L14.5 11V8A4.5 4.5 0 0010 3.5zM8.3 15.5a1.8 1.8 0 003.4 0" />,
  'bell-off': <path d="M10 3.5A4.5 4.5 0 005.5 8v3L4 13.5h12L14.5 11V8A4.5 4.5 0 0010 3.5zM8.3 15.5a1.8 1.8 0 003.4 0M3.5 3.5l13 13" />,
  // The staff calendar (plan/calendar.md, D-103): its nav link, and the two
  // date markers that sit on top of a cell's background.
  'calendar-grid': (
    <>
      <rect x="3" y="4.5" width="14" height="12" rx="2" />
      <path d="M3 8.5h14M7 2.5v4M13 2.5v4M7 11.5h.1M10 11.5h.1M13 11.5h.1M7 14h.1M10 14h.1" />
    </>
  ),
  star: <path d="M10 3l2.1 4.4 4.8.6-3.5 3.3.9 4.7L10 13.7 5.7 16l.9-4.7L3.1 8l4.8-.6z" />,
  flame: <path d="M10 17c-3 0-5-2-5-4.8 0-3.2 3-4.7 3-8.2 2.8 1.6 4 3.9 3.6 6.1.9-.4 1.5-1.2 1.7-2.3 1.7 1.4 1.7 3.1 1.7 4.4C15 15 13 17 10 17z" />,
  logout: <path d="M8 3.5H5A1.5 1.5 0 003.5 5v10A1.5 1.5 0 005 16.5h3M12.5 6.5L16 10l-3.5 3.5M16 10H8" />,
} satisfies Record<string, ReactNode>;

export type IconName = keyof typeof PATHS;
export const ICON_NAMES = Object.keys(PATHS) as IconName[];

export function Icon({ name, size = 20, label, className }: { name: IconName; size?: number; label?: string; className?: string }) {
  return (
    <svg
      className={className ? `icon ${className}` : 'icon'}
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={label ? undefined : true}
      role={label ? 'img' : undefined}
      aria-label={label}
      focusable="false"
    >
      {PATHS[name]}
    </svg>
  );
}
