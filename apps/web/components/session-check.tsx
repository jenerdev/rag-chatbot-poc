'use client';

// session-check.tsx — the shapes a page body has while a screen asks whether
// the member is signed in (D-145). Before: the sentence "Checking your
// session…" in small grey text on 17 screens, which read like a problem and
// made every staff page open with a flash of words.
//
// Two exports. `PageBones` is the body alone: a toolbar, a card of rows, two
// half cards, from the same Bones the lists use (load-state.tsx), so a page
// looks like itself arriving rather than like a message. `SessionCheck` wraps
// them as ONE status named for a screen reader, for a screen with its own
// frame (the platform). A staff screen needs neither: StaffFrame draws the
// whole shell as a skeleton while the session is checked
// (staff-skeleton.tsx), and the body inside it is PageBones.

import { Bone, boneRows } from './load-state';

export function PageBones() {
  return (
    <div className="page-bones">
      <div className="page-bones-tools">
        <Bone w="220px" h="button" />
        <Bone w="110px" h="button" className="page-bones-right" />
      </div>
      <div className="card page-bones-card">
        <Bone w="28%" h="title" />
        <div className="skeleton-list">
          {boneRows(4, (i) => (
            <div className="skeleton-row">
              <Bone w="36px" h="36px" round="circle" />
              <span className="skeleton-bar" style={{ maxWidth: `${54 - i * 7}%` }} />
              <Bone w="72px" h="chip" round="pill" className="page-bones-right" />
            </div>
          ))}
        </div>
      </div>
      <div className="page-bones-pair">
        <div className="card page-bones-card">
          <Bone w="40%" h="title" />
          <Bone w="90%" h="line" />
          <Bone w="64%" h="line" />
        </div>
        <div className="card page-bones-card">
          <Bone w="40%" h="title" />
          <Bone w="80%" h="line" />
          <Bone w="52%" h="line" />
        </div>
      </div>
    </div>
  );
}

/** The body shapes as one status, for a screen that draws its own frame (the platform). */
export function SessionCheck() {
  return (
    <div className="session-check" role="status" aria-label="Checking your session">
      <div aria-hidden="true" inert>
        <PageBones />
      </div>
    </div>
  );
}
