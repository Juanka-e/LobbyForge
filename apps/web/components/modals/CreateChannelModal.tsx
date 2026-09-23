'use client';

import { useState } from 'react';
import { Modal, ModalCancelButton, ModalPrimaryButton } from '../Modal';
import { useT } from '@/lib/i18n/client';
import { rich } from '@/lib/i18n/rich';

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

/**
 * The built-in categories are values the caller receives, so they stay
 * as they are; only what the picker SHOWS for them is translated. A
 * caller's own categories are data and render untouched.
 */
const DEFAULT_CATEGORY_LABEL_KEYS: Record<string, string> = {
  'Text Channels': 'shell.createChannel.categoryText',
  'Voice Channels': 'shell.createChannel.categoryVoice',
};

const USER_LIMITS: Exclude<UserLimit, 'none'>[] = ['5', '10', '25', '50'];

export function CreateChannelModal({
  open,
  onClose,
  onSave,
  defaultType = 'voice',
  categories = DEFAULT_CATEGORIES,
}: CreateChannelModalProps) {
  const t = useT();
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
  const usingDefaultCategories = categories === DEFAULT_CATEGORIES;
  // "Will be created as {name}": the name is styled, and word order
  // differs between languages, so split the whole phrase around it.

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
      title={t('shell.createChannel.title')}
      description={t('shell.createChannel.description')}
      size="md"
      footer={
        <>
          <ModalCancelButton onClick={close} disabled={saving} />
          <ModalPrimaryButton onClick={save} disabled={!canSave} loading={saving}>
            {type === 'voice' ? t('shell.createChannel.submitVoice') : t('shell.createChannel.title')}
          </ModalPrimaryButton>
        </>
      }
    >
      <div className="space-y-6">
        <div>
          <label className="text-xs uppercase tracking-wider text-text-muted mb-3 block">{t('shell.createChannel.type')}</label>
          <div className="grid grid-cols-2 gap-3">
            <ChannelTypeCard
              type="text"
              icon="tag"
              title={t('shell.createChannel.textTitle')}
              description={t('shell.createChannel.textDescription')}
              selected={type === 'text'}
              onSelect={() => setType('text')}
            />
            <ChannelTypeCard
              type="voice"
              icon="volume_up"
              title={t('shell.createChannel.voiceTitle')}
              description={t('shell.createChannel.voiceDescription')}
              selected={type === 'voice'}
              onSelect={() => setType('voice')}
            />
          </div>
        </div>

        <div>
          <label className="text-xs uppercase tracking-wider text-text-muted mb-2 block">{t('shell.createChannel.name')}</label>
          <div className="relative">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted font-medium">
              {type === 'voice' ? '🔊' : '#'}
            </span>
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder={
                type === 'voice'
                  ? t('shell.createChannel.namePlaceholderVoice')
                  : t('shell.createChannel.namePlaceholderText')
              }
              className="w-full bg-surface-container border border-border-subtle rounded-lg py-2.5 pl-8 pr-4 text-text-primary focus:ring-1 focus:ring-primary focus:border-primary outline-none"
            />
          </div>
          {name.length > 0 && !isValid ? (
            <p className="text-xs text-danger mt-1">
              {t('shell.createChannel.nameInvalid')}
            </p>
          ) : null}
          {normalizedName && isValid ? (
            <p className="text-xs text-text-muted mt-1">
              {rich(t('shell.createChannel.createdAs'), { name: <span className="text-text-primary font-mono">{normalizedName}</span> })}
            </p>
          ) : null}
        </div>

        <div>
          <label className="text-xs uppercase tracking-wider text-text-muted mb-2 block">{t('shell.createChannel.category')}</label>
          <div className="relative">
            <select
              value={category}
              onChange={(event) => setCategory(event.target.value)}
              className="w-full appearance-none bg-surface-container border border-border-subtle rounded-lg px-4 py-2.5 text-text-primary pr-8 focus:ring-1 focus:ring-primary focus:border-primary outline-none"
            >
              {categories.map((option) => {
                const labelKey = usingDefaultCategories ? DEFAULT_CATEGORY_LABEL_KEYS[option] : undefined;
                return (
                  <option key={option} value={option}>
                    {labelKey ? t(labelKey) : option}
                  </option>
                );
              })}
            </select>
            <span className="material-symbols-outlined text-text-secondary absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none">
              expand_more
            </span>
          </div>
        </div>

        <div>
          <label className="text-xs uppercase tracking-wider text-text-muted mb-3 block">{t('shell.createChannel.visibility')}</label>
          <div className="space-y-2">
            <VisibilityCard
              icon="public"
              label={t('shell.createChannel.publicLabel')}
              description={t('shell.createChannel.publicDescription')}
              selected={visibility === 'public'}
              onSelect={() => setVisibility('public')}
            />
            <VisibilityCard
              icon="lock"
              label={t('shell.createChannel.privateLabel')}
              description={t('shell.createChannel.privateDescription')}
              note={t('shell.createChannel.privateNote')}
              selected={visibility === 'private'}
              onSelect={() => setVisibility('private')}
            />
          </div>
        </div>

        {type === 'voice' ? (
          <div className="space-y-1 pt-2">
            <div className="flex items-center justify-between py-2">
              <div>
                <span className="text-sm font-medium text-text-primary block">{t('shell.createChannel.userLimit')}</span>
                <span className="text-xs text-text-secondary">{t('shell.createChannel.userLimitDescription')}</span>
              </div>
              <div className="relative">
                <select
                  value={userLimit}
                  onChange={(event) => setUserLimit(event.target.value as UserLimit)}
                  className="appearance-none bg-surface-container border border-border-subtle rounded-lg px-3 py-1.5 text-sm text-text-primary pr-8 focus:ring-1 focus:ring-primary focus:border-primary outline-none"
                >
                  <option value="none">{t('shell.createChannel.userLimitNone')}</option>
                  {USER_LIMITS.map((limit) => (
                    <option key={limit} value={limit}>
                      {t('shell.createChannel.userLimitCount', { count: limit })}
                    </option>
                  ))}
                </select>
                <span className="material-symbols-outlined text-text-secondary text-[18px] absolute right-2 top-1/2 -translate-y-1/2 pointer-events-none">
                  expand_more
                </span>
              </div>
            </div>
            <ToggleRow
              label={t('shell.createChannel.screenShare')}
              description={t('shell.createChannel.screenShareDescription')}
              checked={allowScreenShare}
              onChange={setAllowScreenShare}
            />
            <ToggleRow
              label={t('shell.createChannel.camera')}
              description={t('shell.createChannel.cameraDescription')}
              checked={allowCamera}
              onChange={setAllowCamera}
            />
            <ToggleRow
              label={t('shell.createChannel.activities')}
              description={t('shell.createChannel.activitiesDescription')}
              checked={allowActivities}
              onChange={setAllowActivities}
            />
            <ToggleRow
              label={t('shell.createChannel.pushToTalk')}
              description={t('shell.createChannel.pushToTalkDescription')}
              checked={requirePushToTalk}
              onChange={setRequirePushToTalk}
            />
            <ToggleRow
              label={t('shell.createChannel.startMuted')}
              description={t('shell.createChannel.startMutedDescription')}
              checked={startMuted}
              onChange={setStartMuted}
              last
            />
            <p className="text-[11px] text-text-muted pt-2">
              {t('shell.createChannel.laterNote')}
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
