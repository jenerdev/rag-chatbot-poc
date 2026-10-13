'use client';

// S-14 · Payments (plan/manage-booking.md Phase 4). Four tabs:
//
//   To verify   the proofs guests sent, oldest first.
//   All payments  the latest payments and refunds, decided or not.
//   Change requests  guests' requests to cancel or move a stay.
//   Settings    the ways to pay, the fee, the terms (owners and admins).
//
// The first three are QUEUES (D-114): a row opens its booking's page
// (S-15), where the proof is reviewed, the request decided and a refund
// recorded. Nothing is acted on here but the settings.
//
// Every member reads (payments:read); only owners and admins decide or
// change settings (payments:write, payments:settings, § 9 q4). The buttons a
// role lacks are not shown; the route and review_payment() refuse anyway.
//
// No money is added up here: every figure is stay_payment()'s or a stored
// row's. Amounts are typed as pesos and parsed by string (lib/money.ts).

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import type { ChangeRow, PaymentRow, PaymentSettings } from '@rag/bookings';
import { LoginForm, describeFailure } from '@/components/admin-login';
import { fetchRole } from '@/components/tenant-nav';
import { StaffFrame } from '@/components/staff-frame';
import { useNotice } from '@/components/toast';
import { CopyText } from '@/components/copy-button';
import { Icon } from '@/components/icons';
import { useConfirmDialog } from '@/components/dialogs';
import { ListSearch } from '@/components/list-search';
import { matches } from '@/lib/search';
import { Tabs } from '@/components/tabs';
import { EmptyState, LOADING, LoadState, failed, type Load } from '@/components/load-state';
import type { NavFeatures } from '@/lib/nav-items';
import { centavosToInput, formatMoney, parseMoneyInput } from '@/lib/money';
import { can, isRole, type Role } from '@/lib/permissions';
import { parsePercentInput, percentToInput } from '@/lib/percent';
import { STAY_PAYMENT, when } from '@/lib/stay-words';

export interface PaymentsScreenProps {
  slug: string;
  businessName: string;
  logoUrl: string | null;
  nav: NavFeatures;
  currency: string;
  timezone: string;
}

type Auth = 'checking' | 'out' | 'in';

interface SettingsDraft {
  methods: { kind: 'gcash' | 'bank' | 'other'; label: string; accountName: string; accountNumber: string; instructions: string }[];
  feeKind: 'full' | 'fixed' | 'percent';
  feeValue: string;
  payWithinHours: string;
  reviewWithinHours: string;
  terms: string;
  hold: 'none' | 'on_proof' | 'on_request';
  /** "7:100, 2:50": days before → percent */
  cancellation: string;
  rescheduleUntil: string;
}

/** "7:100, 2:50" ↔ the tiers. null for text that is not that shape. */
function parseTiers(text: string): { daysBefore: number; refundPercent: number }[] | null {
  if (text.trim() === '') return [];
  const tiers = text.split(',').map((part) => /^\s*(\d{1,3})\s*:\s*(\d{1,3})\s*$/.exec(part));
  if (tiers.some((m) => !m)) return null;
  return tiers.map((m) => ({ daysBefore: Number(m![1]), refundPercent: Number(m![2]) }));
}

const NEW_METHOD: SettingsDraft['methods'][number] = { kind: 'gcash', label: 'GCash', accountName: '', accountNumber: '', instructions: '' };

