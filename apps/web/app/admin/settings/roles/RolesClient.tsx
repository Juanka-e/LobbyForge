'use client';

import { useMemo, useState } from 'react';
import { useT } from '@/lib/i18n/client';
import { ROLE_ICONS, type RoleIcon } from '@/lib/role-icons';

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

/**
 * `key` is the stored permission flag (never translated); `labelKey` is
 * the message key for what the admin reads, resolved with `t` where it
 * renders.
 */
interface PermissionGroup {
  labelKey: string;
  permissions: { key: string; labelKey: string }[];
}

const PERMISSION_GROUPS: PermissionGroup[] = [
  {
    labelKey: 'adminSettings.roles.group.general',
    permissions: [
      { key: 'administrator', labelKey: 'adminSettings.roles.perm.administrator' },
      { key: 'manage_server', labelKey: 'adminSettings.roles.perm.manageServer' },
      { key: 'manage_roles', labelKey: 'adminSettings.roles.perm.manageRoles' },
      { key: 'manage_channels', labelKey: 'adminSettings.roles.perm.manageChannels' },
      { key: 'view_audit_log', labelKey: 'adminSettings.roles.perm.viewAuditLog' },
    ],
  },
  {
    labelKey: 'adminSettings.roles.group.members',
    permissions: [
      { key: 'create_invite', labelKey: 'adminSettings.roles.perm.createInvite' },
      { key: 'kick_members', labelKey: 'adminSettings.roles.perm.kickMembers' },
      { key: 'ban_members', labelKey: 'adminSettings.roles.perm.banMembers' },
      { key: 'moderate_members', labelKey: 'adminSettings.roles.perm.moderateMembers' },
    ],
  },
  {
    labelKey: 'adminSettings.roles.group.text',
    permissions: [
      { key: 'send_messages', labelKey: 'adminSettings.roles.perm.sendMessages' },
      { key: 'read_message_history', labelKey: 'adminSettings.roles.perm.readMessageHistory' },
      { key: 'mention_everyone', labelKey: 'adminSettings.roles.perm.mentionEveryone' },
      { key: 'manage_messages', labelKey: 'adminSettings.roles.perm.manageMessages' },
      // NOTE: 'add_reactions' intentionally hidden — the reactions
      // feature has no API yet; a visible no-op toggle misleads admins.
    ],
  },
  {
    labelKey: 'adminSettings.roles.group.voice',
    permissions: [
      { key: 'connect_voice', labelKey: 'adminSettings.roles.perm.connectVoice' },
      { key: 'speak', labelKey: 'adminSettings.roles.perm.speak' },
      { key: 'stream', labelKey: 'adminSettings.roles.perm.stream' },
      { key: 'mute_members', labelKey: 'adminSettings.roles.perm.muteMembers' },
      // NOTE: 'deafen_members' hidden — no deafen-others endpoint exists
      // (self-deafen is a local client preference, permission-free).
    ],
  },
  {
    labelKey: 'adminSettings.roles.group.activities',
    permissions: [{ key: 'start_activity', labelKey: 'adminSettings.roles.perm.startActivity' }],
  },
];

/**
 * What each built-in role icon is called in the picker. The icon value
 * itself is a Material Symbols ligature and is stored as-is; only the
 * name the admin reads is translated.
 */
