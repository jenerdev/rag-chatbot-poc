'use client';

// S-14 · Payments (plan/manage-booking.md Phase 4). Three tabs:
//
//   To verify   the proofs guests sent, oldest first. Open one to see the
//               proof (a 5-minute signed link, asked for when the drawer
//               opens), then VERIFY with the amount you found in the account
//               and "I checked the account", or REJECT with the reason the
//               guest reads. "Verify and confirm" does both in one database
//               transaction when the amount is enough (plan § 1).
//   All payments  the latest payments and refunds, decided or not; a stay's
//               history and "Record a refund" open from any row.
//   Settings    the ways to pay, the fee, the terms (owners and admins).
//
// Every member reads (payments:read); only owners and admins decide or
// change settings (payments:write, payments:settings, § 9 q4). The buttons a
// role lacks are not shown; the route and review_payment() refuse anyway.
//
// No money is added up here: every figure is stay_payment()'s or a stored
// row's. Amounts are typed as pesos and parsed by string (lib/money.ts).

import { useCallback, useEffect, useState } from 'react';
import type { ChangeRow, PaymentRow, PaymentSettings, StayEvent } from '@rag/bookings';
import { LoginForm, describeFailure } from '@/components/admin-login';
import { fetchRole } from '@/components/tenant-nav';
import { StaffFrame } from '@/components/staff-frame';
import { Drawer } from '@/components/dialogs';
import { useNotice } from '@/components/toast';
import { Icon } from '@/components/icons';
import { Tabs } from '@/components/tabs';
import { EmptyState, LOADING, LoadState, failed, type Load } from '@/components/load-state';
import type { NavFeatures } from '@/lib/nav-items';
import { centavosToInput, formatMoney, parseMoneyInput } from '@/lib/money';
import { can, isRole, type Role } from '@/lib/permissions';
import { parsePercentInput, percentToInput } from '@/lib/percent';

export interface PaymentsScreenProps {
  slug: string;
  businessName: string;
  logoUrl: string | null;
  bannerUrl: string | null;
  nav: NavFeatures;
  currency: string;
  timezone: string;
}

type Auth = 'checking' | 'out' | 'in';

const STAY_PAYMENT: Record<string, string> = {
  not_tracked: 'Not tracked',
  unpaid: 'Unpaid',
  submitted: 'Proof to check',
  rejected: 'Proof rejected',
  partially_paid: 'Partly paid',
  paid: 'Paid',
  refunded: 'Refunded',
};

function when(iso: string, timezone: string): string {
  return new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: timezone });
}

/** One event of a stay's history, in words. */
function eventWords(e: StayEvent, currency: string): string {
  if (e.kind === 'created') return `Booked (${e.note === 'web' ? 'from the booking page' : 'by staff'}), ${e.to}`;
  if (e.kind === 'status') return `${e.from} → ${e.to}${e.note ? `: ${e.note}` : ''}`;
  if (e.kind === 'change') {
    const [kind, status] = (e.to ?? '').split(':');
    const what = kind === 'cancel' ? 'cancel' : `move${e.note && status === 'pending' ? ` to ${e.note}` : ''}`;
    return status === 'pending' ? `Asked to ${what}` : `Request to ${kind === 'cancel' ? 'cancel' : 'move'} ${status}${status !== 'pending' && e.note ? `: ${e.note}` : ''}`;
  }
  const amount = e.amount !== null ? ` ${formatMoney(e.amount, currency)}` : '';
  const [kind, status] = (e.to ?? '').split(':');
  if (kind === 'refund') return `Refund recorded${amount}`;
  if (status === 'submitted') return `Proof sent${amount}${e.note ? ` by ${e.note}` : ''}`;
  if (status === 'verified') return `Payment verified${amount}`;
  if (status === 'rejected') return `Proof rejected${e.note ? `: ${e.note}` : ''}`;
  return `${e.from ?? ''} → ${e.to ?? ''}`;
}

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

