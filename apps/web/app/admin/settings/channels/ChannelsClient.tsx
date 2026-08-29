'use client';

import { useMemo, useState } from 'react';

type ChannelType = 'text' | 'voice' | 'activity' | 'announcement' | 'stage';

export interface ChannelView {
  id: string;
  serverId: string;
  name: string;
  type: ChannelType;
  position: number;
  pluginId: string | null;
  topic: string | null;
  createdAt: string;
  /** Role ids that can see this channel; null = inherited (unknown). */
  visibleToRoleIds?: string[] | null;
}

export interface RoleBrief {
  id: string;
  name: string;
  position: number;
}

interface ApiChannelResponse {
  channels?: ChannelView[];
  channel?: ChannelView;
  error?: string;
}

const CHANNEL_TYPES: Array<{ value: ChannelType; label: string; icon: string }> = [
  { value: 'text', label: 'Text', icon: 'tag' },
  { value: 'voice', label: 'Voice', icon: 'volume_up' },
  { value: 'announcement', label: 'Announcement', icon: 'campaign' },
  { value: 'stage', label: 'Stage', icon: 'podiums' },
  { value: 'activity', label: 'Activity', icon: 'sports_esports' },
];

const EMPTY_FORM = { name: '', type: 'text' as ChannelType, topic: '' };