const ROLE_ICON_LABEL_KEYS: Record<RoleIcon, string> = {
  shield: 'adminSettings.roles.icon.shield',
  verified: 'adminSettings.roles.icon.verified',
  star: 'adminSettings.roles.icon.star',
  crown: 'adminSettings.roles.icon.crown',
  sports_esports: 'adminSettings.roles.icon.sportsEsports',
  music_note: 'adminSettings.roles.icon.musicNote',
  groups: 'adminSettings.roles.icon.groups',
  palette: 'adminSettings.roles.icon.palette',
};

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
  const t = useT();
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
    if (!response.ok || !data.roles) throw new Error(data.error ?? t('adminSettings.roles.reloadFailed'));
    setRoles((current) => mergeMemberCounts(data.roles ?? [], current));
  }

  async function createRole() {
    if (!serverId || isCreating) return;
    const name = form.name.trim();
    if (name.length === 0) {
      setMessage({ tone: 'danger', text: t('adminSettings.roles.nameRequired') });
      return;
    }
    if (form.permissions.includes('administrator') && !window.confirm(t('adminSettings.roles.confirmAdminCreate'))) {
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
      if (!response.ok || !data.role) throw new Error(data.error ?? t('adminSettings.roles.createFailed'));
      setRoles((current) => [...current, { ...data.role!, memberCount: 0 }]);
      setForm(EMPTY_FORM);
      setMessage({ tone: 'success', text: t('adminSettings.roles.created') });
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
      setMessage({ tone: 'danger', text: t('adminSettings.roles.nameRequired') });
      return;
    }
    const adminWasAdded = !role.permissions.includes('administrator') && draft.permissions.includes('administrator');
    if (adminWasAdded && !window.confirm(t('adminSettings.roles.confirmAdminGrant'))) {
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
      if (!response.ok || !data.role) throw new Error(data.error ?? t('adminSettings.roles.updateFailed'));
      setRoles((current) =>
        current.map((item) => (item.id === role.id ? { ...data.role!, memberCount: item.memberCount } : item))
      );
      setEditingId(null);
      setMessage({ tone: 'success', text: t('adminSettings.roles.updated') });
    } catch (err) {
      setMessage({ tone: 'danger', text: (err as Error).message });
    } finally {
      setBusyId(null);
    }
  }

  async function deleteRole(role: RoleView) {
    if (!serverId || busyId || role.name === '@everyone') return;
    if (!window.confirm(t('adminSettings.roles.confirmDelete', { name: role.name }))) return;
    setBusyId(role.id);
    setMessage(null);
    try {
      const response = await fetch(
        `/api/servers/${encodeURIComponent(serverId)}/roles/${encodeURIComponent(role.id)}`,
        { method: 'DELETE' }
      );
      const data = (await response.json().catch(() => ({}))) as ApiRoleResponse;
      if (!response.ok) throw new Error(data.error ?? t('adminSettings.roles.deleteFailed'));
      setRoles((current) => current.filter((item) => item.id !== role.id));
      setMessage({ tone: 'success', text: t('adminSettings.roles.deleted') });
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
        <h1 className="text-2xl font-semibold text-text-primary">{t('adminSettings.roles.title')}</h1>
        <p className="mt-1 text-sm text-text-secondary">{t('adminSettings.roles.subtitle')}</p>
      </header>

      <div className="flex flex-wrap gap-2 mb-6">
        <Chip label={t('adminSettings.roles.count', { count: sortedRoles.length })} />
        <Chip label={t('adminSettings.roles.adminCount', { count: adminRoles })} tone="primary" />
      </div>

      {loadError ? <Alert tone="danger" text={t('adminSettings.roles.loadError', { error: loadError })} /> : null}
      {!serverId ? <Alert tone="danger" text={t('adminSettings.common.noServer')} /> : null}
      {message ? <Alert tone={message.tone} text={message.text} /> : null}

      <div className="mb-8 rounded-xl border border-border-subtle bg-surface p-4">
        <h2 className="mb-4 text-sm font-semibold text-text-primary">{t('adminSettings.roles.createTitle')}</h2>
        <div className="grid gap-3 md:grid-cols-[1fr_140px_auto]">
          <label className="block">
            <span className="sr-only">{t('adminSettings.roles.nameLabel')}</span>
            <input
              value={form.name}
              onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))}
              placeholder={t('adminSettings.roles.namePlaceholder')}
              maxLength={64}
              disabled={!serverId || isCreating}
              className="w-full rounded-lg border border-border-subtle bg-surface-container px-3 py-2 text-sm text-text-primary placeholder-text-muted focus:outline-none focus:ring-1 focus:ring-primary-container"
            />
          </label>
          <label className="flex items-center gap-2 rounded-lg border border-border-subtle bg-surface-container px-3 py-2">
            <span className="sr-only">{t('adminSettings.roles.colorLabel')}</span>
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
            {isCreating ? t('adminSettings.common.creating') : t('adminSettings.common.create')}
          </button>
        </div>
        <RoleIconPicker value={form.icon} onChange={(icon) => setForm((current) => ({ ...current, icon }))} disabled={!serverId || isCreating} />
        <SeparateMembersToggle checked={form.displaySeparately} onChange={(displaySeparately) => setForm((current) => ({ ...current, displaySeparately }))} disabled={!serverId || isCreating} />
        <PermissionMatrix selected={form.permissions} onToggle={updateFormPermission} compact />
      </div>

      <div className="bg-surface rounded-xl border border-border-subtle overflow-hidden">
        <ul className="divide-y divide-border-subtle">
          {sortedRoles.length === 0 ? (
            <li className="p-6 text-sm text-text-muted text-center">{t('adminSettings.roles.empty')}</li>
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
                            <span className="sr-only">{t('adminSettings.roles.colorLabel')}</span>
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
                            aria-label={t('adminSettings.roles.iconLabel')}
                            className="w-full rounded-lg border border-border-subtle bg-surface-container px-3 py-2 text-sm text-text-primary"
                          >
                            <option value="">{t('adminSettings.roles.noIcon')}</option>
                            {ROLE_ICONS.map((icon) => (
                              <option key={icon} value={icon}>
                                {t(ROLE_ICON_LABEL_KEYS[icon])}
                              </option>
                            ))}
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
                            aria-label={t('adminSettings.roles.positionLabel')}
                          />
                        </div>
                      ) : (
                        <>
                          <div className="flex flex-wrap items-center gap-2">
                            {role.icon ? <span className="material-symbols-outlined text-[17px]" style={{ color: role.color ?? undefined }} aria-hidden>{role.icon}</span> : null}
                            <h3 className="text-sm font-semibold text-text-primary truncate">{role.name}</h3>
                            {role.permissions.includes('administrator') ? (
                              <RoleBadge label={t('adminSettings.roles.badge.admin')} tone="danger" />
                            ) : null}
                            {role.name === '@everyone' ? (
                              <RoleBadge label={t('adminSettings.roles.badge.default')} tone="muted" />
                            ) : null}
                            {role.displaySeparately ? (
                              <RoleBadge label={t('adminSettings.roles.badge.memberList')} tone="muted" />
                            ) : null}
                          </div>
                          <p className="text-xs text-text-muted">
                            {t('adminSettings.roles.memberLine', { count: role.memberCount, position: role.position })}
                          </p>
                        </>
                      )}
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      {isEditing ? (
                        <>
                          <IconButton
                            icon="check"
                            label={t('adminSettings.roles.save')}
                            disabled={isBusy}
                            onClick={() => saveRole(role)}
                          />
                          <IconButton
                            icon="close"
                            label={t('adminSettings.common.cancelEdit')}
                            disabled={isBusy}
                            onClick={() => setEditingId(null)}
                          />
                        </>
                      ) : (
                        <>
                          <IconButton
                            icon="edit"
                            label={t('adminSettings.roles.edit')}
                            disabled={Boolean(editingId) || isBusy}
                            onClick={() => beginEdit(role)}
                          />
                          <IconButton
                            icon="delete"
                            label={t('adminSettings.roles.delete')}
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
  const t = useT();
  return (
    <label className="mt-4 flex items-center justify-between gap-4 rounded-md border border-border-subtle bg-surface-container px-3 py-2.5">
      <span>
        <span className="block text-sm font-medium text-text-primary">{t('adminSettings.roles.separate.title')}</span>
        <span className="block text-xs text-text-muted">{t('adminSettings.roles.separate.description')}</span>
      </span>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} className="size-4 accent-primary" />
    </label>
  );
}

