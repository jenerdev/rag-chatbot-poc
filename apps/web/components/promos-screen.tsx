'use client';

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
// The look (plan/ui-refresh.md Phase 9): "Add a promo" and Edit open the
// form in a drawer; the value is a badge in words ("12.5 % off"); Retire and
// Delete ask in the dialog.

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
import { Tip } from '@/components/tooltip';
import { EmptyState, LOADING, LoadState, failed, type Load } from '@/components/load-state';

export interface PromosScreenProps {
  slug: string;
  businessName: string;
  logoUrl: string | null;
  bannerUrl: string | null;
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

export function PromosScreen({ slug, businessName, logoUrl, bannerUrl, nav, currency }: PromosScreenProps) {
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
      code: draft.code.trim() === '' ? null : draft.code.trim(),
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
    setNotice(null);
    setFormOpen(true);
  }

  const editing = draft.id === null ? null : (promos?.find((p) => p.id === draft.id) ?? null);

  const frame = { slug, businessName, logoUrl, bannerUrl, features: nav, current: 'promos' as const, title: 'Promos', session: { auth, role, onLogout: logout } };

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

  const row = (p: Promo) => (
    <div key={p.id} className="list-row">
      <span className="list-row-lead">
        {p.validFrom} → {p.validTo}
      </span>
      <span className="list-row-main">
        <span className="list-row-title">{p.name}</span>
        <span className="badge ok">{valueLabel(p, currency)} off</span>
        <span className={p.code ? 'badge accent' : 'badge'}>{p.code ? `Code ${p.code}` : 'Automatic'}</span>
        {!p.active && <span className="badge">Retired</span>}
        {overlapping.includes(p) && (
          <span className="badge warn">
            <Icon name="alert" size={12} /> Overlaps another automatic promo
          </span>
        )}
      </span>
      <span className="list-row-meta">
        {p.uses} use{p.uses === 1 ? '' : 's'}
        {p.maxUses !== null ? ` of ${p.maxUses}` : ''}
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
        if (draft.id !== null) setDraft(EMPTY);
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
          <p className="small muted">
            A promo takes its discount off every stay whose dates fall inside its range. With a code, the customer types it on
            the booking page; without one, it applies by itself. The database computes the discount when a booking is quoted or
            made; a promo edited later changes future bookings only.
          </p>
          <form onSubmit={save}>
            <div className="field-row">
              <div className="field grow">
                <label htmlFor="promo-name">Name</label>
                <input id="promo-name" required maxLength={80} placeholder="Off season discount" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
              </div>
              <div className="field">
                <label htmlFor="promo-kind">Type</label>
                <select id="promo-kind" value={draft.kind} onChange={(e) => setDraft({ ...draft, kind: e.target.value === 'fixed' ? 'fixed' : 'percent', value: '' })}>
                  <option value="percent">Percentage</option>
                  <option value="fixed">Fixed amount</option>
                </select>
              </div>
              <div className="field narrow">
                <label htmlFor="promo-value">{draft.kind === 'fixed' ? `Amount (${currency})` : 'Percent'}</label>
                <input
                  id="promo-value"
                  required
                  inputMode="decimal"
                  placeholder={draft.kind === 'fixed' ? '500' : '12.5'}
                  value={draft.value}
                  onChange={(e) => setDraft({ ...draft, value: e.target.value })}
                />
              </div>
            </div>
            <div className="field-row">
              <div className="field">
                <label htmlFor="promo-from">Stays from</label>
                <input id="promo-from" type="date" required value={draft.validFrom} onChange={(e) => setDraft({ ...draft, validFrom: e.target.value })} />
              </div>
              <div className="field">
                <label htmlFor="promo-to">to</label>
                <input id="promo-to" type="date" required value={draft.validTo} onChange={(e) => setDraft({ ...draft, validTo: e.target.value })} />
              </div>
              <div className="field">
                <label htmlFor="promo-code">
                  Code <span className="muted">(optional)</span>
                </label>
                <input
                  id="promo-code"
                  maxLength={32}
                  placeholder="SUMMER10"
                  value={draft.code}
                  onChange={(e) => setDraft({ ...draft, code: e.target.value })}
                />
              </div>
              <div className="field narrow">
                <label htmlFor="promo-max">
                  Limit <span className="muted">(optional)</span>
                </label>
                <input id="promo-max" type="number" min={1} placeholder="10" value={draft.maxUses} onChange={(e) => setDraft({ ...draft, maxUses: e.target.value })} />
              </div>
            </div>
            <div className="form-footer">
              <span className="small muted">
                {draft.code.trim() === ''
                  ? 'No code: this promo applies by itself to every eligible stay.'
                  : 'The limit counts bookings, pending or confirmed; a declined or cancelled one gives its use back.'}
              </span>
              <span className="form-actions">
                <button type="button" disabled={busy} onClick={closeForm}>
                  Cancel
                </button>
                <button type="submit" className="primary" aria-busy={busy || undefined} disabled={busy}>
                  {busy ? 'Saving…' : draft.id === null ? 'Add promo' : 'Save'}
                </button>
              </span>
            </div>
            {notice?.kind === 'error' && formOpen && (
              <div className="notice error drawer-notice" role="alert">
                {notice.message}
              </div>
            )}
          </form>
        </Drawer>

        <section className="card">
          <h2>Promos offered</h2>
          {promos === null ? (
            <LoadState load={loadState} what="promos" onRetry={() => { setLoadState(LOADING); void load(); }} />
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
