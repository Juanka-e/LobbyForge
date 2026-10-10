'use client';

import { useId, useState } from 'react';
import { useT } from '@/lib/i18n/client';

/**
 * Who may create polls in text channels (docs/CHAT_POLLS.md), chosen on the
 * Poll app's card. It is not a second setting: each box IS the role's
 * `create_polls` permission, saved through the role API. So the role editor
 * and this card always agree, and the role API's own checks apply unchanged
 * — Manage Roles, the role hierarchy, and never granting a permission the
 * editor does not hold.
 */

const CREATE_POLLS = 'create_polls';
const ADMINISTRATOR = 'administrator';

export interface PollRole {
  id: string;
  name: string;
  position: number;
  permissions: string[];
}

export function PollRolesPicker({
  serverId,
  roles,
  canManageRoles,
  onChanged,
}: {
  serverId: string;
  roles: PollRole[];
  canManageRoles: boolean;
  onChanged: () => Promise<void>;
}) {
  const t = useT();
  const titleId = useId();
  const [busyRoleId, setBusyRoleId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Highest role first, @everyone (position 0) last — the role editor's order.
  const ordered = [...roles].sort((a, b) => b.position - a.position);

  async function toggle(role: PollRole, grant: boolean) {
    setBusyRoleId(role.id);
    setError(null);
    const permissions = grant
      ? [...new Set([...role.permissions, CREATE_POLLS])]
      : role.permissions.filter((permission) => permission !== CREATE_POLLS);
    try {
      const res = await fetch(`/api/servers/${serverId}/roles/${role.id}`, {
        method: 'PATCH',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ permissions }),
      });
      if (!res.ok) {
        setError(
          t(res.status === 403 ? 'hub.servers.apps.pollRoles.forbidden' : 'hub.servers.apps.pollRoles.failed', {
            role: role.name,
          })
        );
        return;
      }
      await onChanged();
    } catch {
      setError(t('hub.servers.apps.pollRoles.failed', { role: role.name }));
    } finally {
      setBusyRoleId(null);
    }
  }

  return (
    <div role="group" aria-labelledby={titleId} className="mt-4 grid gap-2 border-t border-border-subtle pt-4">
      <p id={titleId} className="text-sm font-medium text-text-primary">
        {t('hub.servers.apps.pollRoles.title')}
      </p>
      <p className="text-xs text-text-muted">{t('hub.servers.apps.pollRoles.hint')}</p>
      {canManageRoles ? null : (
        <p className="text-xs text-text-muted">{t('hub.servers.apps.pollRoles.needsManageRoles')}</p>
      )}
      {ordered.length === 0 ? (
        <p className="text-xs text-text-muted">{t('hub.servers.apps.pollRoles.noRoles')}</p>
      ) : (
        <ul className="flex flex-wrap gap-2">
          {ordered.map((role) => {
            const admin = role.permissions.includes(ADMINISTRATOR);
            const checked = admin || role.permissions.includes(CREATE_POLLS);
            return (
              <li key={role.id}>
                <label
                  className={`inline-flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-xs ${
                    checked ? 'border-primary/60 text-text-primary' : 'border-border-subtle text-text-secondary'
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={!canManageRoles || admin || busyRoleId !== null}
                    onChange={(event) => void toggle(role, event.target.checked)}
                    className="accent-primary"
                  />
                  <span>{role.name}</span>
                  {admin ? <span className="text-text-muted">{t('hub.servers.apps.pollRoles.admin')}</span> : null}
                </label>
              </li>
            );
          })}
        </ul>
      )}
      {error ? (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}
