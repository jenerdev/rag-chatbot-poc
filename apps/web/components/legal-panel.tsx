'use client';
import { DateField } from './date-field';

// The platform tenant form's Legal tab (D-129 – D-131, plan/legal.md § 5):
// the data processing agreement's date (without it, bookings cannot be
// switched on: Postgres's tenant_applications_dpa), the privacy contact and
// the policy version the guest pages state, and how long chats and guest
// details are kept. One Save, through the ordinary tenant PATCH.

import { useState } from 'react';
import { SaveBar } from '@/components/save-bar';

export interface LegalFields {
  privacyContactName: string | null;
  privacyContactEmail: string | null;
  dpaSignedOn: string | null;
  policyVersion: string;
  chatRetentionDays: number;
  guestRetentionDays: number;
  /** D-138: days an activity row is kept */
  auditRetentionDays: number;
}

type Draft = { name: string; email: string; dpa: string; version: string; chatDays: string; guestDays: string; auditDays: string };

const draftOf = (l: LegalFields): Draft => ({
  name: l.privacyContactName ?? '',
  email: l.privacyContactEmail ?? '',
  dpa: l.dpaSignedOn ?? '',
  version: l.policyVersion,
  chatDays: String(l.chatRetentionDays),
  guestDays: String(l.guestRetentionDays),
  auditDays: String(l.auditRetentionDays),
});

/** The PATCH body: every field, empty text as null. Numbers as numbers; a bad one is the route's 400. */
const bodyOf = (d: Draft) => ({
  privacyContactName: d.name.trim() || null,
  privacyContactEmail: d.email.trim() || null,
  dpaSignedOn: d.dpa || null,
  policyVersion: d.version.trim(),
  chatRetentionDays: Number(d.chatDays),
  guestRetentionDays: Number(d.guestDays),
  auditRetentionDays: Number(d.auditDays),
});

export function LegalPanel({ legal, slug, busy, onSave }: { legal: LegalFields; slug: string; busy: boolean; onSave: (body: ReturnType<typeof bodyOf>) => void }) {
  const saved = draftOf(legal);
  const [d, setD] = useState<Draft>(saved);
  const dirty = JSON.stringify(bodyOf(d)) !== JSON.stringify(bodyOf(saved));
  const set = (k: keyof Draft) => (e: React.ChangeEvent<HTMLInputElement>) => setD({ ...d, [k]: e.target.value });

  return (
    <form
      className="card settings"
      onSubmit={(event) => {
        event.preventDefault();
        onSave(bodyOf(d));
      }}
    >
      <section className="settings-section" aria-labelledby="legal-dpa">
        <div className="settings-about">
          <h2 id="legal-dpa">Data processing agreement</h2>
          <p>
            The resort decides what happens to its guests&apos; data; the platform processes it for them. Record the date the
            agreement was signed. Without it, Bookings cannot be switched on.
          </p>
        </div>
        <div className="settings-fields">
          <div className="field narrow">
            <label htmlFor="legal-dpa-date">Signed on</label>
            <DateField id="legal-dpa-date" value={d.dpa} onChange={(dpa) => setD({ ...d, dpa })} />
            <p className="hint">{d.dpa ? 'Recorded.' : 'Not signed yet.'}</p>
          </div>
        </div>
      </section>

      <section className="settings-section" aria-labelledby="legal-contact">
        <div className="settings-about">
          <h2 id="legal-contact">Privacy contact</h2>
          <p>
            The resort&apos;s Data Protection Officer, named on its <a href={`/t/${slug}/privacy`}>privacy policy</a>. Guests write
            here to see, correct or delete what is held about them.
          </p>
        </div>
        <div className="settings-fields">
          <div className="field-row">
            <div className="field grow">
              <label htmlFor="legal-name">Name or role</label>
              <input id="legal-name" value={d.name} onChange={set('name')} maxLength={100} autoComplete="off" placeholder="Data Protection Officer" />
            </div>
            <div className="field grow">
              <label htmlFor="legal-email">Email</label>
              <input id="legal-email" type="email" value={d.email} onChange={set('email')} maxLength={254} autoComplete="off" />
            </div>
          </div>
        </div>
      </section>

      <section className="settings-section" aria-labelledby="legal-version">
        <div className="settings-about">
          <h2 id="legal-version">Policy version</h2>
          <p>Shown on the privacy policy and terms, and stored with every booking&apos;s consent. Change it when the texts change: the next booking asks again.</p>
        </div>
        <div className="settings-fields">
          <div className="field narrow">
            <label htmlFor="legal-version-input">Version</label>
            <input id="legal-version-input" value={d.version} onChange={set('version')} maxLength={20} required autoComplete="off" />
          </div>
        </div>
      </section>

      <section className="settings-section" aria-labelledby="legal-retention">
        <div className="settings-about">
          <h2 id="legal-retention">How long data is kept</h2>
          <p>After these periods the retention command deletes old chats and removes guests&apos; names and contact details from finished stays. Both are stated on the privacy policy.</p>
        </div>
        <div className="settings-fields">
          <div className="field-row">
            <div className="field">
              <label htmlFor="legal-chat-days">Chats, days after the last message</label>
              <input id="legal-chat-days" type="number" min={30} max={1825} value={d.chatDays} onChange={set('chatDays')} required />
              <p className="hint">30 to 1,825.</p>
            </div>
            <div className="field">
              <label htmlFor="legal-guest-days">Guest details, days after check-out</label>
              <input id="legal-guest-days" type="number" min={180} max={3650} value={d.guestDays} onChange={set('guestDays')} required />
              <p className="hint">180 to 3,650. Dates, amounts and references stay.</p>
            </div>
            <div className="field">
              <label htmlFor="legal-audit-days">Activity log, days</label>
              <input id="legal-audit-days" type="number" min={90} max={3650} value={d.auditDays} onChange={set('auditDays')} required />
              <p className="hint">90 to 3,650. Who did what, on the Activity screen.</p>
            </div>
          </div>
        </div>
      </section>
      <SaveBar dirty={dirty} busy={busy} onDiscard={() => setD(saved)} label="Save legal details" />
    </form>
  );
}