export function PaymentsScreen({ slug, businessName, logoUrl, bannerUrl, nav, currency, timezone }: PaymentsScreenProps) {
  const api = `/api/t/${slug}`;
  const [auth, setAuth] = useState<Auth>('checking');
  const [role, setRole] = useState<Role | null>(null);
  const [open, setOpen] = useState<PaymentRow[] | null>(null);
  const [all, setAll] = useState<PaymentRow[] | null>(null);
  const [changes, setChanges] = useState<ChangeRow[] | null>(null);
  const [changeNote, setChangeNote] = useState<Record<number, string>>({});
  const [settings, setSettings] = useState<PaymentSettings | null | undefined>(undefined);
  const [draft, setDraft] = useState<SettingsDraft>(toDraft(null));
  const [loadState, setLoadState] = useState<Load>(LOADING);
  const [busy, setBusy] = useState(false);

  // The review drawer: one payment, its proof's signed link, the form.
  const [selected, setSelected] = useState<PaymentRow | null>(null);
  const [proof, setProof] = useState<string | null>(null);
  const [amount, setAmount] = useState('');
  const [checked, setChecked] = useState(false);
  const [note, setNote] = useState('');
  // The history drawer, and the refund form inside it.
  const [historyOf, setHistoryOf] = useState<PaymentRow | null>(null);
  const [history, setHistory] = useState<StayEvent[] | null>(null);
  const [refund, setRefund] = useState({ amount: '', method: '', note: '' });

  const drawerOpen = selected !== null || historyOf !== null;
  const { notice, setNotice } = useNotice(drawerOpen);
  const canWrite = role !== null && can(role, 'payments:write');
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

  async function openReview(p: PaymentRow) {
    setSelected(p);
    setProof(null);
    setAmount(centavosToInput(p.claimedAmount));
    setChecked(false);
    setNote('');
    setNotice(null);
    if (p.hasProof) {
      const r = await fetch(`${api}/payments/${p.id}/proof`).catch(() => null);
      if (r?.ok) setProof(((await r.json()) as { url: string }).url);
    }
  }

  async function review(action: 'verify' | 'reject', confirm = false) {
    if (!selected) return;
    const done =
      action === 'reject'
        ? `Rejected ${selected.reference}'s proof. The guest sees your reason.`
        : confirm
          ? `Verified and confirmed ${selected.reference}.`
          : `Verified ${selected.reference}'s payment.`;
    const result = await write('PATCH', `/payments/${selected.id}`, { action, amount, accountChecked: checked, note: note.trim() || null, confirm }, done);
    if (result) setSelected(null);
  }

  async function openHistory(p: PaymentRow) {
    setHistoryOf(p);
    setHistory(null);
    setRefund({ amount: '', method: '', note: '' });
    setNotice(null);
    const r = await fetch(`${api}/stays/${p.groupId}/history`).catch(() => null);
    setHistory(r?.ok ? await r.json() : []);
  }

  async function saveRefund(event: React.FormEvent) {
    event.preventDefault();
    if (!historyOf) return;
    const result = await write('POST', '/payments/refund', { groupId: historyOf.groupId, ...refund }, `Recorded a refund on ${historyOf.reference}.`);
    if (result) setHistoryOf(null);
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

  const frame = { slug, businessName, logoUrl, bannerUrl, features: nav, current: 'payments' as const, title: 'Payments', session: { auth, role, onLogout: logout } };

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

  const row = (p: PaymentRow, showReview: boolean) => (
    <div key={p.id} className="list-row">
      <span className="list-row-lead">{when(p.createdAt, timezone)}</span>
      <span className="list-row-main">
        <span className="list-row-title">
          {p.reference} · {p.guestName}
        </span>
        <span className="badge">{p.kind === 'refund' ? 'Refund' : p.method}</span>
        <span className={`badge ${p.status === 'verified' ? 'ok' : p.status === 'rejected' ? 'danger' : 'warn'}`}>
          {p.kind === 'refund' ? 'Recorded' : p.status === 'verified' ? 'Verified' : p.status === 'rejected' ? 'Rejected' : 'To verify'}
        </span>
        <span className="badge">{STAY_PAYMENT[p.payment.status] ?? p.payment.status}</span>
      </span>
      <span className="list-row-meta">
        {formatMoney(p.verifiedAmount ?? p.claimedAmount, currency)}
        {p.status === 'submitted' ? ' claimed' : ''}
      </span>
      <span className="list-row-actions">
        {showReview && (
          <button type="button" className="sm primary" onClick={() => void openReview(p)}>
            Review
          </button>
        )}
        <button type="button" className="sm" onClick={() => void openHistory(p)}>
          History
        </button>
      </span>
    </div>
  );

  const retry = () => {
    setLoadState(LOADING);
    void load();
  };

  const toVerify = (
    <section className="card">
      <h2>Proofs to verify</h2>
      <p className="small muted">
        A screenshot proves nothing by itself. Check that the money is in the account, then type the amount you found.
        {!canWrite && ' Only an owner or admin can verify or reject a proof.'}
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

  const everything = (
    <section className="card">
      <h2>All payments</h2>
      {all === null ? (
        <LoadState load={loadState} what="payments" onRetry={retry} />
      ) : all.length === 0 ? (
        <EmptyState icon="file" title="No payments yet" />
      ) : (
        all.map((p) => row(p, p.status === 'submitted' && p.kind === 'payment'))
      )}
    </section>
  );

  const setMethod = (i: number, patch: Partial<SettingsDraft['methods'][number]>) =>
    setDraft({ ...draft, methods: draft.methods.map((m, j) => (j === i ? { ...m, ...patch } : m)) });

  const settingsPanel = (
    <section className="card">
      <h2>Payment settings</h2>
      <p className="small muted">
        {settings
          ? 'Guests see these on the Manage booking page. A change applies to bookings made after it; earlier bookings keep their amount.'
          : 'This business takes no payment on the Manage booking page yet. Save these to start.'}
      </p>
      <form onSubmit={saveSettings}>
        <fieldset disabled={!canSettings || busy} className="plain-fieldset">
          <h3>Ways to pay</h3>
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
                  <label htmlFor={`m-label-${i}`}>Label</label>
                  <input id={`m-label-${i}`} required maxLength={40} value={m.label} onChange={(e) => setMethod(i, { label: e.target.value })} />
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
                <input id={`m-instr-${i}`} maxLength={500} value={m.instructions} onChange={(e) => setMethod(i, { instructions: e.target.value })} />
              </div>
              {draft.methods.length > 1 && (
                <button type="button" className="sm" onClick={() => setDraft({ ...draft, methods: draft.methods.filter((_, j) => j !== i) })}>
                  Remove {m.label || 'this way to pay'}
                </button>
              )}
            </div>
          ))}
          {draft.methods.length < 5 && (
            <button type="button" className="sm" onClick={() => setDraft({ ...draft, methods: [...draft.methods, { ...NEW_METHOD, label: '' }] })}>
              <Icon name="plus" size={14} /> Add a way to pay
            </button>
          )}

          <h3>Needed to confirm</h3>
          <div className="field-row">
            <div className="field">
              <label htmlFor="fee-kind">The guest pays</label>
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
            <div className="field narrow">
              <label htmlFor="pay-hours">Hours to pay</label>
              <input id="pay-hours" type="number" min={1} max={168} value={draft.payWithinHours} onChange={(e) => setDraft({ ...draft, payWithinHours: e.target.value })} />
            </div>
            <div className="field narrow">
              <label htmlFor="review-hours">Hours to review</label>
              <input id="review-hours" type="number" min={1} max={168} value={draft.reviewWithinHours} onChange={(e) => setDraft({ ...draft, reviewWithinHours: e.target.value })} />
            </div>
          </div>
          <div className="field">
            <label htmlFor="pay-hold">Hold the dates</label>
            <select id="pay-hold" value={draft.hold} onChange={(e) => setDraft({ ...draft, hold: e.target.value as SettingsDraft['hold'] })}>
              <option value="none">Never: a date is taken only when you confirm</option>
              <option value="on_proof">From the proof of payment, until you review it</option>
              <option value="on_request">From the request, until the time to pay ends</option>
            </select>
            <span className="small muted">
              A held date cannot be requested or confirmed by anyone else. Holding from the request lets anyone with a phone number block dates
              for the hours to pay; holding from the proof is the recommended setting.
            </span>
          </div>
          <h3>Changes guests may ask for</h3>
          <div className="field-row">
            <div className="field grow">
              <label htmlFor="cancel-tiers">
                Refund when cancelling <span className="muted">(days before : percent)</span>
              </label>
              <input id="cancel-tiers" placeholder="7:100, 2:50" value={draft.cancellation} onChange={(e) => setDraft({ ...draft, cancellation: e.target.value })} />
              <span className="small muted">7:100, 2:50 refunds all of what was paid 7 or more days ahead, half 2 to 6 days ahead, nothing later. Empty: no refund.</span>
            </div>
            <div className="field narrow">
              <label htmlFor="reschedule-until">Date changes until (days before)</label>
              <input id="reschedule-until" type="number" min={0} max={365} placeholder="none" value={draft.rescheduleUntil} onChange={(e) => setDraft({ ...draft, rescheduleUntil: e.target.value })} />
            </div>
          </div>
          <div className="field">
            <label htmlFor="pay-terms">
              Terms guests read <span className="muted">(optional)</span>
            </label>
            <textarea id="pay-terms" rows={3} maxLength={4000} value={draft.terms} onChange={(e) => setDraft({ ...draft, terms: e.target.value })} />
          </div>
          {canSettings && (
            <div className="form-footer">
              {settings && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void write('PUT', '/payments/settings', { settings: null }, 'Stopped taking payment on the Manage booking page.')}
                >
                  Stop taking payment
                </button>
              )}
              <button type="submit" className="primary" aria-busy={busy || undefined}>
                {busy ? 'Saving…' : 'Save settings'}
              </button>
            </div>
          )}
        </fieldset>
      </form>
      {!canSettings && <p className="small muted">Only an owner or admin can change these.</p>}
    </section>
  );

  const enoughIfVerified = selected && selected.payment.required !== null;

  const changesPanel = (
    <section className="card">
      <h2>Change requests</h2>
      <p className="small muted">
        Guests ask to cancel or move a stay from the Manage booking page. Nothing changes until you approve. A refund due is yours to pay
        and then record (History, Record a refund).{!canWrite && ' Only an owner or admin can decide.'}
      </p>
      {changes === null ? (
        <LoadState load={loadState} what="change requests" onRetry={retry} />
      ) : changes.length === 0 ? (
        <EmptyState icon="calendar" title="No change requests" />
      ) : (
        changes.map((c) => (
          <div key={c.id} className="list-row">
            <span className="list-row-lead">{when(c.createdAt, timezone)}</span>
            <span className="list-row-main">
              <span className="list-row-title">
                {c.reference} · {c.guestName}
              </span>
              <span className={c.kind === 'cancel' ? 'badge danger' : 'badge accent'}>
                {c.kind === 'cancel' ? 'Cancel' : `Move ${c.checkIn ?? ''} → ${c.newCheckIn ?? ''}`}
              </span>
              <span className={`badge ${c.status === 'pending' ? 'warn' : c.status === 'approved' ? 'ok' : ''}`}>{c.status}</span>
              {c.guestReason && <span className="small muted">“{c.guestReason}”</span>}
            </span>
            <span className="list-row-meta">
              {c.kind === 'cancel'
                ? `refund due ${formatMoney(c.refundDue ?? 0, currency)}`
                : c.quotedDifference
                  ? `${c.quotedDifference > 0 ? '+' : '−'}${formatMoney(Math.abs(c.quotedDifference), currency)}`
                  : 'same price'}
            </span>
            {c.status === 'pending' && canWrite && (
              <span className="list-row-actions">
                <input
                  aria-label={`Note for ${c.reference}`}
                  placeholder="Note (required to reject)"
                  maxLength={500}
                  value={changeNote[c.id] ?? ''}
                  onChange={(e) => setChangeNote({ ...changeNote, [c.id]: e.target.value })}
                />
                <button
                  type="button"
                  className="sm danger"
                  disabled={busy || !(changeNote[c.id] ?? '').trim()}
                  onClick={() => void write('PATCH', `/payments/changes/${c.id}`, { action: 'reject', note: changeNote[c.id] }, `Rejected ${c.reference}'s request. The guest sees your note.`)}
                >
                  Reject
                </button>
                <button
                  type="button"
                  className="sm primary"
                  disabled={busy}
                  onClick={() =>
                    void write(
                      'PATCH',
                      `/payments/changes/${c.id}`,
                      { action: 'approve', note: (changeNote[c.id] ?? '').trim() || null },
                      c.kind === 'cancel' ? `Cancelled ${c.reference}. Record the refund once you have paid it.` : `Moved ${c.reference} to ${c.newCheckIn}.`,
                    )
                  }
                >
                  Approve
                </button>
              </span>
            )}
          </div>
        ))
      )}
    </section>
  );

  return (
    <StaffFrame {...frame}>
      <Drawer open={selected !== null} title={selected ? `Proof for ${selected.reference}` : 'Proof'} onClose={() => setSelected(null)}>
        {selected && (
          <>
            <div className="stay-lines">
              <div className="quote-line">
                <span>Guest</span>
                <span>{selected.guestName}</span>
              </div>
              <div className="quote-line">
                <span>Claimed</span>
                <span>
                  {formatMoney(selected.claimedAmount, currency)} by {selected.method} on {selected.paidOn}
                </span>
              </div>
              {selected.payerReference && (
                <div className="quote-line">
                  <span>Transaction</span>
                  <span>{selected.payerReference}</span>
                </div>
              )}
              {enoughIfVerified && (
                <div className="quote-line">
                  <span>Needed to confirm</span>
                  <span>
                    {formatMoney(selected.payment.required!, currency)} (received so far {formatMoney(selected.payment.received, currency)})
                  </span>
                </div>
              )}
            </div>
            <p>
              {selected.hasProof ? (
                proof ? (
                  <a className="button" href={proof} target="_blank" rel="noopener noreferrer">
                    <Icon name="file" size={16} /> Open the proof (link lasts 5 minutes)
                  </a>
                ) : (
                  <span className="small muted">Getting the proof…</span>
                )
              ) : (
                <span className="small muted">No file.</span>
              )}
            </p>
            {canWrite ? (
              <form onSubmit={(e) => e.preventDefault()}>
                <div className="field-row">
                  <div className="field narrow">
                    <label htmlFor="verified-amount">Amount found ({currency})</label>
                    <input id="verified-amount" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
                  </div>
                  <div className="field grow">
                    <label htmlFor="review-note">
                      Note <span className="muted">(required to reject; the guest reads it)</span>
                    </label>
                    <input id="review-note" maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
                  </div>
                </div>
                <label className="check-line">
                  <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} /> I checked the account and the money is there
                </label>
                <div className="form-footer">
                  <button type="button" className="danger" disabled={busy || !note.trim()} onClick={() => void review('reject')}>
                    Reject
                  </button>
                  <span className="form-actions">
                    <button type="button" disabled={busy || !checked} onClick={() => void review('verify')}>
                      Verify
                    </button>
                    {selected.stayStatus === 'pending' && (
                      <button type="button" className="primary" disabled={busy || !checked} onClick={() => void review('verify', true)}>
                        Verify and confirm
                      </button>
                    )}
                  </span>
                </div>
                {notice?.kind === 'error' && (
                  <div className="notice error drawer-notice" role="alert">
                    {notice.message}
                  </div>
                )}
              </form>
            ) : (
              <p className="small muted">Only an owner or admin can verify or reject a proof.</p>
            )}
          </>
        )}
      </Drawer>

      <Drawer open={historyOf !== null} title={historyOf ? `History of ${historyOf.reference}` : 'History'} onClose={() => setHistoryOf(null)}>
        {historyOf && (
          <>
            {history === null ? (
              <div className="small muted">Loading…</div>
            ) : history.length === 0 ? (
              <p className="small muted">No events recorded. The log starts with manage booking; older bookings have no history.</p>
            ) : (
              <ol className="stay-history">
                {history.map((e, i) => (
                  <li key={i}>
                    <span className="small muted">{when(e.at, timezone)}</span> <span className="badge">{e.actor}</span> {eventWords(e, currency)}
                  </li>
                ))}
              </ol>
            )}
            {canWrite && historyOf.payment.received > 0 && (
              <form onSubmit={saveRefund}>
                <h3>Record a refund</h3>
                <p className="small muted">For money you already returned. Nothing is sent from here. At most {formatMoney(historyOf.payment.received, currency)}.</p>
                <div className="field-row">
                  <div className="field narrow">
                    <label htmlFor="refund-amount">Amount ({currency})</label>
                    <input id="refund-amount" required inputMode="decimal" value={refund.amount} onChange={(e) => setRefund({ ...refund, amount: e.target.value })} />
                  </div>
                  <div className="field grow">
                    <label htmlFor="refund-method">Returned by</label>
                    <input id="refund-method" required maxLength={40} placeholder="GCash" value={refund.method} onChange={(e) => setRefund({ ...refund, method: e.target.value })} />
                  </div>
                </div>
                <div className="field">
                  <label htmlFor="refund-note">Note</label>
                  <input id="refund-note" required maxLength={500} value={refund.note} onChange={(e) => setRefund({ ...refund, note: e.target.value })} />
                </div>
                <div className="form-footer">
                  <button type="submit" disabled={busy}>
                    Record refund
                  </button>
                </div>
                {notice?.kind === 'error' && (
                  <div className="notice error drawer-notice" role="alert">
                    {notice.message}
                  </div>
                )}
              </form>
            )}
          </>
        )}
      </Drawer>

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
