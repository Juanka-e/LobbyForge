'use client';

import { useMemo, useState } from 'react';
import { ROLE_ICONS } from '@/lib/role-icons';

export interface RoleView {
  id: string;
  serverId: string;
  name: string;
  color: string | null;
  icon: string | null;
  displaySeparately: boolean;
  position: number;
  permissions: string[];
  memberCount: number;
  createdAt: string;
}

interface ApiRoleResponse {
  roles?: Array<Omit<RoleView, 'memberCount'>>;
  role?: Omit<RoleView, 'memberCount'>;
  error?: string;
}

interface PermissionGroup {
  label: string;
  permissions: { key: string; label: string }[];
}

const PERMISSION_GROUPS: PermissionGroup[] = [
  {
    label: 'General',
    permissions: [
      { key: 'administrator', label: 'Administrator' },
      { key: 'manage_server', label: 'Manage Community' },
      { key: 'manage_roles', label: 'Manage Roles' },
      { key: 'manage_channels', label: 'Manage Channels' },
      { key: 'view_audit_log', label: 'View Audit Log' },
    ],
  },
  {
    label: 'Members',
    permissions: [
      { key: 'create_invite', label: 'Invite People' },
      { key: 'kick_members', label: 'Kick Members' },
      { key: 'ban_members', label: 'Ban Members' },
    ],
  },
  {
    label: 'Text Channels',
    permissions: [
      { key: 'send_messages', label: 'Send Messages' },
      { key: 'manage_messages', label: 'Manage Messages' },
      { key: 'add_reactions', label: 'Add Reactions' },
    ],
  },
  {
    label: 'Voice Rooms',
    permissions: [
      { key: 'connect_voice', label: 'Join Voice Rooms' },
      { key: 'speak', label: 'Speak' },
      { key: 'mute_members', label: 'Mute Members' },
      { key: 'deafen_members', label: 'Deafen Members' },
    ],
  },
  {
    label: 'Activities',
    permissions: [{ key: 'start_activity', label: 'Start Activities' }],
  },
];

const DEFAULT_COLOR = '#7c8cff';
const EMPTY_FORM = { name: '', color: DEFAULT_COLOR, icon: null as string | null, displaySeparately: false, permissions: [] as string[] };

