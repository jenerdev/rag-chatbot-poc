'use client';
import { DateField } from './date-field';

// S-10 · Promos (plan/promos.md, D-097). A discount the tenant defines: a
// name, fixed or percent, a value, the STAY dates it covers, an optional code
// the customer must type (none = automatic, applied by itself), an optional
// usage limit. Owners and admins manage them here; every rule is also
// Postgres's (schema-promos.sql), so this screen only says it first:
//
//   * the discount is computed by the database when a booking is quoted or
//     made, never here (plan Rule 1). This screen never shows a price.
//   * a promo that was ever used is RETIRED, not deleted: the bookings that
//     used it keep its name and their stored discount (Rule 4). A promo
//     never used can be deleted.
//   * editing a value, a range or a limit changes FUTURE quotes only.
//
// The value is typed as pesos ("500") or a percentage ("12.5") and sent as
// an INTEGER: centavos, or hundredths of a percent (1250). Parsed by string,
// never × 100 (plan § 2.1).
//
// The look (plan/ui-refresh.md Phase 9, refined 2026-10-12): "Add a promo"
// and Edit open the form in a drawer where the discount's kind and how a
// guest gets it (automatic or with a code) are choices of two cards each,
// a sentence reads the promo back, and the footer says what is missing.
// Each row says its dates in words, whether it is running, starts later or
// has ended (the tenant's today), and its uses; Retire and Delete ask.

import { useCallback, useEffect, useState } from 'react';
import type { Promo } from '@rag/bookings';
import { LoginForm, describeFailure } from '@/components/admin-login';
import { fetchRole } from '@/components/tenant-nav';
import { StaffFrame } from '@/components/staff-frame';
import type { NavFeatures } from '@/lib/nav-items';
import { centavosToInput, formatMoney, parseMoneyInput } from '@/lib/money';
import { isRole, type Role } from '@/lib/permissions';
import { parsePercentInput, percentToInput } from '@/lib/percent';
import { Drawer, useConfirmDialog } from '@/components/dialogs';
import { useNotice } from '@/components/toast';
import { Icon } from '@/components/icons';
import { CopyText } from '@/components/copy-button';
import { Tip } from '@/components/tooltip';
import { Bone, EmptyState, LOADING, LoadState, failed, type Load } from '@/components/load-state';

export interface PromosScreenProps {
  slug: string;
  businessName: string;
  logoUrl: string | null;
  /** What the tenant has, for the header's links (lib/nav.ts). */
  nav: NavFeatures;
  /** The tenant's currency, for the fixed amounts in the list. */
  currency: string;
}

type Auth = 'checking' | 'out' | 'in';

interface Draft {
  id: number | null;
  name: string;
  kind: 'fixed' | 'percent';
  /** pesos or a percentage, as typed */
  value: string;
  validFrom: string;
  validTo: string;
  code: string;
  maxUses: string;
}

const EMPTY: Draft = { id: null, name: '', kind: 'percent', value: '', validFrom: '', validTo: '', code: '', maxUses: '' };

/** "12.5 %" or "₱500.00", for the list. */
function valueLabel(p: Promo, currency: string): string {
  return p.kind === 'percent' ? `${percentToInput(p.value)} %` : formatMoney(p.value, currency);
}

/**
 * The promos while they load: `.list-row.setup-row` rows as `row` draws them,
 * the amount off and its dates, the name with its status and code badges,
 * the uses, and the Edit and Retire/Delete buttons as shapes. Mapped
 * directly, not through boneRows(): its wrapper would make every row
 * `:first-of-type` and take away the lines between them.
 */
function PromosSkeleton() {
  const names = ['32%', '24%', '40%'];
  return (
    <>
      {names.map((w, i) => (
        <div key={i} className="list-row setup-row">
          <span className="setup-row-when">
            <Bone w={i === 1 ? '9ch' : '11ch'} />
            <Bone w="15ch" h="small" />
          </span>
          <span className="list-row-main">
            <Bone w={w} />
            <Bone w="7ch" h="chip" />
            <Bone w={i === 2 ? '10ch' : '9ch'} h="chip" />
          </span>
          <span className="list-row-meta">
            <Bone w={i === 0 ? '10ch' : '6ch'} h="small" />
          </span>
          <span className="list-row-actions">
            <Bone w="32px" h="var(--control-h-sm)" />
            <Bone w={i === 0 ? '60px' : '32px'} h="var(--control-h-sm)" />
          </span>
        </div>
      ))}
    </>
  );
}