export default function ChannelsClient({
  serverId,
  initialChannels,
  roles,
  loadError,
}: {
  serverId: string | null;
  initialChannels: ChannelView[];
  roles: RoleBrief[];
  loadError: string | null;
}) {
  const [channels, setChannels] = useState(initialChannels);
  const [form, setForm] = useState(EMPTY_FORM);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<{ name: string; topic: string; roleIds: string[] }>({
    name: '',
    topic: '',
    roleIds: [],
  });
  const [busyId, setBusyId] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [message, setMessage] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);

  const sortedChannels = useMemo(
    () => [...channels].sort((a, b) => a.position - b.position || a.name.localeCompare(b.name)),
    [channels]
  );
  const text = sortedChannels.filter((c) => c.type === 'text' || c.type === 'announcement');
  const voice = sortedChannels.filter((c) => c.type === 'voice' || c.type === 'stage');
  const activity = sortedChannels.filter((c) => c.type === 'activity');

  async function refreshChannels() {
    if (!serverId) return;
    const response = await fetch(`/api/servers/${encodeURIComponent(serverId)}/channels`, {
      method: 'GET',
      cache: 'no-store',
    });
    const data = (await response.json().catch(() => ({}))) as ApiChannelResponse;
    if (!response.ok || !data.channels) {
      throw new Error(data.error ?? 'Could not reload channels');
    }
    setChannels(data.channels);
  }

  async function createChannel() {
    if (!serverId || isCreating) return;
    const name = form.name.trim();
    if (name.length < 2) {
      setMessage({ tone: 'danger', text: 'Channel name must be at least 2 characters.' });
      return;
    }
    setIsCreating(true);
    setMessage(null);
    try {
      const response = await fetch(`/api/servers/${encodeURIComponent(serverId)}/channels`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          type: form.type,
          topic: form.topic.trim() || undefined,
        }),
      });
      const data = (await response.json().catch(() => ({}))) as ApiChannelResponse;
      if (!response.ok || !data.channel) throw new Error(data.error ?? 'Could not create channel');
      await refreshChannels();
      setForm(EMPTY_FORM);
      setMessage({ tone: 'success', text: 'Channel created.' });
    } catch (err) {
      setMessage({ tone: 'danger', text: (err as Error).message });
    } finally {
      setIsCreating(false);
    }
  }

  function beginEdit(channel: ChannelView) {
    setEditingId(channel.id);
    setEditDraft({
      name: channel.name,
      topic: channel.topic ?? '',
      roleIds: channel.visibleToRoleIds ?? [],
    });
    setMessage(null);
  }

  /** undefined = inherited; [] would mean "hidden from everyone". */
  function toggleDraftRole(roleId: string) {
    setEditDraft((d) => ({
      ...d,
      roleIds: d.roleIds.includes(roleId)
        ? d.roleIds.filter((r) => r !== roleId)
        : [...d.roleIds, roleId],
    }));
  }

  async function saveEdit(channel: ChannelView) {
    if (!serverId || busyId) return;
    const name = editDraft.name.trim();
    if (name.length < 2) {
      setMessage({ tone: 'danger', text: 'Channel name must be at least 2 characters.' });
      return;
    }
    setBusyId(channel.id);
    setMessage(null);
    try {
      const response = await fetch(
        `/api/servers/${encodeURIComponent(serverId)}/channels/${encodeURIComponent(channel.id)}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name,
            topic: editDraft.topic.trim() || null,
            visibleToRoleIds: editDraft.roleIds,
          }),
        }
      );
      const data = (await response.json().catch(() => ({}))) as ApiChannelResponse;
      if (!response.ok || !data.channel) throw new Error(data.error ?? 'Could not update channel');
      await refreshChannels();
      setEditingId(null);
      setMessage({ tone: 'success', text: 'Channel updated.' });
    } catch (err) {
      setMessage({ tone: 'danger', text: (err as Error).message });
    } finally {
      setBusyId(null);
    }
  }

  async function moveChannel(channel: ChannelView, direction: -1 | 1) {
    if (!serverId || busyId) return;
    const currentIndex = sortedChannels.findIndex((item) => item.id === channel.id);
    const target = sortedChannels[currentIndex + direction];
    if (!target) return;
    setBusyId(channel.id);
    setMessage(null);
    try {
      const response = await fetch(
        `/api/servers/${encodeURIComponent(serverId)}/channels/${encodeURIComponent(channel.id)}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ position: target.position }),
        }
      );
      const data = (await response.json().catch(() => ({}))) as ApiChannelResponse;
      if (!response.ok || !data.channel) throw new Error(data.error ?? 'Could not reorder channel');
      await refreshChannels();
    } catch (err) {
      setMessage({ tone: 'danger', text: (err as Error).message });
    } finally {
      setBusyId(null);
    }
  }

  async function deleteChannel(channel: ChannelView) {
    if (!serverId || busyId) return;
    if (!window.confirm(`Delete #${channel.name}? This cannot be undone.`)) return;
    setBusyId(channel.id);
    setMessage(null);
    try {
      const response = await fetch(
        `/api/servers/${encodeURIComponent(serverId)}/channels/${encodeURIComponent(channel.id)}`,
        { method: 'DELETE' }
      );
      const data = (await response.json().catch(() => ({}))) as ApiChannelResponse;
      if (!response.ok) throw new Error(data.error ?? 'Could not delete channel');
      await refreshChannels();
      setMessage({ tone: 'success', text: 'Channel deleted.' });
    } catch (err) {
      setMessage({ tone: 'danger', text: (err as Error).message });
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section className="max-w-4xl mx-auto pb-32">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold text-text-primary">Channels</h1>
        <p className="mt-1 text-sm text-text-secondary">
          Manage text channels, voice rooms, and the order members see in the lobby.
        </p>
      </header>

      <div className="flex flex-wrap gap-2 mb-6">
        <Chip icon="tag" label={`${text.length} text channels`} />
        <Chip icon="volume_up" label={`${voice.length} voice rooms`} />
        {activity.length > 0 ? (
          <Chip icon="sports_esports" label={`${activity.length} activity rooms`} />
        ) : null}
      </div>

      {loadError ? (
        <Alert tone="danger" text={`Could not load channels: ${loadError}`} />
      ) : null}
      {!serverId ? <Alert tone="danger" text="No server is available for this admin account." /> : null}
      {message ? <Alert tone={message.tone} text={message.text} /> : null}

      <div className="mb-8 rounded-xl border border-border-subtle bg-surface p-4">
        <h2 className="mb-4 text-sm font-semibold text-text-primary">Create Channel</h2>
        <div className="grid gap-3 md:grid-cols-[1fr_180px]">
          <label className="block">
            <span className="sr-only">Channel name</span>
            <input
              value={form.name}
              onChange={(event) => setForm((next) => ({ ...next, name: event.target.value }))}
              placeholder="general"
              maxLength={64}
              disabled={!serverId || isCreating}
              className="w-full rounded-lg border border-border-subtle bg-surface-container px-3 py-2 text-sm text-text-primary placeholder-text-muted focus:outline-none focus:ring-1 focus:ring-primary-container"
            />
          </label>
          <label className="block">
            <span className="sr-only">Channel type</span>
            <select
              value={form.type}
              onChange={(event) => setForm((next) => ({ ...next, type: event.target.value as ChannelType }))}
              disabled={!serverId || isCreating}
              className="w-full rounded-lg border border-border-subtle bg-surface-container px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-primary-container"
            >
              {CHANNEL_TYPES.map((type) => (
                <option key={type.value} value={type.value}>
                  {type.label}
                </option>
              ))}
            </select>
          </label>
          <label className="md:col-span-2 block">
            <span className="sr-only">Channel topic</span>
            <textarea
              value={form.topic}
              onChange={(event) => setForm((next) => ({ ...next, topic: event.target.value }))}
              placeholder="Optional topic"
              maxLength={512}
              rows={2}
              disabled={!serverId || isCreating}
              className="w-full resize-none rounded-lg border border-border-subtle bg-surface-container px-3 py-2 text-sm text-text-primary placeholder-text-muted focus:outline-none focus:ring-1 focus:ring-primary-container"
            />
          </label>
        </div>
        <div className="mt-4 flex justify-end">
          <button
            type="button"
            onClick={createChannel}
            disabled={!serverId || isCreating}
            className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-on-primary disabled:cursor-not-allowed disabled:opacity-50"
          >
            <span className="material-symbols-outlined text-[18px]">add</span>
            {isCreating ? 'Creating...' : 'Create'}
          </button>
        </div>
      </div>

      <div className="space-y-8">
        <ChannelGroup
          title="Text Channels"
          empty="No text channels yet."
          channels={text}
          allChannels={sortedChannels}
          editingId={editingId}
          editDraft={editDraft}
          busyId={busyId}
          roles={roles}
          onDraftChange={setEditDraft}
          onToggleRole={toggleDraftRole}
          onBeginEdit={beginEdit}
          onCancelEdit={() => setEditingId(null)}
          onSaveEdit={saveEdit}
          onMove={moveChannel}
          onDelete={deleteChannel}
        />
        <ChannelGroup
          title="Voice Channels"
          empty="No voice rooms yet."
          channels={voice}
          allChannels={sortedChannels}
          editingId={editingId}
          editDraft={editDraft}
          busyId={busyId}
          roles={roles}
          onDraftChange={setEditDraft}
          onToggleRole={toggleDraftRole}
          onBeginEdit={beginEdit}
          onCancelEdit={() => setEditingId(null)}
          onSaveEdit={saveEdit}
          onMove={moveChannel}
          onDelete={deleteChannel}
        />
        {activity.length > 0 ? (
          <ChannelGroup
            title="Activity Rooms"
            empty=""
            channels={activity}
            allChannels={sortedChannels}
            editingId={editingId}
            editDraft={editDraft}
            busyId={busyId}
            roles={roles}
            onDraftChange={setEditDraft}
            onToggleRole={toggleDraftRole}
            onBeginEdit={beginEdit}
            onCancelEdit={() => setEditingId(null)}
            onSaveEdit={saveEdit}
            onMove={moveChannel}
            onDelete={deleteChannel}
          />
        ) : null}
      </div>
    </section>
  );
}