export default function RolesClient({
  serverId,
  initialRoles,
  loadError,
}: {
  serverId: string | null;
  initialRoles: RoleView[];
  loadError: string | null;
}) {
  const [roles, setRoles] = useState(initialRoles);
  const [form, setForm] = useState(EMPTY_FORM);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState({ name: '', color: DEFAULT_COLOR, icon: null as string | null, displaySeparately: false, position: 0, permissions: [] as string[] });
  const [busyId, setBusyId] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [message, setMessage] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);

  const sortedRoles = useMemo(
    () => [...roles].sort((a, b) => b.position - a.position || a.name.localeCompare(b.name)),
    [roles]
  );
  const adminRoles = sortedRoles.filter((role) => role.permissions.includes('administrator')).length;

  async function refreshRoles() {
    if (!serverId) return;
    const response = await fetch(`/api/servers/${encodeURIComponent(serverId)}/roles`, {
      method: 'GET',
      cache: 'no-store',
    });
    const data = (await response.json().catch(() => ({}))) as ApiRoleResponse;
    if (!response.ok || !data.roles) throw new Error(data.error ?? 'Could not reload roles');
    setRoles((current) => mergeMemberCounts(data.roles ?? [], current));
  }

  async function createRole() {
    if (!serverId || isCreating) return;
    const name = form.name.trim();
    if (name.length === 0) {
      setMessage({ tone: 'danger', text: 'Role name is required.' });
      return;
    }
    if (form.permissions.includes('administrator') && !window.confirm('This role will have full administrator access. Continue?')) {
      return;
    }
    setIsCreating(true);
    setMessage(null);
    try {
      const maxPosition = Math.max(0, ...roles.map((role) => role.position));
      const response = await fetch(`/api/servers/${encodeURIComponent(serverId)}/roles`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          color: form.color,
          icon: form.icon,
          displaySeparately: form.displaySeparately,
          position: maxPosition + 1,
          permissions: form.permissions,
        }),
      });
      const data = (await response.json().catch(() => ({}))) as ApiRoleResponse;
      if (!response.ok || !data.role) throw new Error(data.error ?? 'Could not create role');
      setRoles((current) => [...current, { ...data.role!, memberCount: 0 }]);
      setForm(EMPTY_FORM);
      setMessage({ tone: 'success', text: 'Role created.' });
    } catch (err) {
      setMessage({ tone: 'danger', text: (err as Error).message });
    } finally {
      setIsCreating(false);
    }
  }

  function beginEdit(role: RoleView) {
    setEditingId(role.id);
    setDraft({
      name: role.name,
      color: role.color ?? DEFAULT_COLOR,
      icon: role.icon,
      displaySeparately: role.displaySeparately,
      position: role.position,
      permissions: role.permissions,
    });
    setMessage(null);
  }

  async function saveRole(role: RoleView) {
    if (!serverId || busyId) return;
    const name = draft.name.trim();
    if (name.length === 0) {
      setMessage({ tone: 'danger', text: 'Role name is required.' });
      return;
    }
    const adminWasAdded = !role.permissions.includes('administrator') && draft.permissions.includes('administrator');
    if (adminWasAdded && !window.confirm('This grants full administrator access to this role. Continue?')) {
      return;
    }
    setBusyId(role.id);
    setMessage(null);
    try {
      const body: Record<string, unknown> = {
        color: draft.color,
        icon: draft.icon,
        displaySeparately: draft.displaySeparately,
        position: draft.position,
        permissions: draft.permissions,
      };
      if (role.name !== '@everyone') body.name = name;
      const response = await fetch(
        `/api/servers/${encodeURIComponent(serverId)}/roles/${encodeURIComponent(role.id)}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }
      );
      const data = (await response.json().catch(() => ({}))) as ApiRoleResponse;
      if (!response.ok || !data.role) throw new Error(data.error ?? 'Could not update role');
      setRoles((current) =>
        current.map((item) => (item.id === role.id ? { ...data.role!, memberCount: item.memberCount } : item))
      );
      setEditingId(null);
      setMessage({ tone: 'success', text: 'Role updated.' });
    } catch (err) {
      setMessage({ tone: 'danger', text: (err as Error).message });
    } finally {
      setBusyId(null);
    }
  }

  async function deleteRole(role: RoleView) {
    if (!serverId || busyId || role.name === '@everyone') return;
    if (!window.confirm(`Delete ${role.name}? Members with this role will lose it.`)) return;
    setBusyId(role.id);
    setMessage(null);
    try {
      const response = await fetch(
        `/api/servers/${encodeURIComponent(serverId)}/roles/${encodeURIComponent(role.id)}`,
        { method: 'DELETE' }
      );
      const data = (await response.json().catch(() => ({}))) as ApiRoleResponse;
      if (!response.ok) throw new Error(data.error ?? 'Could not delete role');
      setRoles((current) => current.filter((item) => item.id !== role.id));
      setMessage({ tone: 'success', text: 'Role deleted.' });
      await refreshRoles();
    } catch (err) {
      setMessage({ tone: 'danger', text: (err as Error).message });
    } finally {
      setBusyId(null);
    }
  }

  function updateFormPermission(permission: string) {
    setForm((current) => ({ ...current, permissions: togglePermission(current.permissions, permission) }));
  }

  function updateDraftPermission(permission: string) {
    setDraft((current) => ({ ...current, permissions: togglePermission(current.permissions, permission) }));
  }

  return (
    <section className="max-w-5xl mx-auto pb-32">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold text-text-primary">Roles & Permissions</h1>
        <p className="mt-1 text-sm text-text-secondary">
          Manage member roles and what each role can do in this community.
        </p>
      </header>

      <div className="flex flex-wrap gap-2 mb-6">
        <Chip label={`${sortedRoles.length} roles`} />
        <Chip label={`${adminRoles} admin roles`} tone="primary" />
      </div>

      {loadError ? <Alert tone="danger" text={`Could not load roles: ${loadError}`} /> : null}
      {!serverId ? <Alert tone="danger" text="No server is available for this admin account." /> : null}
      {message ? <Alert tone={message.tone} text={message.text} /> : null}

      <div className="mb-8 rounded-xl border border-border-subtle bg-surface p-4">
        <h2 className="mb-4 text-sm font-semibold text-text-primary">Create Role</h2>
        <div className="grid gap-3 md:grid-cols-[1fr_140px_auto]">
          <label className="block">
            <span className="sr-only">Role name</span>
            <input
              value={form.name}
              onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))}
              placeholder="Moderator"
              maxLength={64}
              disabled={!serverId || isCreating}
              className="w-full rounded-lg border border-border-subtle bg-surface-container px-3 py-2 text-sm text-text-primary placeholder-text-muted focus:outline-none focus:ring-1 focus:ring-primary-container"
            />
          </label>
          <label className="flex items-center gap-2 rounded-lg border border-border-subtle bg-surface-container px-3 py-2">
            <span className="sr-only">Role color</span>
            <input
              type="color"
              value={form.color}
              onChange={(event) => setForm((current) => ({ ...current, color: event.target.value }))}
              disabled={!serverId || isCreating}
              className="h-6 w-8 bg-transparent"
            />
            <span className="text-xs text-text-muted">{form.color}</span>
          </label>
          <button
            type="button"
            onClick={createRole}
            disabled={!serverId || isCreating}
            className="inline-flex items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-on-primary disabled:cursor-not-allowed disabled:opacity-50"
          >
            <span className="material-symbols-outlined text-[18px]">add</span>
            {isCreating ? 'Creating...' : 'Create'}
          </button>
        </div>
        <RoleIconPicker value={form.icon} onChange={(icon) => setForm((current) => ({ ...current, icon }))} disabled={!serverId || isCreating} />
        <SeparateMembersToggle checked={form.displaySeparately} onChange={(displaySeparately) => setForm((current) => ({ ...current, displaySeparately }))} disabled={!serverId || isCreating} />
        <PermissionMatrix selected={form.permissions} onToggle={updateFormPermission} compact />
      </div>

      <div className="bg-surface rounded-xl border border-border-subtle overflow-hidden">
        <ul className="divide-y divide-border-subtle">
          {sortedRoles.length === 0 ? (
            <li className="p-6 text-sm text-text-muted text-center">
              No roles configured. Default @everyone is created automatically.
            </li>
          ) : (
            sortedRoles.map((role) => {
              const isEditing = editingId === role.id;
              const isBusy = busyId === role.id;
              return (
                <li key={role.id} className="p-5">
                  <div className="mb-4 flex items-start gap-3">
                    <span
                      className="mt-1 h-3 w-3 shrink-0 rounded-full"
                      style={{ background: role.color ?? '#a8b3c5' }}
                    />
                    <div className="min-w-0 flex-1">
                      {isEditing ? (
                        <div className="grid gap-3 md:grid-cols-[1fr_140px_150px_120px]">
                          <input
                            value={draft.name}
                            onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
                            maxLength={64}
                            disabled={role.name === '@everyone' || isBusy}
                            className="w-full rounded-lg border border-border-subtle bg-surface-container px-3 py-2 text-sm text-text-primary disabled:opacity-60"
                          />
                          <label className="flex items-center gap-2 rounded-lg border border-border-subtle bg-surface-container px-3 py-2">
                            <span className="sr-only">Role color</span>
                            <input
                              type="color"
                              value={draft.color}
                              disabled={isBusy}
                              onChange={(event) => setDraft((current) => ({ ...current, color: event.target.value }))}
                              className="h-6 w-8 bg-transparent"
                            />
                            <span className="text-xs text-text-muted">{draft.color}</span>
                          </label>
                          <select
                            value={draft.icon ?? ''}
                            disabled={isBusy}
                            onChange={(event) => setDraft((current) => ({ ...current, icon: event.target.value || null }))}
                            aria-label="Role icon"
                            className="w-full rounded-lg border border-border-subtle bg-surface-container px-3 py-2 text-sm text-text-primary"
                          >
                            <option value="">No icon</option>
                            {ROLE_ICONS.map((icon) => <option key={icon} value={icon}>{icon.replaceAll('_', ' ')}</option>)}
                          </select>
                          <input
                            type="number"
                            min={0}
                            max={1000000}
                            value={draft.position}
                            disabled={isBusy}
                            onChange={(event) =>
                              setDraft((current) => ({ ...current, position: Number(event.target.value) || 0 }))
                            }
                            className="w-full rounded-lg border border-border-subtle bg-surface-container px-3 py-2 text-sm text-text-primary"
                            aria-label="Role position"
                          />
                        </div>
                      ) : (
                        <>
                          <div className="flex flex-wrap items-center gap-2">
                            {role.icon ? <span className="material-symbols-outlined text-[17px]" style={{ color: role.color ?? undefined }} aria-hidden>{role.icon}</span> : null}
                            <h3 className="text-sm font-semibold text-text-primary truncate">{role.name}</h3>
                            {role.permissions.includes('administrator') ? <RoleBadge label="Admin" tone="danger" /> : null}
                            {role.name === '@everyone' ? <RoleBadge label="Default" tone="muted" /> : null}
                            {role.displaySeparately ? <RoleBadge label="Member list" tone="muted" /> : null}
                          </div>
                          <p className="text-xs text-text-muted">
                            {role.memberCount} {role.memberCount === 1 ? 'member' : 'members'} - position {role.position}
                          </p>
                        </>
                      )}
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      {isEditing ? (
                        <>
                          <IconButton icon="check" label="Save role" disabled={isBusy} onClick={() => saveRole(role)} />
                          <IconButton icon="close" label="Cancel edit" disabled={isBusy} onClick={() => setEditingId(null)} />
                        </>
                      ) : (
                        <>
                          <IconButton icon="edit" label="Edit role" disabled={Boolean(editingId) || isBusy} onClick={() => beginEdit(role)} />
                          <IconButton
                            icon="delete"
                            label="Delete role"
                            danger
                            disabled={Boolean(editingId) || isBusy || role.name === '@everyone'}
                            onClick={() => deleteRole(role)}
                          />
                        </>
                      )}
                    </div>
                  </div>
                  {isEditing ? (
                    <>
                      <SeparateMembersToggle checked={draft.displaySeparately} onChange={(displaySeparately) => setDraft((current) => ({ ...current, displaySeparately }))} disabled={isBusy || role.name === '@everyone'} />
                      <PermissionMatrix selected={draft.permissions} onToggle={updateDraftPermission} />
                    </>
                  ) : (
                    <PermissionSummary permissions={role.permissions} />
                  )}
                </li>
              );
            })
          )}
        </ul>
      </div>
    </section>
  );
}

function SeparateMembersToggle({ checked, onChange, disabled }: { checked: boolean; onChange: (checked: boolean) => void; disabled: boolean }) {
  return (
    <label className="mt-4 flex items-center justify-between gap-4 rounded-md border border-border-subtle bg-surface-container px-3 py-2.5">
      <span>
        <span className="block text-sm font-medium text-text-primary">Display members separately</span>
        <span className="block text-xs text-text-muted">Group online members under this role in the member list.</span>
      </span>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} className="size-4 accent-primary" />
    </label>
  );
}

function RoleIconPicker({ value, onChange, disabled }: { value: string | null; onChange: (icon: string | null) => void; disabled: boolean }) {
  return (
    <div className="mt-3 flex flex-wrap items-center gap-1.5" aria-label="Role icon">
      <button type="button" disabled={disabled} onClick={() => onChange(null)} className={`grid size-8 place-items-center rounded-md border ${value === null ? 'border-primary bg-primary/10 text-primary' : 'border-border-subtle text-text-muted'}`} title="No icon">
        <span className="material-symbols-outlined text-[17px]" aria-hidden>block</span>
      </button>
      {ROLE_ICONS.map((icon) => (
        <button key={icon} type="button" disabled={disabled} onClick={() => onChange(icon)} className={`grid size-8 place-items-center rounded-md border ${value === icon ? 'border-primary bg-primary/10 text-primary' : 'border-border-subtle text-text-secondary hover:bg-surface-container'}`} title={icon.replaceAll('_', ' ')}>
          <span className="material-symbols-outlined text-[17px]" aria-hidden>{icon}</span>
        </button>
      ))}
    </div>
  );
}

function PermissionMatrix({
  selected,
  compact,
  onToggle,
}: {
  selected: string[];
  compact?: boolean;
  onToggle: (permission: string) => void;
}) {
  return (
    <div className={compact ? 'mt-4 grid gap-4 md:grid-cols-2' : 'grid gap-4 md:grid-cols-2'}>
      {PERMISSION_GROUPS.map((group) => (
        <div key={group.label}>
          <h4 className="mb-2 border-b border-border-subtle pb-1 text-[10px] uppercase tracking-wider text-text-muted">
            {group.label}
          </h4>
          <ul className="space-y-1">
            {group.permissions.map((permission) => {
              const granted = selected.includes(permission.key);
              return (
                <li key={permission.key}>
                  <button
                    type="button"
                    onClick={() => onToggle(permission.key)}
                    className="flex w-full items-center justify-between rounded-lg p-2 text-left hover:bg-surface-container"
                  >
                    <span className={`text-xs ${granted ? 'text-text-primary' : 'text-text-muted'}`}>
                      {permission.label}
                    </span>
                    <span
                      className={`flex h-5 w-9 items-center rounded-full px-0.5 transition-colors ${
                        granted ? 'justify-end bg-primary' : 'justify-start bg-surface-container-high'
                      }`}
                    >
                      <span className={`h-4 w-4 rounded-full ${granted ? 'bg-[#07101E]' : 'bg-text-muted'}`} />
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </div>
  );
}

function PermissionSummary({ permissions }: { permissions: string[] }) {
  return (
    <div className="grid gap-4 md:grid-cols-2">
      {PERMISSION_GROUPS.map((group) => (
        <div key={group.label}>
          <h4 className="mb-2 border-b border-border-subtle pb-1 text-[10px] uppercase tracking-wider text-text-muted">
            {group.label}
          </h4>
          <ul className="space-y-1">
            {group.permissions.map((permission) => {
              const granted = permissions.includes(permission.key);
              return (
                <li key={permission.key} className="flex items-center justify-between rounded-lg p-2">
                  <span className={`text-xs ${granted ? 'text-text-primary' : 'text-text-muted'}`}>
                    {permission.label}
                  </span>
                  <span
                    className={`flex h-5 w-9 items-center rounded-full px-0.5 transition-colors ${
                      granted ? 'justify-end bg-primary' : 'justify-start bg-surface-container-high'
                    }`}
                  >
                    <span className={`h-4 w-4 rounded-full ${granted ? 'bg-[#07101E]' : 'bg-text-muted'}`} />
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </div>
  );
}

function togglePermission(permissions: string[], permission: string) {
  return permissions.includes(permission)
    ? permissions.filter((item) => item !== permission)
    : [...permissions, permission];
}

function mergeMemberCounts(roles: Array<Omit<RoleView, 'memberCount'>>, current: RoleView[]) {
  const counts = new Map(current.map((role) => [role.id, role.memberCount]));
  return roles.map((role) => ({ ...role, memberCount: counts.get(role.id) ?? 0 }));
}

function Chip({ label, tone = 'muted' }: { label: string; tone?: 'muted' | 'primary' }) {
  const className =
    tone === 'primary'
      ? 'px-3 py-1 bg-primary/10 border border-primary/20 rounded-full text-primary text-xs font-medium'
      : 'px-3 py-1 bg-surface-raised border border-border-subtle rounded-full text-text-secondary text-xs font-medium';
  return <span className={className}>{label}</span>;
}

function RoleBadge({ label, tone }: { label: string; tone: 'muted' | 'danger' }) {
  const className =
    tone === 'danger'
      ? 'px-1.5 py-0.5 rounded text-[10px] font-semibold bg-danger/20 text-danger border border-danger/30 uppercase tracking-wide'
      : 'px-1.5 py-0.5 rounded text-[10px] font-semibold bg-surface-variant text-text-muted border border-border-subtle uppercase tracking-wide';
  return <span className={className}>{label}</span>;
}

function Alert({ tone, text }: { tone: 'success' | 'danger'; text: string }) {
  const className =
    tone === 'success'
      ? 'mb-4 rounded-lg border border-success/40 bg-success/10 p-4 text-sm text-success'
      : 'mb-4 rounded-lg border border-danger/40 bg-danger/10 p-4 text-sm text-danger';
  return <div className={className}>{text}</div>;
}

function IconButton({
  icon,
  label,
  disabled,
  danger,
  onClick,
}: {
  icon: string;
  label: string;
  disabled?: boolean;
  danger?: boolean;
  onClick: () => void;
}) {
  const className = danger
    ? 'inline-flex h-8 w-8 items-center justify-center rounded-lg border border-danger/30 text-danger transition-colors hover:bg-danger/10 disabled:cursor-not-allowed disabled:opacity-40'
    : 'inline-flex h-8 w-8 items-center justify-center rounded-lg border border-border-subtle text-text-secondary transition-colors hover:bg-surface-container hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-40';
  return (
    <button type="button" title={label} aria-label={label} disabled={disabled} onClick={onClick} className={className}>
      <span className="material-symbols-outlined text-[18px]">{icon}</span>
    </button>
  );
}
