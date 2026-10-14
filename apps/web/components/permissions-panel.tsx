'use client';

// The platform tenant form's Permissions tab (D-128): what each role may do
// in THIS tenant, as a table of checkboxes, one row per permission, one
// column per role. It starts from the default (lib/permissions.ts) with the
// tenant's rows over it, and saves only the cells that differ from the
// default, in one request; "Use the defaults" clears them all.
//
// A box that cannot change is disabled and says why beside it: a FIXED
// permission (asked inside SQL functions a row cannot reach), or a grant the
// database could not honour (a permission the role lacks that is not
// GRANTABLE). Postgres's app_can() reads the same rows the same way.

import { useMemo, useState } from 'react';
import { SaveBar } from '@/components/save-bar';
import {
  CONFIGURABLE_PERMISSIONS,
  GRANTABLE_PERMISSIONS,
  PERMISSIONS,
  PERMISSION_LABELS,
  ROLES,
  ROLE_LABELS,
  can,
  canByDefault,
  overridesFrom,
  type Permission,
  type Role,
} from '@/lib/permissions';

type Matrix = Record<Permission, Record<Role, boolean>>;

function matrixOf(rows: readonly { role: string; permission: string; allowed: boolean }[]): Matrix {
  const overrides = overridesFrom(rows);
  return Object.fromEntries(PERMISSIONS.map((p) => [p, Object.fromEntries(ROLES.map((r) => [r, can(r, p, overrides)]))])) as Matrix;
}

/** The cells that differ from the default: what the database stores. */
function rowsOf(matrix: Matrix): { role: Role; permission: Permission; allowed: boolean }[] {
  return CONFIGURABLE_PERMISSIONS.flatMap((p) => ROLES.filter((r) => matrix[p][r] !== canByDefault(r, p)).map((r) => ({ role: r, permission: p, allowed: matrix[p][r] })));
}

/** Why a box cannot change, or null when it can. */
function lockedBecause(role: Role, permission: Permission): string | null {
  if (!CONFIGURABLE_PERMISSIONS.includes(permission)) return 'Fixed for every tenant';
  if (!canByDefault(role, permission) && !GRANTABLE_PERMISSIONS.includes(permission)) return `Cannot be given to ${ROLE_LABELS[role].toLowerCase()}`;
  return null;
}

export function PermissionsPanel({
  rows,
  busy,
  onSave,
}: {
  /** TenantDetail.rolePermissions: where this tenant differs from the default */
  rows: readonly { role: string; permission: string; allowed: boolean }[];
  busy: boolean;
  onSave: (rows: { role: Role; permission: Permission; allowed: boolean }[]) => void;
}) {
  const saved = useMemo(() => matrixOf(rows), [rows]);
  const [matrix, setMatrix] = useState<Matrix>(saved);
  const dirty = JSON.stringify(rowsOf(matrix)) !== JSON.stringify(rowsOf(saved));
  const custom = rowsOf(matrix).length;
  const areas = [...new Set(PERMISSIONS.map((p) => PERMISSION_LABELS[p].area))];

  return (
    <form
      className="card settings"
      onSubmit={(event) => {
        event.preventDefault();
        onSave(rowsOf(matrix));
      }}
    >
      <section className="settings-section" aria-labelledby="perm-about">
        <div className="settings-about">
          <h2 id="perm-about">Who may do what</h2>
          <p>
            What each role may do in this tenant. A ticked box is allowed. The defaults suit most resorts; a change here applies at
            each member&apos;s next click, and the database enforces it too.
          </p>
          <p className="small muted perm-count">{custom === 0 ? 'Using the defaults.' : `${custom} change${custom === 1 ? '' : 's'} from the defaults.`}</p>
          {custom > 0 && (
            <button type="button" className="sm" disabled={busy} onClick={() => setMatrix(matrixOf([]))}>
              Use the defaults
            </button>
          )}
        </div>
        <div className="perm-table-wrap">
          <table className="perm-table">
            <caption className="visually-hidden">Permissions by role</caption>
            <thead>
              <tr>
                <th scope="col">Permission</th>
                {ROLES.map((r) => (
                  <th key={r} scope="col">
                    {ROLE_LABELS[r]}
                  </th>
                ))}
              </tr>
            </thead>
            {areas.map((area) => (
              <tbody key={area}>
                <tr className="perm-area">
                  <th scope="rowgroup" colSpan={ROLES.length + 1}>
                    {area}
                  </th>
                </tr>
                {PERMISSIONS.filter((p) => PERMISSION_LABELS[p].area === area).map((p) => {
                  const fixed = !CONFIGURABLE_PERMISSIONS.includes(p);
                  return (
                    <tr key={p}>
                      <th scope="row">
                        <span>{PERMISSION_LABELS[p].label}</span>
                        {fixed && <span className="small muted perm-note">Fixed for every tenant</span>}
                      </th>
                      {ROLES.map((r) => {
                        const locked = lockedBecause(r, p);
                        const changed = matrix[p][r] !== canByDefault(r, p);
                        return (
                          <td key={r} className={changed ? 'perm-changed' : undefined}>
                            <input
                              type="checkbox"
                              checked={matrix[p][r]}
                              disabled={busy || locked !== null}
                              aria-label={`${ROLE_LABELS[r]}: ${PERMISSION_LABELS[p].label}${locked && !fixed ? ` (${locked})` : ''}`}
                              onChange={(e) => setMatrix({ ...matrix, [p]: { ...matrix[p], [r]: e.target.checked } })}
                            />
                            {changed && <span className="visually-hidden"> (changed from the default)</span>}
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            ))}
          </table>
          <p className="hint">
            A greyed box cannot change: verifying payments and the payment settings stay with owners and admins, and a role can be
            given only the setup and knowledge-base permissions it lacks. A changed box is marked.
          </p>
        </div>
      </section>
      <SaveBar dirty={dirty} busy={busy} onDiscard={() => setMatrix(saved)} label="Save permissions" />
    </form>
  );
}
