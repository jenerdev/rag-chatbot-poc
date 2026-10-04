// promos.ts — a tenant's promos (plan/promos.md, D-097): list, create, edit,
// retire, delete, for staff; and the two reads the quotes make.
//
// The discount itself is NEVER computed here. promo_discount() in Postgres is
// the only arithmetic (plan Rule 1); the quotes call it for the preview, the
// trigger and request_booking() call it for the stored rows, so the preview
// and the receipt cannot disagree. promo_for_request() is the customer's one
// door (Rule 2): a chat token reads nothing from `promos`, and this file
// never hands a customer a code or an id it did not type.

import { requireConfig } from './bookings.js';
import { BookingInputError } from './errors.js';
import type { BookingTenant, NewPromo, Promo, PromoForStay, PromoKind } from './types.js';
import { isIsoDate, optionalPositiveInt, positiveInt, requireText } from './validate.js';

const CODE = /^[A-Za-z0-9_-]{3,32}$/;
const MAX_NAME = 80;

/** 'fixed' or 'percent', or a 400 in words. */
function promoKind(value: unknown): PromoKind {
  if (value === 'fixed' || value === 'percent') return value;
  throw new BookingInputError('Kind must be "fixed" or "percent".');
}

/**
 * The value, an INTEGER: centavos for a fixed amount, hundredths of a percent
 * for a percentage (1250 = 12.50 %, at most 10000). The screen turns "12.5"
 * into 1250 by string, never by × 100 (plan § 2.1).
 */
function promoValue(value: unknown, kind: PromoKind): number {
  const n = positiveInt(value, kind === 'fixed' ? 'Amount' : 'Percentage');
  if (kind === 'percent' && n > 10000) throw new BookingInputError('A percentage is at most 100 %.');
  return n;
}

/** The code, trimmed: letters, digits, - and _, 3 to 32 of them; null or empty means automatic. */
function promoCode(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new BookingInputError('The code must be text.');
  const code = value.trim();
  if (code === '') return null;
  if (!CODE.test(code)) throw new BookingInputError('A code is 3 to 32 letters, digits, - or _.');
  return code;
}

function promoRange(from: unknown, to: unknown): { from: string; to: string } {
  if (!isIsoDate(from)) throw new BookingInputError('"Valid from" must be a date, YYYY-MM-DD.');
  if (!isIsoDate(to)) throw new BookingInputError('"Valid to" must be a date, YYYY-MM-DD.');
  if (to < from) throw new BookingInputError('"Valid to" is before "valid from".');
  return { from, to };
}

type Row = {
  id: number;
  name: string;
  kind: PromoKind;
  value: number;
  valid_from: string;
  valid_to: string;
  code: string | null;
  max_uses: number | null;
  active: boolean;
  created_at: string;
};

function toPromo(row: Row, uses: number): Promo {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    value: row.value,
    validFrom: row.valid_from,
    validTo: row.valid_to,
    code: row.code,
    maxUses: row.max_uses,
    active: row.active,
    uses,
    createdAt: row.created_at,
  };
}

/** How many requests used this promo: promo_uses(), counted, never stored (plan § 2.3). */
async function usesOf(tenant: BookingTenant, promoId: number): Promise<number> {
  const { data, error } = await tenant.db.rpc('promo_uses', { p_tenant_id: tenant.id, p_promo_id: promoId });
  if (error) throw new Error(`Could not count the promo's uses: ${error.message}`);
  return data ?? 0;
}

/**
 * The tenant's promos, newest first, with their use count. Active ones unless
 * `{ all: true }` (the screen's "show retired"). STAFF: the policy lets any
 * member read; a chat token gets `[]` (the positive twin is in verify 112).
 */
export async function listPromos(tenant: BookingTenant, options: { all?: boolean } = {}): Promise<Promo[]> {
  await requireConfig(tenant);
  let query = tenant.db
    .from('promos')
    .select('id, name, kind, value, valid_from, valid_to, code, max_uses, active, created_at')
    .eq('tenant_id', tenant.id)
    .order('created_at', { ascending: false });
  if (!options.all) query = query.eq('active', true);
  const { data, error } = await query;
  if (error) throw new Error(`Could not load promos: ${error.message}`);
  return Promise.all(data.map(async (row) => toPromo(row as Row, await usesOf(tenant, row.id))));
}

/** Create a promo. A code already used by another of this tenant's promos is refused in words (23505). */
export async function createPromo(tenant: BookingTenant, input: NewPromo): Promise<Promo> {
  await requireConfig(tenant);
  const kind = promoKind(input.kind);
  const { from, to } = promoRange(input.validFrom, input.validTo);
  const row = {
    tenant_id: tenant.id,
    name: requireText(input.name, 'Name', MAX_NAME),
    kind,
    value: promoValue(input.value, kind),
    valid_from: from,
    valid_to: to,
    code: promoCode(input.code),
    max_uses: optionalPositiveInt(input.maxUses, 'Usage limit'),
  };
  const { data, error } = await tenant.db
    .from('promos')
    .insert(row)
    .select('id, name, kind, value, valid_from, valid_to, code, max_uses, active, created_at')
    .single();
  if (error?.code === '23505') throw new BookingInputError('That code is already used by another promo.');
  if (error) throw new Error(`Could not create the promo: ${error.message}`);
  console.log(`[bookings] ${tenant.slug} promo #${data.id} "${data.name}" ${data.kind} ${data.value} ${data.valid_from}..${data.valid_to}${data.code ? ` code ${data.code}` : ' automatic'}${data.max_uses ? ` max ${data.max_uses}` : ''}`);
  return toPromo(data as Row, 0);
}

/**
 * Edit a promo. Only the fields sent change. A booking that already used it
 * keeps its stored discount (plan Rule 4): an edit changes future quotes.
 * Null means "not yours or not there", one answer.
 */