export function PromosScreen({ slug, businessName, logoUrl, nav, currency }: PromosScreenProps) {
  const api = `/api/t/${slug}`;
  const [auth, setAuth] = useState<Auth>('checking');
  const [role, setRole] = useState<Role | null>(null);
  const [promos, setPromos] = useState<Promo[] | null>(null);
  const [loadState, setLoadState] = useState<Load>(LOADING);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [formOpen, setFormOpen] = useState(false);
  const { notice, setNotice } = useNotice(formOpen);
  const { ask, dialog } = useConfirmDialog();
  const [showRetired, setShowRetired] = useState(false);
  // How a guest gets the promo: by itself, or by typing a code. A choice of
  // its own (the code field shows only for it), saved as the code or none.
  const [withCode, setWithCode] = useState(false);
  // The TENANT's today (trap 9), for whether a promo is running.
  const [today, setToday] = useState<string | null>(null);

  const unauthorized = useCallback(() => {
    setAuth('out');
    setPromos(null);
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const response = await fetch(`${api}/admin/session`);
        const body = await response.json();
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
      response = await fetch(`${api}/promos?all=1`);
      if (response.status === 401) return unauthorized();
      if (!response.ok) throw new Error('failed');
      setPromos(await response.json());
    } catch (error) {
      setPromos(null);
      setLoadState(failed(await describeFailure(error as Error, response)));
    }
  }, [api, unauthorized]);

  useEffect(() => {
    if (auth === 'in') void load();
  }, [auth, load]);

  useEffect(() => {
    if (auth !== 'in') return;
    void fetch(`${api}/bookings/setup`)
      .then((r) => (r.ok ? r.json() : null))
      .then((body: { today?: string } | null) => setToday(body?.today ?? null))
      .catch(() => setToday(null));
  }, [api, auth]);

  const logout = useCallback(async () => {
    await fetch(`${api}/admin/session`, { method: 'DELETE' }).catch(() => undefined);
    unauthorized();
  }, [api, unauthorized]);

  /** One write; on success, a message and a fresh list. */
  async function write(method: string, path: string, body: object | undefined, done: string): Promise<boolean> {
    setNotice(null);
    setBusy(true);
    let response: Response | null = null;
    try {
      response = await fetch(`${api}${path}`, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      if (response.status === 401) {
        unauthorized();
        return false;
      }
      if (!response.ok) throw new Error('failed');
      setNotice({ message: done, kind: 'ok' });
      void load();
      return true;
    } catch (error) {
      setNotice({ message: await describeFailure(error as Error, response), kind: 'error' });
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    const value = draft.kind === 'fixed' ? parseMoneyInput(draft.value) : parsePercentInput(draft.value);
    if (value === null || value === 0) {
      setNotice({
        message: draft.kind === 'fixed' ? 'The amount is pesos, like 500 or 1500.50.' : 'The percentage is between 0 and 100, with at most two decimals, like 12.5.',
        kind: 'error',
      });
      return;
    }
    const maxUses = draft.maxUses.trim() === '' ? null : Number(draft.maxUses);
    if (maxUses !== null && (!Number.isInteger(maxUses) || maxUses <= 0)) {
      setNotice({ message: 'The usage limit is a whole number above zero, or empty for no limit.', kind: 'error' });
      return;
    }
    const fields = {
      name: draft.name.trim(),
      kind: draft.kind,
      value,
      validFrom: draft.validFrom,
      validTo: draft.validTo,
      code: withCode && draft.code.trim() !== '' ? draft.code.trim() : null,
      maxUses,
    };
    const ok =
      draft.id === null
        ? await write('POST', '/promos', fields, `Added "${fields.name}".${fields.code ? ` Customers type ${fields.code} on the booking page.` : ' It applies by itself to every stay in its dates.'}`)
        : await write('PATCH', `/promos/${draft.id}`, fields, `Saved "${fields.name}". Bookings already made keep their discount.`);
    if (ok) {
      setDraft(EMPTY);
      setFormOpen(false);
    }
  }

  // Closing abandons an edit; a new promo's draft is kept for next time.
  function closeForm() {
    setFormOpen(false);
    if (draft.id !== null) setDraft(EMPTY);
  }

  function edit(p: Promo) {
    setDraft({
      id: p.id,
      name: p.name,
      kind: p.kind,
      value: p.kind === 'fixed' ? centavosToInput(p.value) : percentToInput(p.value),
      validFrom: p.validFrom,
      validTo: p.validTo,
      code: p.code ?? '',
      maxUses: p.maxUses === null ? '' : String(p.maxUses),
    });
    setWithCode(p.code !== null);
    setNotice(null);
    setFormOpen(true);
  }

  const editing = draft.id === null ? null : (promos?.find((p) => p.id === draft.id) ?? null);

  const frame = { slug, businessName, logoUrl, features: nav, current: 'promos' as const, title: 'Promos', session: { auth, role, onLogout: logout } };

  if (auth !== 'in') {
    return (
      <>
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
      </>
    );
  }

  const active = promos?.filter((p) => p.active) ?? [];
  const retired = promos?.filter((p) => !p.active) ?? [];
  // Two automatic promos whose dates overlap: the larger discount wins on a
  // stay, which is a surprise worth naming (plan § 2.5).
  const overlapping = active.filter((p) => p.code === null && active.some((q) => q.id !== p.id && q.code === null && q.validFrom <= p.validTo && p.validFrom <= q.validTo));

  const short = (d: string, year = false) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', ...(year ? { year: 'numeric' } : {}), timeZone: 'UTC' });
  /** "4 Oct – 4 Dec 2026", the year once when both dates share it. */
  const rangeLabel = (from: string, to: string) => (from.slice(0, 4) === to.slice(0, 4) ? `${short(from)} – ${short(to, true)}` : `${short(from, true)} – ${short(to, true)}`);
  const statusOf = (p: Promo): { label: string; tone: string } | null =>
    !p.active || !today ? null : today > p.validTo ? { label: 'Ended', tone: '' } : today < p.validFrom ? { label: 'Starts later', tone: 'accent' } : { label: 'Running', tone: 'ok' };

  // The form read back, and what it still needs.
  const parsedValue = draft.value.trim() === '' ? null : draft.kind === 'fixed' ? parseMoneyInput(draft.value) : parsePercentInput(draft.value);
  const formMissing =
    draft.name.trim() === ''
      ? 'Give it a name'
      : !parsedValue
        ? draft.kind === 'fixed'
          ? 'Enter the amount off'
          : 'Enter the percentage off'
        : draft.validFrom === '' || draft.validTo === ''
          ? 'Choose the dates'
          : draft.validTo < draft.validFrom
            ? 'The end date is before the start'
            : withCode && draft.code.trim() === ''
              ? 'Type the code guests will enter'
              : null;
  const summary =
    parsedValue && draft.validFrom && draft.validTo && draft.validTo >= draft.validFrom
      ? `${draft.kind === 'fixed' ? `${formatMoney(parsedValue, currency)} off` : `${percentToInput(parsedValue)} % off`} stays from ${draft.validFrom.slice(0, 4) === draft.validTo.slice(0, 4) ? short(draft.validFrom) : short(draft.validFrom, true)} to ${short(draft.validTo, true)}, ${
          withCode ? (draft.code.trim() ? `for guests who type ${draft.code.trim().toUpperCase()}` : 'for guests who type the code') : 'applied by itself'
        }${draft.maxUses.trim() ? `, for up to ${draft.maxUses.trim()} booking${draft.maxUses.trim() === '1' ? '' : 's'}` : ''}.`
      : null;

  const row = (p: Promo) => (
    <div key={p.id} className="list-row setup-row">
      <span className="setup-row-when">
        <strong>{valueLabel(p, currency)} off</strong>
        <span className="small muted">{rangeLabel(p.validFrom, p.validTo)}</span>
      </span>
      <span className="list-row-main">
        <span className="list-row-title">{p.name}</span>
        {statusOf(p) && <span className={`badge ${statusOf(p)!.tone}`}>{statusOf(p)!.label}</span>}
        {p.code ? <CopyText text={p.code} what="promo code" className="badge accent request-ref" /> : <span className="badge">Automatic</span>}
        {!p.active && <span className="badge">Retired</span>}
        {overlapping.includes(p) && (
          <span className="badge warn">
            <Icon name="alert" size={12} /> Overlaps another automatic promo
          </span>
        )}
      </span>
      <span className="list-row-meta">
        {p.maxUses !== null ? `${p.uses} of ${p.maxUses} used` : `${p.uses} use${p.uses === 1 ? '' : 's'}`}
      </span>
      <span className="list-row-actions">
        {p.active && (
          <Tip label="Edit">
            <button type="button" className="ghost sm" aria-label={`Edit ${p.name}`} disabled={busy} onClick={() => edit(p)}>
              <Icon name="edit" size={16} />
            </button>
          </Tip>
        )}
        {p.active && p.uses > 0 && (
          <button
            type="button"
            className="sm"
            disabled={busy}
            onClick={async () => {
              const sure = await ask({
                title: `Retire "${p.name}"?`,
                body: `No new booking can use it. The ${p.uses} that did keep their discount.`,
                actionLabel: 'Retire',
                backLabel: 'Keep offering it',
              });
              if (sure !== null) void write('PATCH', `/promos/${p.id}`, { active: false }, `Retired "${p.name}".`);
            }}
          >
            Retire
          </button>
        )}
        {p.active && p.uses === 0 && (
          <Tip label="Delete">
            <button
              type="button"
              className="ghost sm danger"
              aria-label={`Delete ${p.name}`}
              disabled={busy}
              onClick={async () => {
                const sure = await ask({ title: `Delete "${p.name}"?`, body: 'It was never used. This cannot be undone.', actionLabel: 'Delete', backLabel: 'Keep it', danger: true });
                if (sure !== null) void write('DELETE', `/promos/${p.id}`, undefined, `Deleted "${p.name}".`);
              }}
            >
              <Icon name="trash" size={16} />
            </button>
          </Tip>
        )}
        {!p.active && (
          <button type="button" className="sm" disabled={busy} onClick={() => void write('PATCH', `/promos/${p.id}`, { active: true }, `"${p.name}" is offered again.`)}>
            Offer again
          </button>
        )}
      </span>
    </div>
  );

  const addPromo = (
    <button
      type="button"
      className="primary"
      onClick={() => {
        if (draft.id !== null) {
          setDraft(EMPTY);
          setWithCode(false);
        }
        setNotice(null);
        setFormOpen(true);
      }}
    >
      <Icon name="plus" size={16} /> Add a promo
    </button>
  );

  return (
    <>
      <StaffFrame {...frame} actions={addPromo}>
        {dialog}

        <Drawer open={formOpen} title={draft.id === null ? 'Add a promo' : `Edit "${editing?.name ?? draft.name}"`} onClose={closeForm}>
          <form onSubmit={save} className="setup-form">
            <p className="small muted setup-intro">A discount on the stays in its dates. Bookings already made keep their discount.</p>
            <div className="field">
              <label htmlFor="promo-name">Name</label>
              <input id="promo-name" required maxLength={80} autoComplete="off" placeholder="Off season discount" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
              <p className="hint">Guests see it on the booking page's price; staff see it on each booking.</p>
            </div>

            <fieldset className="setup-choice-set">
              <legend className="field-label">The discount</legend>
              <div className="setup-choices cols-2">
                {(
                  [
                    ['percent', 'A percentage off', 'Of each night, e.g. 10 %.'],
                    ['fixed', 'A fixed amount off', 'Once per booking, e.g. ₱500.'],
                  ] as const
                ).map(([key, title, text]) => (
                  <label key={key} className={`review-option${draft.kind === key ? ' picked' : ''}`}>
                    <input type="radio" name="promo-kind" checked={draft.kind === key} onChange={() => setDraft({ ...draft, kind: key, value: '' })} />
                    <span>
                      <strong>{title}</strong>
                      <span className="small muted">{text}</span>
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>
            <div className="field">
              <label htmlFor="promo-value">{draft.kind === 'fixed' ? 'Amount off' : 'Percentage off'}</label>
              <div className="input-prefix">
                <span aria-hidden="true">{draft.kind === 'fixed' ? (currency === 'PHP' ? '₱' : currency) : '%'}</span>
                <input id="promo-value" required inputMode="decimal" placeholder={draft.kind === 'fixed' ? '500' : '12.5'} value={draft.value} onChange={(e) => setDraft({ ...draft, value: e.target.value })} />
              </div>
            </div>

            <fieldset className="setup-group">
              <legend>Stays it covers</legend>
              <div className="field-row">
                <div className="field">
                  <label htmlFor="promo-from">From</label>
                  <DateField id="promo-from" required value={draft.validFrom} onChange={(validFrom) => setDraft({ ...draft, validFrom })} />
                </div>
                <div className="field">
                  <label htmlFor="promo-to">To</label>
                  <DateField id="promo-to" required min={draft.validFrom || undefined} value={draft.validTo} onChange={(validTo) => setDraft({ ...draft, validTo })} />
                </div>
              </div>
              <p className="hint">Every night of the stay must fall within these dates.</p>
            </fieldset>

            <fieldset className="setup-choice-set">
              <legend className="field-label">How a guest gets it</legend>
              <div className="setup-choices cols-2">
                <label className={`review-option${!withCode ? ' picked' : ''}`}>
                  <input type="radio" name="promo-how" checked={!withCode} onChange={() => setWithCode(false)} />
                  <span>
                    <strong>By itself</strong>
                    <span className="small muted">Every stay in the dates gets it.</span>
                  </span>
                </label>
                <label className={`review-option${withCode ? ' picked' : ''}`}>
                  <input type="radio" name="promo-how" checked={withCode} onChange={() => setWithCode(true)} />
                  <span>
                    <strong>With a code</strong>
                    <span className="small muted">The guest types it on the booking page.</span>
                  </span>
                </label>
              </div>
            </fieldset>
            {withCode && (
              <div className="field">
                <label htmlFor="promo-code">Code</label>
                <input id="promo-code" maxLength={32} autoComplete="off" placeholder="SUMMER10" value={draft.code} onChange={(e) => setDraft({ ...draft, code: e.target.value })} />
              </div>
            )}
            <div className="field">
              <label htmlFor="promo-max">
                Limit <span className="muted">(optional)</span>
              </label>
              <input id="promo-max" type="number" min={1} placeholder="no limit" value={draft.maxUses} onChange={(e) => setDraft({ ...draft, maxUses: e.target.value })} />
              <p className="hint">How many bookings may use it. A declined or cancelled booking gives its use back.</p>
            </div>

            {summary && (
              <p className="setup-summary" aria-live="polite">
                <Icon name="tag" size={14} />
                {summary}
              </p>
            )}
            {notice?.kind === 'error' && formOpen && (
              <div className="notice error drawer-notice" role="alert">
                {notice.message}
              </div>
            )}
            <div className="drawer-footer">
              <div className="drawer-footer-total">
                <span className="small muted">{formMissing ?? (draft.id === null ? 'Ready to add.' : 'Future bookings get the change.')}</span>
              </div>
              <button type="button" disabled={busy} onClick={closeForm}>
                Cancel
              </button>
              <button type="submit" className="primary" aria-busy={busy || undefined} disabled={busy || formMissing !== null}>
                {busy ? 'Saving…' : draft.id === null ? 'Add promo' : 'Save'}
              </button>
            </div>
          </form>
        </Drawer>

        <section className="card">
          <h2>Promos offered</h2>
          <p className="small muted">The database takes the discount off when a booking is priced. Two automatic promos on the same stay: the larger wins.</p>
          {promos === null ? (
            <LoadState load={loadState} what="promos" onRetry={() => { setLoadState(LOADING); void load(); }} skeleton={<PromosSkeleton />} />
          ) : active.length === 0 ? (
            <EmptyState icon="tag" title="No promos" action={addPromo}>
              A promo takes a fixed amount or a percentage off the stays in its dates.
            </EmptyState>
          ) : (
            active.map(row)
          )}
          {retired.length > 0 && (
            <p className="small">
              <button type="button" className="link" onClick={() => setShowRetired((v) => !v)}>
                {showRetired ? 'Hide' : 'Show'} {retired.length} retired
              </button>
            </p>
          )}
          {showRetired && retired.map(row)}
        </section>
      </StaffFrame>
    </>
  );
}
