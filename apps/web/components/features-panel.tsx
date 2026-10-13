'use client';

// The platform tenant form's Features tab (D-127): one switch per feature in
// lib/features.ts, grouped as the list groups them. A switch saves at once,
// through the form's own send(), so the tenant that comes back redraws every
// tab. What a switched-off feature means is said beside it, and so is a
// feature that needs an application the tenant does not have.

import { FEATURES, featureFlags, type FeatureKey } from '@/lib/features';

export function FeaturesPanel({
  switches,
  bookingsOn,
  busy,
  onSwitch,
}: {
  /** the tenant's rows (TenantDetail.features): key → enabled; a missing key is on */
  switches: Readonly<Record<string, boolean>>;
  bookingsOn: boolean;
  busy: boolean;
  onSwitch: (key: FeatureKey, enabled: boolean) => void;
}) {
  const flags = featureFlags(switches);
  const groups = [...new Set(FEATURES.map((f) => f.group))];
  return (
    <div className="card settings">
      {groups.map((group) => (
        <section key={group} className="settings-section" aria-labelledby={`feat-${group}`}>
          <div className="settings-about">
            <h2 id={`feat-${group}`}>{group}</h2>
            <p>
              {group === 'Guest pages'
                ? 'What guests see. Switched off, the page answers "not found" and its links go.'
                : 'What staff see. Switched off, the screen and its link go for every role.'}
            </p>
          </div>
          <ul className="feature-list">
            {FEATURES.filter((f) => f.group === group).map((f) => {
              const on = flags[f.key];
              const idle = 'needs' in f && f.needs === 'bookings' && !bookingsOn;
              return (
                <li key={f.key} className="feature-row">
                  <div className="feature-text">
                    <span className="feature-name" id={`feat-name-${f.key}`}>
                      {f.label}
                    </span>
                    <span className="small muted" id={`feat-about-${f.key}`}>
                      {f.about}
                      {idle && ' Needs the Bookings application, which is off, so it does nothing yet.'}
                    </span>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    className="switch"
                    aria-checked={on}
                    aria-labelledby={`feat-name-${f.key}`}
                    aria-describedby={`feat-about-${f.key}`}
                    disabled={busy}
                    onClick={() => onSwitch(f.key, !on)}
                  >
                    <span className="switch-track" aria-hidden="true">
                      <span className="switch-thumb" />
                    </span>
                    <span className="switch-word">{on ? 'On' : 'Off'}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}