function ChannelGroup({
  title,
  channels,
  allChannels,
  empty,
  editingId,
  editDraft,
  busyId,
  roles,
  onDraftChange,
  onToggleRole,
  onBeginEdit,
  onCancelEdit,
  onSaveEdit,
  onMove,
  onDelete,
}: {
  title: string;
  channels: ChannelView[];
  allChannels: ChannelView[];
  empty: string;
  editingId: string | null;
  roles: RoleBrief[];
  editDraft: { name: string; topic: string; roleIds: string[] };
  busyId: string | null;
  onDraftChange: (draft: { name: string; topic: string; roleIds: string[] }) => void;
  onToggleRole: (roleId: string) => void;
  onBeginEdit: (channel: ChannelView) => void;
  onCancelEdit: () => void;
  onSaveEdit: (channel: ChannelView) => void;
  onMove: (channel: ChannelView, direction: -1 | 1) => void;
  onDelete: (channel: ChannelView) => void;
}) {
  return (
    <div>
      <div className="flex items-center gap-2 mb-3 px-2 text-text-muted">
        <span className="material-symbols-outlined text-[20px]">chevron_right</span>
        <h2 className="text-xs uppercase tracking-wider font-semibold">{title}</h2>
        <div className="h-px bg-border-subtle flex-1 ml-4" />
      </div>
      {channels.length === 0 ? (
        <p className="px-6 py-4 text-sm text-text-muted rounded-xl bg-surface border border-border-subtle">
          {empty}
        </p>
      ) : (
        <ul className="space-y-2">
          {channels.map((channel) => {
            const isEditing = editingId === channel.id;
            const isBusy = busyId === channel.id;
            const index = allChannels.findIndex((item) => item.id === channel.id);
            return (
              <li
                key={channel.id}
                className="rounded-xl bg-surface border border-border-subtle p-3 transition-colors hover:border-border-strong"
              >
                <div className="flex items-start gap-4">
                  <div className="flex flex-col gap-1">
                    <IconButton
                      icon="keyboard_arrow_up"
                      label="Move up"
                      disabled={index <= 0 || isBusy}
                      onClick={() => onMove(channel, -1)}
                    />
                    <IconButton
                      icon="keyboard_arrow_down"
                      label="Move down"
                      disabled={index < 0 || index >= allChannels.length - 1 || isBusy}
                      onClick={() => onMove(channel, 1)}
                    />
                  </div>
                  <div className="w-9 h-9 rounded bg-surface-container flex shrink-0 items-center justify-center text-text-muted">
                    <span className="material-symbols-outlined text-[20px]">{iconForType(channel.type)}</span>
                  </div>
                  <div className="min-w-0 flex-1">
                    {isEditing ? (
                      <div className="space-y-3">
                        <input
                          value={editDraft.name}
                          onChange={(event) => onDraftChange({ ...editDraft, name: event.target.value })}
                          maxLength={64}
                          className="w-full rounded-lg border border-border-subtle bg-surface-container px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-primary-container"
                        />
                        <textarea
                          value={editDraft.topic}
                          onChange={(event) => onDraftChange({ ...editDraft, topic: event.target.value })}
                          maxLength={512}
                          rows={2}
                          className="w-full resize-none rounded-lg border border-border-subtle bg-surface-container px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-primary-container"
                        />
                        <div>
                          <p className="text-xs text-text-muted mb-1.5">
                            Visible to roles — leave empty for everyone (private channel when roles are selected)
                          </p>
                          <div className="flex flex-wrap gap-1.5">
                            {roles.map((role) => {
                              const selected = editDraft.roleIds.includes(role.id);
                              return (
                                <button
                                  key={role.id}
                                  type="button"
                                  onClick={() => onToggleRole(role.id)}
                                  className={`rounded-full border px-2.5 py-1 text-xs transition-colors ${
                                    selected
                                      ? 'border-primary bg-primary/15 text-text-primary font-medium'
                                      : 'border-border-subtle bg-surface-container text-text-secondary hover:bg-surface-raised'
                                  }`}
                                >
                                  {role.name}
                                </button>
                              );
                            })}
                            {roles.length === 0 ? (
                              <span className="text-xs text-text-muted">No roles to restrict with yet.</span>
                            ) : null}
                          </div>
                        </div>
                      </div>
                    ) : (
                      <>
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-sm text-text-primary font-medium truncate">{channel.name}</span>
                          <TypeBadge type={channel.type} />
                          {channel.visibleToRoleIds && channel.visibleToRoleIds.length > 0 ? (
                            <span className="px-1.5 py-0.5 rounded text-[10px] bg-secondary-container/20 text-text-secondary border border-border-strong font-medium tracking-wide">
                              🔒 {channel.visibleToRoleIds.length} role{channel.visibleToRoleIds.length > 1 ? 's' : ''}
                            </span>
                          ) : null}
                        </div>
                        {channel.topic ? (
                          <p className="text-xs text-text-muted mt-0.5 break-words">{channel.topic}</p>
                        ) : (
                          <p className="text-xs text-text-muted mt-0.5">No topic set.</p>
                        )}
                      </>
                    )}
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    {isEditing ? (
                      <>
                        <IconButton icon="check" label="Save channel" disabled={isBusy} onClick={() => onSaveEdit(channel)} />
                        <IconButton icon="close" label="Cancel edit" disabled={isBusy} onClick={onCancelEdit} />
                      </>
                    ) : (
                      <>
                        <IconButton icon="edit" label="Edit channel" disabled={Boolean(editingId) || isBusy} onClick={() => onBeginEdit(channel)} />
                        <IconButton icon="delete" label="Delete channel" danger disabled={Boolean(editingId) || isBusy} onClick={() => onDelete(channel)} />
                      </>
                    )}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function TypeBadge({ type }: { type: ChannelType }) {
  const isVoice = type === 'voice' || type === 'stage';
  const className = isVoice
    ? 'px-1.5 py-0.5 rounded text-[10px] bg-surface-bright text-text-secondary border border-border-strong font-medium tracking-wide'
    : 'px-1.5 py-0.5 rounded text-[10px] bg-primary-container/10 text-primary border border-primary-container/20 font-medium tracking-wide';
  return <span className={className}>{type.toUpperCase()}</span>;
}

function Chip({ icon, label }: { icon: string; label: string }) {
  return (
    <span className="px-3 py-1.5 rounded-full bg-surface border border-border-subtle flex items-center gap-2 text-xs text-text-secondary">
      <span className="material-symbols-outlined text-[16px] text-text-muted">{icon}</span>
      {label}
    </span>
  );
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

function iconForType(type: ChannelType) {
  return CHANNEL_TYPES.find((item) => item.value === type)?.icon ?? 'tag';
}