export async function updatePromo(tenant: BookingTenant, id: unknown, patch: Partial<NewPromo> & { active?: unknown }): Promise<Promo | null> {
  await requireConfig(tenant);
  const promoId = positiveInt(id, 'Promo');
  const { data: current, error: readError } = await tenant.db
    .from('promos')
    .select('id, name, kind, value, valid_from, valid_to, code, max_uses, active, created_at')
    .eq('tenant_id', tenant.id)
    .eq('id', promoId)
    .maybeSingle();
  if (readError) throw new Error(`Could not read the promo: ${readError.message}`);
  if (!current) return null;

  const kind = patch.kind === undefined ? (current.kind as PromoKind) : promoKind(patch.kind);
  const { from, to } = promoRange(patch.validFrom ?? current.valid_from, patch.validTo ?? current.valid_to);
  const changes = {
    name: patch.name === undefined ? current.name : requireText(patch.name, 'Name', MAX_NAME),
    kind,
    value: patch.value === undefined && patch.kind === undefined ? current.value : promoValue(patch.value ?? current.value, kind),
    valid_from: from,
    valid_to: to,
    code: patch.code === undefined ? current.code : promoCode(patch.code),
    max_uses: patch.maxUses === undefined ? current.max_uses : optionalPositiveInt(patch.maxUses, 'Usage limit'),
    active: patch.active === undefined ? current.active : Boolean(patch.active),
  };
  const { data, error } = await tenant.db
    .from('promos')
    .update(changes)
    .eq('tenant_id', tenant.id)
    .eq('id', promoId)
    .select('id, name, kind, value, valid_from, valid_to, code, max_uses, active, created_at')
    .maybeSingle();
  if (error?.code === '23505') throw new BookingInputError('That code is already used by another promo.');
  if (error) throw new Error(`Could not update the promo: ${error.message}`);
  if (!data) return null;
  console.log(`[bookings] ${tenant.slug} promo #${promoId} updated`);
  return toPromo(data as Row, await usesOf(tenant, promoId));
}

/** Retire a promo: no new use, every booking that used it unchanged. `false` = not yours or not there. */
export async function retirePromo(tenant: BookingTenant, id: unknown): Promise<boolean> {
  return (await updatePromo(tenant, id, { active: false })) !== null;
}

/**
 * Delete a promo that was NEVER used (no booking points at it, whatever its
 * status). One that was is refused in words: retire it instead, so the
 * bookings keep their promo. `false` = not yours or not there.
 */
export async function deletePromo(tenant: BookingTenant, id: unknown): Promise<boolean> {
  await requireConfig(tenant);
  const promoId = positiveInt(id, 'Promo');
  const { count, error: countError } = await tenant.db
    .from('bookings')
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', tenant.id)
    .eq('promo_id', promoId);
  if (countError) throw new Error(`Could not count the promo's bookings: ${countError.message}`);
  if ((count ?? 0) > 0) throw new BookingInputError('This promo has been used by a booking. Retire it instead.');
  const { data, error } = await tenant.db.from('promos').delete().eq('tenant_id', tenant.id).eq('id', promoId).select('id');
  if (error) throw new Error(`Could not delete the promo: ${error.message}`);
  if (data.length > 0) console.log(`[bookings] ${tenant.slug} promo #${promoId} deleted`);
  return data.length > 0;
}

/**
 * The promo for a stay, through promo_for_request() (Rule 2), on whatever
 * token the caller holds: the promo for a typed code, with a `reason` when it
 * does not apply, or the automatic one, or null. A typed code that matches
 * nothing is null too, and the caller says "No such promo code".
 */
export async function promoForStay(
  tenant: BookingTenant,
  code: string | null,
  from: string,
  to: string,
  subtotal: number,
): Promise<PromoForStay | null> {
  const { data, error } = await tenant.db.rpc('promo_for_request', { p_tenant_id: tenant.id, p_code: code, p_from: from, p_to: to, p_subtotal: subtotal });
  if (error) throw new Error(`Could not look up the promo: ${error.message}`);
  const row = data?.[0];
  if (!row) return null;
  return { id: row.id, name: row.name, kind: row.kind, value: row.value, validFrom: row.valid_from, validTo: row.valid_to, reason: row.reason };
}

/**
 * Each line's discount, from promo_discount(), the row order being the one
 * the writer will insert in: the first line is the "first row of the stay",
 * where a fixed amount lands (plan § 2.2). Null promo: zeros.
 */
export async function discountLines(tenant: BookingTenant, promoId: number | null, prices: number[]): Promise<number[]> {
  if (promoId === null) return prices.map(() => 0);
  return Promise.all(
    prices.map(async (price, i) => {
      const { data, error } = await tenant.db.rpc('promo_discount', { p_tenant_id: tenant.id, p_promo_id: promoId, p_price: price, p_first: i === 0 });
      if (error) throw new Error(`Could not compute the discount: ${error.message}`);
      return data ?? 0;
    }),
  );
}

/** The sentence a quote shows when a typed code did not apply; null when it did or none was typed. */
export function promoMessage(code: string | null, promo: PromoForStay | null): string | null {
  if (code === null) return null;
  if (promo === null) return 'No such promo code.';
  if (promo.reason === 'dates') return `The promo "${promo.name}" covers stays from ${promo.validFrom} to ${promo.validTo}.`;
  if (promo.reason === 'exhausted') return `The promo "${promo.name}" has reached its limit.`;
  return null;
}

/** A typed code, trimmed; empty is "none". Shape errors are the database's words at request time. */
export function optionalCode(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new BookingInputError('The promo code must be text.');
  const code = value.trim();
  return code === '' ? null : code;
}
