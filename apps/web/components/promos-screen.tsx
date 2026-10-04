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

import { useCallback, useEffect, useState } from 'react';
import type { Promo } from '@rag/bookings';
import { BrandHeader } from '@/components/brand-header';
import { LoginForm, describeFailure } from '@/components/admin-login';
import { TenantNav, fetchRole } from '@/components/tenant-nav';
import type { NavFeatures } from '@/lib/nav-items';
import { centavosToInput, formatMoney, parseMoneyInput } from '@/lib/money';
import { isRole, type Role } from '@/lib/permissions';

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
type Notice = { message: string; kind: 'ok' | 'error' } | null;

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

/**
 * "12.5" → 1250, "10" → 1000, "0.25" → 25: hundredths of a percent, by
 * string. null for anything else (more than two decimals, letters, over 100).
 */
function parsePercentInput(text: string): number | null {
  const match = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(text.trim());
  if (!match) return null;
  const whole = Number(match[1]);
  const frac = (match[2] ?? '').padEnd(2, '0');
  const value = whole * 100 + Number(frac);
  return value > 0 && value <= 10000 ? value : null;
}

/** 1250 → "12.5", 1000 → "10". */
function percentToInput(value: number): string {
  const whole = Math.floor(value / 100);
  const frac = value % 100;
  return frac === 0 ? String(whole) : `${whole}.${String(frac).padStart(2, '0').replace(/0$/, '')}`;
}

/** "12.5 %" or "₱500.00", for the list. */
function valueLabel(p: Promo, currency: string): string {
  return p.kind === 'percent' ? `${percentToInput(p.value)} %` : formatMoney(p.value, currency);
}

export function PromosScreen({ slug, businessName, logoUrl, bannerUrl, nav, currency }: PromosScreenProps) {
  const api = `/api/t/${slug}`;
  const [auth, setAuth] = useState<Auth>('checking');
  const [role, setRole] = useState<Role | null>(null);
  const [promos, setPromos] = useState<Promo[] | null>(null);
  const [loadMessage, setLoadMessage] = useState('Loading…');
  const [notice, setNotice] = useState<Notice>(null);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<Draft>(EMPTY);
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
      setLoadMessage(await describeFailure(error as Error, response));
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
    if (ok) setDraft(EMPTY);
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
    window.scrollTo({ top: 0 });
  }

  const editing = draft.id === null ? null : (promos?.find((p) => p.id === draft.id) ?? null);

  const header = (
    <BrandHeader businessName={businessName} logoUrl={logoUrl} bannerUrl={bannerUrl} subtitle="Promos">
      <TenantNav slug={slug} features={nav} current="promos" session={{ auth, role, onLogout: logout }} />
    </BrandHeader>
  );

  if (auth !== 'in') {
    return (
      <>
        {header}
        <main>
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
        </main>
      </>
    );
  }

  const active = promos?.filter((p) => p.active) ?? [];
  const retired = promos?.filter((p) => !p.active) ?? [];
  // Two automatic promos whose dates overlap: the larger discount wins on a
  // stay, which is a surprise worth naming (plan § 2.5).
  const overlapping = active.filter((p) => p.code === null && active.some((q) => q.id !== p.id && q.code === null && q.validFrom <= p.validTo && p.validFrom <= q.validTo));

  const row = (p: Promo) => (
    <div key={p.id} className="holiday">
      <span className="holiday-day">
        {p.validFrom} → {p.validTo}
      </span>
      <span className="holiday-label">
        {p.name}
        <span className="holiday-badge">{p.code ? `code ${p.code}` : 'automatic'}</span>
        {overlapping.includes(p) && <span className="holiday-badge">overlaps another automatic promo</span>}
      </span>
      <span className="holiday-surcharge">
        {valueLabel(p, currency)} off
        {' · '}
        {p.uses} use{p.uses === 1 ? '' : 's'}
        {p.maxUses !== null ? ` of ${p.maxUses}` : ''}
      </span>
      {p.active && (
        <button type="button" className="link" disabled={busy} onClick={() => edit(p)}>
          Edit
        </button>
      )}
      {p.active && p.uses > 0 && (
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            if (window.confirm(`Retire "${p.name}"? No new booking can use it. The ${p.uses} that did keep their discount.`)) {
              void write('PATCH', `/promos/${p.id}`, { active: false }, `Retired "${p.name}".`);
            }
          }}
        >
          Retire
        </button>
      )}
      {p.active && p.uses === 0 && (
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            if (window.confirm(`Delete "${p.name}"? It was never used.`)) {
              void write('DELETE', `/promos/${p.id}`, undefined, `Deleted "${p.name}".`);
            }
          }}
        >
          Delete
        </button>
      )}
      {!p.active && (
        <button type="button" className="link" disabled={busy} onClick={() => void write('PATCH', `/promos/${p.id}`, { active: true }, `"${p.name}" is offered again.`)}>
          Offer again
        </button>
      )}
    </div>
  );

  return (
    <>
      {header}
      <main>
        <div className={notice ? `notice ${notice.kind}` : 'notice hidden'}>{notice?.message}</div>

        <section className="card">
          <h2>{draft.id === null ? 'Add a promo' : `Edit "${editing?.name ?? draft.name}"`}</h2>
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
              <span>
                {draft.id !== null && (
                  <button type="button" disabled={busy} onClick={() => setDraft(EMPTY)}>
                    Cancel
                  </button>
                )}{' '}
                <button type="submit" className="primary" disabled={busy}>
                  {busy ? 'Saving…' : draft.id === null ? 'Add promo' : 'Save'}
                </button>
              </span>
            </div>
          </form>
        </section>

        <section className="card">
          <h2>Promos offered</h2>
          {promos === null ? (
            <div className="small">{loadMessage}</div>
          ) : active.length === 0 ? (
            <div className="small muted">No promos. Add one above.</div>
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
      </main>
    </>
  );
}