function toDraft(s: PaymentSettings | null): SettingsDraft {
  if (!s) return { methods: [{ ...NEW_METHOD }], feeKind: 'full', feeValue: '', payWithinHours: '24', reviewWithinHours: '24', terms: '', hold: 'none', cancellation: '', rescheduleUntil: '' };
  return {
    methods: s.methods.map((m) => ({ kind: m.kind, label: m.label, accountName: m.accountName ?? '', accountNumber: m.accountNumber ?? '', instructions: m.instructions ?? '' })),
    feeKind: s.fee.kind,
    feeValue: s.fee.kind === 'fixed' ? centavosToInput(s.fee.value) : s.fee.kind === 'percent' ? percentToInput(s.fee.value) : '',
    payWithinHours: s.payWithinHours === null ? '' : String(s.payWithinHours),
    reviewWithinHours: s.reviewWithinHours === null ? '' : String(s.reviewWithinHours),
    terms: s.terms ?? '',
    hold: s.hold,
    cancellation: s.cancellation.map((t) => `${t.daysBefore}:${t.refundPercent}`).join(', '),
    rescheduleUntil: s.rescheduleUntilDaysBefore === null ? '' : String(s.rescheduleUntilDaysBefore),
  };
}

export function PaymentsScreen({ slug, businessName, logoUrl, nav, currency, timezone }: PaymentsScreenProps) {
  const api = `/api/t/${slug}`;
  const [auth, setAuth] = useState<Auth>('checking');
  const [role, setRole] = useState<Role | null>(null);
  const [open, setOpen] = useState<PaymentRow[] | null>(null);
  const [all, setAll] = useState<PaymentRow[] | null>(null);
  const [changes, setChanges] = useState<ChangeRow[] | null>(null);
  const [settings, setSettings] = useState<PaymentSettings | null | undefined>(undefined);
  const [draft, setDraft] = useState<SettingsDraft>(toDraft(null));
  const [loadState, setLoadState] = useState<Load>(LOADING);
  const [busy, setBusy] = useState(false);

  const { setNotice } = useNotice(false);
  const { ask, dialog } = useConfirmDialog();
  // All payments: a search and a status filter, over the rows loaded.
  const [allQuery, setAllQuery] = useState('');
  const [allFilter, setAllFilter] = useState<'all' | 'submitted' | 'verified' | 'rejected' | 'refund'>('all');
  const canSettings = role !== null && can(role, 'payments:settings');

  const unauthorized = useCallback(() => {
    setAuth('out');
    setOpen(null);
    setAll(null);
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const body = await (await fetch(`${api}/admin/session`)).json();
        setAuth(body.admin === true ? 'in' : 'out');
        setRole(isRole(body.role) ? body.role : null);
      } catch {
        setAuth('out');
      }
    })();
  }, [api]);

  const load = useCallback(async () => {
    let response: Response | null = null;
    try {
      const [o, a, s, c] = await Promise.all([
        fetch(`${api}/payments?which=open`),
        fetch(`${api}/payments?which=all`),
        fetch(`${api}/payments/settings`),
        fetch(`${api}/payments/changes?which=all`),
      ]);
      for (const r of [o, a, s, c]) {
        response = r;
        if (r.status === 401) return unauthorized();
        if (!r.ok) throw new Error('failed');
      }
      setOpen(await o.json());
      setAll(await a.json());
      setChanges(await c.json());
      const loaded = ((await s.json()) as { settings: PaymentSettings | null }).settings;
      setSettings(loaded);
      setDraft(toDraft(loaded));
    } catch (error) {
      setOpen(null);
      setLoadState(failed(await describeFailure(error as Error, response)));
    }
  }, [api, unauthorized]);

  useEffect(() => {
    if (auth === 'in') void load();
  }, [auth, load]);

  const logout = useCallback(async () => {
    await fetch(`${api}/admin/session`, { method: 'DELETE' }).catch(() => undefined);
    unauthorized();
  }, [api, unauthorized]);

  /** One write; on success, a message and fresh lists. Returns the body, or null on failure. */
  async function write(method: string, path: string, body: object, done: string): Promise<unknown> {
    setNotice(null);
    setBusy(true);
    let response: Response | null = null;
    try {
      response = await fetch(`${api}${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (response.status === 401) {
        unauthorized();
        return null;
      }
      if (!response.ok) throw new Error('failed');
      const result = await response.json();
      setNotice({ message: done, kind: 'ok' });
      void load();
      return result;
    } catch (error) {
      setNotice({ message: await describeFailure(error as Error, response), kind: 'error' });
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function saveSettings(event: React.FormEvent) {
    event.preventDefault();
    const value = draft.feeKind === 'fixed' ? parseMoneyInput(draft.feeValue) : draft.feeKind === 'percent' ? parsePercentInput(draft.feeValue) : 0;
    if (draft.feeKind !== 'full' && (value === null || value === 0)) {
      setNotice({ message: draft.feeKind === 'fixed' ? 'The fee is pesos, like 2000.' : 'The fee is a percentage up to 100, like 30.', kind: 'error' });
      return;
    }
    const hours = (text: string) => (text.trim() === '' ? null : Number(text));
    const tiers = parseTiers(draft.cancellation);
    if (tiers === null) {
      setNotice({ message: 'Write the refund policy as days before check-in : percent, separated by commas, like 7:100, 2:50.', kind: 'error' });
      return;
    }
    await write(
      'PUT',
      '/payments/settings',
      {
        settings: {
          methods: draft.methods.map((m) => ({ ...m, accountName: m.accountName || null, accountNumber: m.accountNumber || null, instructions: m.instructions || null })),
          fee: draft.feeKind === 'full' ? { kind: 'full' } : { kind: draft.feeKind, value },
          payWithinHours: hours(draft.payWithinHours),
          reviewWithinHours: hours(draft.reviewWithinHours),
          terms: draft.terms.trim() || null,
          hold: draft.hold,
          cancellation: tiers,
          rescheduleUntilDaysBefore: draft.rescheduleUntil.trim() === '' ? null : Number(draft.rescheduleUntil),
        },
      },
      'Saved the payment settings. Bookings already made keep the amount they were given.',
    );
  }

  const frame = { slug, businessName, logoUrl, features: nav, current: 'payments' as const, title: 'Payments', session: { auth, role, onLogout: logout } };

  if (auth !== 'in') {
    return (
      <StaffFrame {...frame}>
        {auth === 'checking' ? (
          <div className="small muted">Checking your session…</div>
        ) : (
          <LoginForm
            api={api}
            slug={slug}
            onLoggedIn={() => {
              setAuth('in');
              void fetchRole(api).then(setRole);
            }}
          />
        )}
      </StaffFrame>
    );
  }

  const bookingHref = (reference: string) => `/t/${slug}/admin/bookings/${reference}`;
  /** A payment's ONE status word: what this row is now (the stay's own payment is in the line under the name). */
  const statusOf = (p: PaymentRow): { label: string; tone: string } =>
    p.kind === 'refund'
      ? { label: 'Refund recorded', tone: '' }
      : p.status === 'verified'
        ? { label: 'Verified', tone: 'ok' }
        : p.status === 'rejected'
          ? { label: 'Rejected', tone: 'danger' }
          : { label: 'To check', tone: 'warn' };
  const dateLabel = (date: string) => new Date(`${date}T00:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });

  /**
   * One payment: the amount and how it came, then who and for which stay,
   * then its status and the way to its booking (where it is reviewed,
   * D-114). The stay's own payment state is a word in the line, not a
   * third badge beside the payment's.
   */
  const row = (p: PaymentRow, showReview: boolean) => {
    const status = statusOf(p);
    return (
      <div key={p.id} className={`pay-row${showReview ? ' waiting' : ''}`}>
        <div className="pay-row-amount">
          <strong>{formatMoney(p.verifiedAmount ?? p.claimedAmount, currency)}</strong>
          <span className="small muted">
            {p.kind === 'refund' ? 'Refund' : p.method}
            {p.status === 'submitted' ? ', claimed' : ''}
          </span>
        </div>
        <div className="pay-row-who">
          <span className="pay-row-name">
            <strong>{p.guestName}</strong>
            <CopyText text={p.reference} what="reference" className="badge request-ref" />
          </span>
          <span className="small muted">
            {[p.checkIn ? `Stay ${dateLabel(p.checkIn)}` : null, `sent ${when(p.createdAt, timezone)}`, `booking ${(STAY_PAYMENT[p.payment.status] ?? p.payment.status).toLowerCase()}`]
              .filter(Boolean)
              .join(' · ')}
          </span>
          {p.status === 'rejected' && p.rejectionReason && <span className="small muted">Rejected: “{p.rejectionReason}”</span>}
        </div>
        <span className={`badge ${status.tone}`}>{status.label}</span>
        {/* Every action on a stay is on its page (D-114). */}
        <Link className={`button sm${showReview ? ' primary' : ''}`} href={bookingHref(p.reference)}>
          {showReview ? 'Review' : 'Open'} <Icon name="chevron-right" size={14} />
        </Link>
      </div>
    );
  };

  const retry = () => {
    setLoadState(LOADING);
    void load();
  };

  const toVerify = (
    <section className="card">
      <h2>Proofs to verify</h2>
      <p className="small muted">
        Open a booking to see its proof and verify or reject it there. A screenshot proves nothing by itself: check the account first.
      </p>
      {open === null ? (
        <LoadState load={loadState} what="payments" onRetry={retry} />
      ) : open.length === 0 ? (
        <EmptyState icon="check" title="Nothing to verify">
          When a guest sends a proof of payment from the Manage booking page, it waits here.
        </EmptyState>
      ) : (
        open.map((p) => row(p, true))
      )}
    </section>
  );

  // A plain filter, not a hook: this runs after the login screen's early return.
  const shownAll = (all ?? [])
    .filter((p) => (allFilter === 'all' ? true : allFilter === 'refund' ? p.kind === 'refund' : p.kind === 'payment' && p.status === allFilter))
    .filter((p) => matches(`${p.reference} ${p.guestName} ${p.method} ${p.payerReference ?? ''}`, allQuery));
  const everything = (
    <section className="card">
      <h2>All payments</h2>
      {all === null ? (
        <LoadState load={loadState} what="payments" onRetry={retry} />
      ) : all.length === 0 ? (
        <EmptyState icon="file" title="No payments yet">
          Proofs guests send and refunds you record are listed here.
        </EmptyState>
      ) : (
        <>
          <div className="pay-toolbar">
            <ListSearch value={allQuery} onChange={setAllQuery} label="Search name, reference, transaction" />
            <div className="segmented" role="group" aria-label="Show">
              {(
                [
                  ['all', 'All'],
                  ['submitted', 'To check'],
                  ['verified', 'Verified'],
                  ['rejected', 'Rejected'],
                  ['refund', 'Refunds'],
                ] as const
              ).map(([key, label]) => (
                <button key={key} type="button" aria-pressed={allFilter === key} onClick={() => setAllFilter(key)}>
                  {label}
                </button>
              ))}
            </div>
          </div>
          {shownAll.length === 0 ? (
            <EmptyState icon="search" title="No payments match" compact>
              Change the search or the filter.
            </EmptyState>
          ) : (
            shownAll.map((p) => row(p, p.status === 'submitted' && p.kind === 'payment'))
          )}
        </>
      )}
    </section>
  );

  const setMethod = (i: number, patch: Partial<SettingsDraft['methods'][number]>) =>
    setDraft({ ...draft, methods: draft.methods.map((m, j) => (j === i ? { ...m, ...patch } : m)) });

  // Unsaved changes: the form against what was loaded. The save bar shows only then (or before the first save).
  const dirty = settings !== undefined && JSON.stringify(draft) !== JSON.stringify(toDraft(settings));
  const stopTaking = async () => {
    const sure = await ask({
      title: 'Stop taking payment on the booking pages?',
      body: 'Guests will no longer see how to pay or send a proof. Bookings already made keep the amount they were given, and their proofs stay here.',
      actionLabel: 'Stop taking payment',
      backLabel: 'Keep taking payment',
      danger: true,
    });
    if (sure === null) return;
    await write('PUT', '/payments/settings', { settings: null }, 'Stopped taking payment on the Manage booking page.');
  };

  /** One settings section: what it decides on the left, its fields on the right. */
  const section = (title: string, hint: React.ReactNode, children: React.ReactNode) => (
    <div className="settings-section">
      <div className="settings-section-about">
        <h3>{title}</h3>
        <p className="small muted">{hint}</p>
      </div>
      <div className="settings-section-fields">{children}</div>
    </div>
  );

  const settingsPanel = (
    <section className="card settings-card">
      <h2>Payment settings</h2>
      <p className="small muted">
        {settings
          ? 'Guests see these on the Manage booking page. A change applies to bookings made after it; earlier bookings keep their amount.'
          : 'This business takes no payment on the Manage booking page yet. Fill these in and save to start.'}
      </p>
      {!canSettings && <p className="notice">Only an owner or admin can change these.</p>}
      <form onSubmit={saveSettings}>
        <fieldset disabled={!canSettings || busy} className="plain-fieldset">
          {section(
            'Ways to pay',
            'Shown to the guest with a Copy button beside each account number. Up to five.',
            <>
              {draft.methods.map((m, i) => (
                <div key={i} className="pay-method-edit">
                  <div className="field-row">
                    <div className="field">
                      <label htmlFor={`m-kind-${i}`}>Type</label>
                      <select id={`m-kind-${i}`} value={m.kind} onChange={(e) => setMethod(i, { kind: e.target.value as SettingsDraft['methods'][number]['kind'] })}>
                        <option value="gcash">GCash</option>
                        <option value="bank">Bank transfer</option>
                        <option value="other">Other</option>
                      </select>
                    </div>
                    <div className="field grow">
                      <label htmlFor={`m-label-${i}`}>Name guests see</label>
                      <input id={`m-label-${i}`} required maxLength={40} placeholder="GCash" value={m.label} onChange={(e) => setMethod(i, { label: e.target.value })} />
                    </div>
                  </div>
                  <div className="field-row">
                    <div className="field grow">
                      <label htmlFor={`m-name-${i}`}>Account name</label>
                      <input id={`m-name-${i}`} maxLength={100} value={m.accountName} onChange={(e) => setMethod(i, { accountName: e.target.value })} />
                    </div>
                    <div className="field grow">
                      <label htmlFor={`m-number-${i}`}>Account number</label>
                      <input id={`m-number-${i}`} maxLength={60} value={m.accountNumber} onChange={(e) => setMethod(i, { accountNumber: e.target.value })} />
                    </div>
                  </div>
                  <div className="field">
                    <label htmlFor={`m-instr-${i}`}>
                      Instructions <span className="muted">(optional)</span>
                    </label>
                    <input id={`m-instr-${i}`} maxLength={500} placeholder="Send the screenshot after paying" value={m.instructions} onChange={(e) => setMethod(i, { instructions: e.target.value })} />
                  </div>
                  {draft.methods.length > 1 && (
                    <button type="button" className="sm ghost danger" onClick={() => setDraft({ ...draft, methods: draft.methods.filter((_, j) => j !== i) })}>
                      <Icon name="trash" size={14} /> Remove {m.label || 'this way to pay'}
                    </button>
                  )}
                </div>
              ))}
              {draft.methods.length < 5 && (
                <button type="button" className="sm" onClick={() => setDraft({ ...draft, methods: [...draft.methods, { ...NEW_METHOD, label: '' }] })}>
                  <Icon name="plus" size={14} /> Add a way to pay
                </button>
              )}
            </>,
          )}

          {section(
            'What the guest pays',
            'What must be verified before you can confirm without a note, and how long the guest and you each have.',
            <>
              <div className="field-row">
                <div className="field grow">
                  <label htmlFor="fee-kind">To confirm, the guest pays</label>
                  <select id="fee-kind" value={draft.feeKind} onChange={(e) => setDraft({ ...draft, feeKind: e.target.value as SettingsDraft['feeKind'], feeValue: '' })}>
                    <option value="full">The full price</option>
                    <option value="fixed">A fixed reservation fee</option>
                    <option value="percent">A percentage of the price</option>
                  </select>
                </div>
                {draft.feeKind !== 'full' && (
                  <div className="field narrow">
                    <label htmlFor="fee-value">{draft.feeKind === 'fixed' ? `Amount (${currency})` : 'Percent'}</label>
                    <input id="fee-value" required inputMode="decimal" value={draft.feeValue} onChange={(e) => setDraft({ ...draft, feeValue: e.target.value })} />
                  </div>
                )}
              </div>
              <div className="field-row">
                <div className="field">
                  <label htmlFor="pay-hours">Hours the guest has to pay</label>
                  <input id="pay-hours" type="number" min={1} max={168} placeholder="no limit" value={draft.payWithinHours} onChange={(e) => setDraft({ ...draft, payWithinHours: e.target.value })} />
                  <p className="hint">After that, an unpaid request expires.</p>
                </div>
                <div className="field">
                  <label htmlFor="review-hours">Hours you have to review a proof</label>
                  <input id="review-hours" type="number" min={1} max={168} placeholder="no limit" value={draft.reviewWithinHours} onChange={(e) => setDraft({ ...draft, reviewWithinHours: e.target.value })} />
                  <p className="hint">Shown on the booking as "Decide by".</p>
                </div>
              </div>
            </>,
          )}

          {section(
            'Holding the dates',
            'A held date cannot be requested or confirmed by anyone else.',
            <div className="field">
              <label htmlFor="pay-hold">Hold the dates</label>
              <select id="pay-hold" value={draft.hold} onChange={(e) => setDraft({ ...draft, hold: e.target.value as SettingsDraft['hold'] })}>
                <option value="none">Never: a date is taken only when you confirm</option>
                <option value="on_proof">From the proof of payment, until you review it (recommended)</option>
                <option value="on_request">From the request, until the time to pay ends</option>
              </select>
              {draft.hold === 'on_request' && (
                <p className="hint field-warning">
                  <Icon name="alert" size={14} /> Anyone with a phone number can block dates for the hours to pay.
                </p>
              )}
            </div>,
          )}

          {section(
            'Cancelling and moving',
            'What a guest may ask for on the Manage booking page. Nothing changes until you approve it.',
            <>
              <div className="field">
                <label htmlFor="cancel-tiers">
                  Refund when cancelling <span className="muted">(days before : percent)</span>
                </label>
                <input id="cancel-tiers" placeholder="7:100, 2:50" value={draft.cancellation} onChange={(e) => setDraft({ ...draft, cancellation: e.target.value })} />
                <p className="hint">7:100, 2:50 refunds all of what was paid 7 or more days ahead, half 2 to 6 days ahead, nothing later. Empty: no refund.</p>
              </div>
              <div className="field">
                <label htmlFor="reschedule-until">Date changes allowed until (days before check-in)</label>
                <input id="reschedule-until" type="number" min={0} max={365} placeholder="not allowed" value={draft.rescheduleUntil} onChange={(e) => setDraft({ ...draft, rescheduleUntil: e.target.value })} />
              </div>
            </>,
          )}

          {section(
            'Terms',
            'Shown to the guest beside the ways to pay.',
            <div className="field">
              <label htmlFor="pay-terms">
                Terms guests read <span className="muted">(optional)</span>
              </label>
              <textarea id="pay-terms" rows={4} maxLength={4000} value={draft.terms} onChange={(e) => setDraft({ ...draft, terms: e.target.value })} />
            </div>,
          )}

          {/* In view only while something changed (or before the first save). */}
          {canSettings && (dirty || !settings) && (
            <div className="settings-savebar" role="region" aria-label="Unsaved changes">
              <span className="small">{settings ? 'You have unsaved changes.' : 'Save to start taking payment.'}</span>
              {settings && (
                <button type="button" disabled={busy} onClick={() => setDraft(toDraft(settings))}>
                  Discard
                </button>
              )}
              <button type="submit" className="primary" aria-busy={busy || undefined}>
                {busy ? 'Saving…' : 'Save settings'}
              </button>
            </div>
          )}
        </fieldset>
      </form>

      {/* Turning payments off is apart from the form, and asks first. */}
      {canSettings && settings && (
        <div className="settings-danger">
          <div>
            <strong>Stop taking payment</strong>
            <p className="small muted">Guests stop seeing how to pay. Bookings already made keep their amount.</p>
          </div>
          <button type="button" className="danger" disabled={busy} onClick={() => void stopTaking()}>
            Stop taking payment
          </button>
        </div>
      )}
    </section>
  );

  const changesPanel = (
    <section className="card">
      <h2>Change requests</h2>
      <p className="small muted">
        Guests ask to cancel or move a stay from the Manage booking page. Nothing changes until you approve it on the booking's page,
        where a refund due is recorded too.
      </p>
      {changes === null ? (
        <LoadState load={loadState} what="change requests" onRetry={retry} />
      ) : changes.length === 0 ? (
        <EmptyState icon="calendar" title="No change requests" />
      ) : (
        changes.map((c) => (
          <div key={c.id} className={`pay-row${c.status === 'pending' ? ' waiting' : ''}`}>
            <div className="pay-row-amount">
              <strong>
                {c.kind === 'cancel'
                  ? formatMoney(c.refundDue ?? 0, currency)
                  : c.quotedDifference
                    ? `${c.quotedDifference > 0 ? '+' : '−'}${formatMoney(Math.abs(c.quotedDifference), currency)}`
                    : 'Same price'}
              </strong>
              <span className="small muted">{c.kind === 'cancel' ? 'refund due' : 'price difference'}</span>
            </div>
            <div className="pay-row-who">
              <span className="pay-row-name">
                <strong>{c.guestName}</strong>
                <CopyText text={c.reference} what="reference" className="badge request-ref" />
              </span>
              <span className="small muted">
                {c.kind === 'cancel' ? `Asks to cancel the stay of ${c.checkIn ? dateLabel(c.checkIn) : '?'}` : `Asks to move ${c.checkIn ? dateLabel(c.checkIn) : '?'} to ${c.newCheckIn ? dateLabel(c.newCheckIn) : '?'}`} · asked{' '}
                {when(c.createdAt, timezone)}
              </span>
              {c.guestReason && <span className="small muted">“{c.guestReason}”</span>}
            </div>
            <span className={`badge ${c.status === 'pending' ? 'warn' : c.status === 'approved' ? 'ok' : ''}`}>
              {c.status === 'pending' ? 'Waiting' : c.status === 'approved' ? 'Approved' : c.status === 'rejected' ? 'Rejected' : 'Withdrawn'}
            </span>
            <Link className={`button sm${c.status === 'pending' ? ' primary' : ''}`} href={bookingHref(c.reference)}>
              {c.status === 'pending' ? 'Decide' : 'Open'} <Icon name="chevron-right" size={14} />
            </Link>
          </div>
        ))
      )}
    </section>
  );

  return (
    <StaffFrame {...frame}>
      {dialog}
      <Tabs
        label="Payments"
        tabs={[
          { id: 'verify', label: `To verify${open?.length ? ` (${open.length})` : ''}`, panel: toVerify },
          { id: 'all', label: 'All payments', panel: everything },
          { id: 'changes', label: `Change requests${changes?.some((c) => c.status === 'pending') ? ` (${changes.filter((c) => c.status === 'pending').length})` : ''}`, panel: changesPanel },
          { id: 'settings', label: 'Settings', panel: settingsPanel },
        ]}
      />
    </StaffFrame>
  );
}
