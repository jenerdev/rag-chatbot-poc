// build-tag.tsx — "Build cd1c21a · 2026-10-26", the ONE way the version is
// shown (D-148): in the public footers, under the staff sidebar, on the
// platform's top bar and on the landing page's footer. Visible text, never
// a title alone (D-102), so a phone can read it and a person can quote it.

import { APP_VERSION } from '@/lib/version';

export function BuildTag() {
  return <span className="build-tag">Build {APP_VERSION}</span>;
}