function RoleIconPicker({ value, onChange, disabled }: { value: string | null; onChange: (icon: string | null) => void; disabled: boolean }) {
  const t = useT();
  return (
    <div className="mt-3 flex flex-wrap items-center gap-1.5" aria-label={t('adminSettings.roles.iconLabel')}>
      <button type="button" disabled={disabled} onClick={() => onChange(null)} className={`grid size-8 place-items-center rounded-md border ${value === null ? 'border-primary bg-primary/10 text-primary' : 'border-border-subtle text-text-muted'}`} title={t('adminSettings.roles.noIcon')}>
        <span className="material-symbols-outlined text-[17px]" aria-hidden>block</span>
      </button>
      {ROLE_ICONS.map((icon) => (
        <button key={icon} type="button" disabled={disabled} onClick={() => onChange(icon)} className={`grid size-8 place-items-center rounded-md border ${value === icon ? 'border-primary bg-primary/10 text-primary' : 'border-border-subtle text-text-secondary hover:bg-surface-container'}`} title={t(ROLE_ICON_LABEL_KEYS[icon])}>
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
  const t = useT();
  return (
    <div className={compact ? 'mt-4 grid gap-4 md:grid-cols-2' : 'grid gap-4 md:grid-cols-2'}>
      {PERMISSION_GROUPS.map((group) => (
        <div key={group.labelKey}>
          <h4 className="mb-2 border-b border-border-subtle pb-1 text-[10px] uppercase tracking-wider text-text-muted">
            {t(group.labelKey)}
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
                      {t(permission.labelKey)}
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
  const t = useT();
  return (
    <div className="grid gap-4 md:grid-cols-2">
      {PERMISSION_GROUPS.map((group) => (
        <div key={group.labelKey}>
          <h4 className="mb-2 border-b border-border-subtle pb-1 text-[10px] uppercase tracking-wider text-text-muted">
            {t(group.labelKey)}
          </h4>
          <ul className="space-y-1">
            {group.permissions.map((permission) => {
              const granted = permissions.includes(permission.key);
              return (
                <li key={permission.key} className="flex items-center justify-between rounded-lg p-2">
                  <span className={`text-xs ${granted ? 'text-text-primary' : 'text-text-muted'}`}>
                    {t(permission.labelKey)}
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
