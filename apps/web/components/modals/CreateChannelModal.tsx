'use client';

import { useState } from 'react';
import { Modal, ModalCancelButton, ModalPrimaryButton } from '../Modal';

export type ChannelType = 'text' | 'voice';
export type ChannelVisibility = 'public' | 'private';
export type UserLimit = 'none' | '5' | '10' | '25' | '50';

export interface CreateChannelInput {
  type: ChannelType;
  name: string;
  category: string;
  visibility: ChannelVisibility;
  userLimit: UserLimit;
  allowScreenShare: boolean;
  allowCamera: boolean;
  allowActivities: boolean;
  requirePushToTalk: boolean;
  startMuted: boolean;
}

export interface CreateChannelModalProps {
  open: boolean;
  onClose: () => void;
  onSave: (input: CreateChannelInput) => Promise<void>;
  /** Default channel type when opening. */
  defaultType?: ChannelType;
  categories?: string[];
}

const DEFAULT_CATEGORIES = ['Text Channels', 'Voice Channels'];

export function CreateChannelModal({
  open,
  onClose,
  onSave,
  defaultType = 'voice',
  categories = DEFAULT_CATEGORIES,
}: CreateChannelModalProps) {
  const [type, setType] = useState<ChannelType>(defaultType);
  const [name, setName] = useState('');
  const [category, setCategory] = useState(categories[1] ?? DEFAULT_CATEGORIES[1]);
  const [visibility, setVisibility] = useState<ChannelVisibility>('public');
  const [userLimit, setUserLimit] = useState<UserLimit>('none');
  const [allowScreenShare, setAllowScreenShare] = useState(true);
  const [allowCamera, setAllowCamera] = useState(true);
  const [allowActivities, setAllowActivities] = useState(true);
  const [requirePushToTalk, setRequirePushToTalk] = useState(false);
  const [startMuted, setStartMuted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const normalizedName = name.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-');
  const isValid = normalizedName.length >= 2 && normalizedName.length <= 32;
  const canSave = isValid && (type === 'text' || category.length > 0);

  function close() {
    if (saving) return;
    reset();
    onClose();
  }

  function reset() {
    setType(defaultType);
    setName('');
    setCategory(categories[1] ?? DEFAULT_CATEGORIES[1]);
    setVisibility('public');
    setUserLimit('none');
    setAllowScreenShare(true);
    setAllowCamera(true);
    setAllowActivities(true);
    setRequirePushToTalk(false);
    setStartMuted(false);
    setError(null);
  }

  async function save() {
    if (!canSave) return;
    setSaving(true);
    setError(null);
    try {
      await onSave({
        type,
        name: normalizedName,
        category,
        visibility,
        userLimit,
        allowScreenShare,
        allowCamera,
        allowActivities,
        requirePushToTalk,
        startMuted,
      });
      close();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={close}
      title="Create Channel"
      description="Add a new text channel or voice room to this community."
      size="md"
      footer={
        <>
          <ModalCancelButton onClick={close} disabled={saving} />
          <ModalPrimaryButton onClick={save} disabled={!canSave} loading={saving}>
            {type === 'voice' ? 'Create Voice Room' : 'Create Channel'}
          </ModalPrimaryButton>
        </>
      }
    >
      <div className="space-y-6">
        <div>
          <label className="text-xs uppercase tracking-wider text-text-muted mb-3 block">Channel Type</label>
          <div className="grid grid-cols-2 gap-3">
            <ChannelTypeCard
              type="text"
              icon="tag"
              title="Text Channel"
              description="Post images, GIFs, and opinions."
              selected={type === 'text'}
              onSelect={() => setType('text')}
            />
            <ChannelTypeCard
              type="voice"
              icon="volume_up"
              title="Voice Room"
              description="Hang out with voice and video."
              selected={type === 'voice'}
              onSelect={() => setType('voice')}
            />
          </div>
        </div>

        <div>
          <label className="text-xs uppercase tracking-wider text-text-muted mb-2 block">Room Name</label>
          <div className="relative">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted font-medium">
              {type === 'voice' ? '🔊' : '#'}
            </span>
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder={type === 'voice' ? 'strategy-room' : 'announcements'}
              className="w-full bg-surface-container border border-border-subtle rounded-lg py-2.5 pl-8 pr-4 text-text-primary focus:ring-1 focus:ring-primary focus:border-primary outline-none"
            />
          </div>
          {name.length > 0 && !isValid ? (
            <p className="text-xs text-danger mt-1">
              Use 2-32 characters: lowercase letters, numbers, dashes.
            </p>
          ) : null}
          {normalizedName && isValid ? (
            <p className="text-xs text-text-muted mt-1">
              Will be created as <span className="text-text-primary font-mono">{normalizedName}</span>
            </p>
          ) : null}
        </div>

        <div>
          <label className="text-xs uppercase tracking-wider text-text-muted mb-2 block">Category</label>
          <div className="relative">
            <select
              value={category}
              onChange={(event) => setCategory(event.target.value)}
              className="w-full appearance-none bg-surface-container border border-border-subtle rounded-lg px-4 py-2.5 text-text-primary pr-8 focus:ring-1 focus:ring-primary focus:border-primary outline-none"
            >
              {categories.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
            <span className="material-symbols-outlined text-text-secondary absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none">
              expand_more
            </span>
          </div>
        </div>

        <div>
          <label className="text-xs uppercase tracking-wider text-text-muted mb-3 block">Visibility</label>
          <div className="space-y-2">
            <VisibilityCard
              icon="public"
              label="Public"
              description="Everyone can view this channel"
              selected={visibility === 'public'}
              onSelect={() => setVisibility('public')}
            />
            <VisibilityCard
              icon="lock"
              label="Private"
              description="Only selected members and roles"
              note="Role access appears when Private is selected."
              selected={visibility === 'private'}
              onSelect={() => setVisibility('private')}
            />
          </div>
        </div>

        {type === 'voice' ? (
          <div className="space-y-1 pt-2">
            <div className="flex items-center justify-between py-2">
              <div>
                <span className="text-sm font-medium text-text-primary block">User limit</span>
                <span className="text-xs text-text-secondary">Limit the number of users in this room</span>
              </div>
              <div className="relative">
                <select
                  value={userLimit}
                  onChange={(event) => setUserLimit(event.target.value as UserLimit)}
                  className="appearance-none bg-surface-container border border-border-subtle rounded-lg px-3 py-1.5 text-sm text-text-primary pr-8 focus:ring-1 focus:ring-primary focus:border-primary outline-none"
                >
                  <option value="none">No limit</option>
                  <option value="5">5 users</option>
                  <option value="10">10 users</option>
                  <option value="25">25 users</option>
                  <option value="50">50 users</option>
                </select>
                <span className="material-symbols-outlined text-text-secondary text-[18px] absolute right-2 top-1/2 -translate-y-1/2 pointer-events-none">
                  expand_more
                </span>
              </div>
            </div>
            <ToggleRow
              label="Allow screen sharing"
              description="Members can share their screen"
              checked={allowScreenShare}
              onChange={setAllowScreenShare}
            />
            <ToggleRow
              label="Allow camera"
              description="Members can use their camera"
              checked={allowCamera}
              onChange={setAllowCamera}
            />
            <ToggleRow
              label="Allow activities"
              description="Members can start activities"
              checked={allowActivities}
              onChange={setAllowActivities}
            />
            <ToggleRow
              label="Require push to talk"
              description="Force members to use push to talk"
              checked={requirePushToTalk}
              onChange={setRequirePushToTalk}
            />
            <ToggleRow
              label="Start muted"
              description="Members join the room muted"
              checked={startMuted}
              onChange={setStartMuted}
              last
            />
            <p className="text-[11px] text-text-muted pt-2">
              These settings can be changed later from room settings.
            </p>
          </div>
        ) : null}

        {error ? (
          <p className="text-sm text-danger" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </Modal>
  );
}

function ChannelTypeCard({
  icon,
  title,
  description,
  selected,
  onSelect,
}: {
  type: ChannelType;
  icon: string;
  title: string;
  description: string;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={`p-4 rounded-xl border text-left flex flex-col gap-2 transition-colors ${
        selected
          ? 'border-primary bg-primary/5'
          : 'border-border-subtle hover:bg-surface-container'
      }`}
    >
      <span className={`material-symbols-outlined ${selected ? 'text-primary' : 'text-text-secondary'}`}>
        {icon}
      </span>
      <div>
        <p className="text-sm font-bold text-text-primary">{title}</p>
        <p className="text-xs text-text-secondary">{description}</p>
      </div>
    </button>
  );
}

function VisibilityCard({
  icon,
  label,
  description,
  note,
  selected,
  onSelect,
}: {
  icon: string;
  label: string;
  description: string;
  note?: string;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={`flex items-center justify-between w-full text-left p-3 rounded-lg border transition-colors ${
        selected
          ? 'bg-surface-container/50 border-primary/30'
          : 'border-border-subtle opacity-60 hover:opacity-100'
      }`}
    >
      <div className="flex items-center gap-3">
        <span className={`material-symbols-outlined ${selected ? 'text-text-primary' : 'text-text-secondary'}`}>
          {icon}
        </span>
        <div className="flex flex-col">
          <span className="text-sm font-medium text-text-primary">{label}</span>
          <span className="text-xs text-text-secondary">{description}</span>
          {note ? <span className="text-[10px] text-text-muted mt-0.5">{note}</span> : null}
        </div>
      </div>
      <span
        className={`w-5 h-5 rounded-full border-2 flex items-center justify-center ${
          selected ? 'border-primary' : 'border-border-subtle'
        }`}
      >
        {selected ? <span className="w-2.5 h-2.5 rounded-full bg-primary" /> : null}
      </span>
    </button>
  );
}

function ToggleRow({
  label,
  description,
  checked,
  onChange,
  last = false,
}: {
  label: string;
  description: string;
  checked: boolean;
  onChange: (value: boolean) => void;
  last?: boolean;
}) {
  return (
    <div
      className={`flex items-center justify-between py-2 ${last ? '' : 'border-b border-border-subtle'}`}
    >
      <div>
        <span className="text-sm font-medium text-text-primary block">{label}</span>
        <span className="text-xs text-text-secondary">{description}</span>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={`relative w-10 h-5 rounded-full transition-colors flex-shrink-0 ${
          checked ? 'bg-primary' : 'bg-surface-container border border-border-subtle'
        }`}
      >
        <span
          className={`absolute top-0.5 w-4 h-4 rounded-full transition-all ${
            checked ? 'right-0.5 bg-on-primary-container' : 'left-0.5 bg-text-muted'
          }`}
        />
      </button>
    </div>
  );
}
