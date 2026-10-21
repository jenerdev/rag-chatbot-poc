'use client';

// staff-skeleton.tsx — the whole staff page as a skeleton while the session
// is checked (D-145, the user: "it should be a page loading skeleton"). The
// SAME layout classes as the signed-in shell in staff-frame.tsx (.staff-shell,
// .staff-sidebar, .staff-topbar, .staff-content), so the sidebar, the top bar
// and the page sit exactly where the real ones will, on every width: below
// 900 px the sidebar is the drawer's and hidden, the top bar shows the title,
// as the real frame does. What is already known is drawn for real: the logo,
// the business name, the page's title. Everything that waits on the session
// (which pages this member has, their role, the badge) is a Bone.
//
// ONE status for a screen reader, named "Checking your session"; the shapes
// inside are hidden and inert, so nothing in them is a link to nowhere.

import { Bone, boneRows } from './load-state';
import { PageBones } from './session-check';

/** The real sidebar's sections, by size, so the column reads as the one coming (villa: 1, 3, 3, 5). */
const GROUPS = [1, 3, 3, 5];

export function StaffShellSkeleton({ businessName, logoUrl, title }: { businessName: string; logoUrl: string | null; title: string }) {
  return (
    <div className="staff-shell staff-skeleton" role="status" aria-label="Checking your session">
      <div className="staff-skeleton-inner" aria-hidden="true" inert>
        <aside className="staff-sidebar">
          <div className="sidebar-brand">
            {logoUrl && (
              // eslint-disable-next-line @next/next/no-img-element
              <img className="brand-logo" src={logoUrl} alt="" />
            )}
            <span className="sidebar-business">{businessName}</span>
          </div>
          <nav className="sidebar-nav">
            {GROUPS.map((count, g) => (
              <div key={g} className="sidebar-group">
                <div className="sidebar-group-label">
                  <Bone w={`${52 + g * 10}px`} h="small" />
                </div>
                {boneRows(count, (i) => (
                  <span className="sidebar-link">
                    <Bone w="18px" h="18px" round="circle" />
                    <Bone w={`${56 + ((i + g) % 3) * 18}px`} h="line" />
                  </span>
                ))}
              </div>
            ))}
          </nav>
        </aside>
        <div className="staff-main">
          <div className="staff-topbar">
            <span className="ghost topbar-menu">
              <Bone w="20px" h="20px" />
            </span>
            <span className="staff-topbar-title">{businessName}</span>
            <div className="topbar-crumbs">
              <Bone w="64px" h="small" />
              <Bone w="10px" h="10px" />
              <Bone w="88px" h="line" />
            </div>
            <div className="topbar-actions">
              <Bone w="var(--control-h)" h="var(--control-h)" round="circle" />
              <Bone w="108px" h="button" round="pill" />
            </div>
          </div>
          <main className="staff-content">
            <div className="page-head">
              <h1 className="page-title">{title}</h1>
            </div>
            <PageBones />
          </main>
        </div>
      </div>
    </div>
  );
}
