'use client';

import { useState } from 'react';
import { useT } from '@/lib/i18n/client';

export interface VoiceSettingsView {
  serverId: string;
  defaultUserLimit: number | null;
  requirePushToTalk: boolean;
  startMuted: boolean;
  allowCamera: boolean;
  allowScreenShare: boolean;
  maxCameraUsersPerRoom: number | null;
  maxScreenShareUsersPerRoom: number | null;
  maxScreenShareHeight: number;
  maxScreenShareFps: number;
  updatedAt: string;
}

interface ApiResponse {
  settings?: VoiceSettingsView;
  error?: string;
}

export default function VoiceMediaClient({
  serverId,
  initial,
  loadError,
}: {
  serverId: string | null;
  initial: VoiceSettingsView | null;
  loadError: string | null;
}) {
  const t = useT();
  const [settings, setSettings] = useState<VoiceSettingsView | null>(initial);
  const [draft, setDraft] = useState(() => initial ?? defaultDraft(serverId ?? ''));
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);

  const dirty = JSON.stringify(draft) !== JSON.stringify(settings ?? defaultDraft(serverId ?? ''));

  async function save() {
    if (!serverId || saving) return;
    setSaving(true);
    setMessage(null);
    try {
      const response = await fetch(`/api/servers/${encodeURIComponent(serverId)}/voice-settings`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          defaultUserLimit: draft.defaultUserLimit,
          requirePushToTalk: draft.requirePushToTalk,
          startMuted: draft.startMuted,
          allowCamera: draft.allowCamera,
          allowScreenShare: draft.allowScreenShare,
          maxCameraUsersPerRoom: draft.maxCameraUsersPerRoom,
          maxScreenShareUsersPerRoom: draft.maxScreenShareUsersPerRoom,
          maxScreenShareHeight: draft.maxScreenShareHeight,
          maxScreenShareFps: draft.maxScreenShareFps,
        }),
      });
      const data = (await response.json().catch(() => ({}))) as ApiResponse;
      if (!response.ok || !data.settings) throw new Error(data.error ?? t('adminSettings.voiceMedia.saveFailed'));
      setSettings(data.settings);
      setDraft(data.settings);
      setMessage({ tone: 'success', text: t('adminSettings.voiceMedia.saved') });
    } catch (err) {
      setMessage({ tone: 'danger', text: (err as Error).message });
    } finally {
      setSaving(false);
    }
  }

  function reset() {
    setDraft(settings ?? defaultDraft(serverId ?? ''));
    setMessage(null);
  }

  return (
    <section className="max-w-3xl mx-auto pb-32">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold text-text-primary">{t('adminSettings.voiceMedia.title')}</h1>
        <p className="mt-1 text-sm text-text-secondary">{t('adminSettings.voiceMedia.subtitle')}</p>
      </header>

      {loadError ? (
        <Alert tone="danger" text={t('adminSettings.voiceMedia.loadError', { error: loadError })} />
      ) : null}
      {!serverId ? <Alert tone="danger" text={t('adminSettings.common.noServer')} /> : null}
      {message ? <Alert tone={message.tone} text={message.text} /> : null}

      <Section title={t('adminSettings.voiceMedia.defaults.title')} icon="meeting_room">
        <NumberRow
          label={t('adminSettings.voiceMedia.userLimit.label')}
          description={t('adminSettings.voiceMedia.userLimit.description')}
          value={draft.defaultUserLimit}
          min={1}
          max={500}
          onChange={(value) => setDraft((current) => ({ ...current, defaultUserLimit: value }))}
        />
        <ToggleRow
          label={t('adminSettings.voiceMedia.pushToTalk.label')}
          description={t('adminSettings.voiceMedia.pushToTalk.description')}
          checked={draft.requirePushToTalk}
          onChange={(value) => setDraft((current) => ({ ...current, requirePushToTalk: value }))}
        />
        <ToggleRow
          label={t('adminSettings.voiceMedia.startMuted.label')}
          description={t('adminSettings.voiceMedia.startMuted.description')}
          checked={draft.startMuted}
          onChange={(value) => setDraft((current) => ({ ...current, startMuted: value }))}
        />
      </Section>

      <Section title={t('adminSettings.voiceMedia.camera.title')} icon="videocam">
        <ToggleRow
          label={t('adminSettings.voiceMedia.allowCamera.label')}
          description={t('adminSettings.voiceMedia.allowCamera.description')}
          checked={draft.allowCamera}
          onChange={(value) => setDraft((current) => ({ ...current, allowCamera: value }))}
        />
        <ToggleRow
          label={t('adminSettings.voiceMedia.allowScreenShare.label')}
          description={t('adminSettings.voiceMedia.allowScreenShare.description')}
          checked={draft.allowScreenShare}
          onChange={(value) => setDraft((current) => ({ ...current, allowScreenShare: value }))}
        />
        <NumberRow
          label={t('adminSettings.voiceMedia.maxCameraUsers')}
          description={t('adminSettings.voiceMedia.capDescription')}
          value={draft.maxCameraUsersPerRoom}
          min={1}
          max={100}
          onChange={(value) => setDraft((current) => ({ ...current, maxCameraUsersPerRoom: value }))}
        />
        <NumberRow
          label={t('adminSettings.voiceMedia.maxScreenShareUsers')}
          description={t('adminSettings.voiceMedia.capDescription')}
          value={draft.maxScreenShareUsersPerRoom}
          min={1}
          max={100}
          onChange={(value) => setDraft((current) => ({ ...current, maxScreenShareUsersPerRoom: value }))}
        />
        <SelectRow
          label={t('adminSettings.voiceMedia.resolution.label')}
          description={t('adminSettings.voiceMedia.resolution.description')}
          value={String(draft.maxScreenShareHeight)}
          options={[
            { value: '480', label: '480p' },
            { value: '720', label: '720p' },
            { value: '1080', label: '1080p' },
            { value: '1440', label: '1440p' },
            { value: '2160', label: '2160p (4K)' },
          ]}
          onChange={(value) => setDraft((current) => ({ ...current, maxScreenShareHeight: Number(value) }))}
        />
        <SelectRow
          label={t('adminSettings.voiceMedia.frameRate.label')}
          description={t('adminSettings.voiceMedia.frameRate.description')}
          value={String(draft.maxScreenShareFps)}
          options={[
            { value: '15', label: '15 FPS' },
            { value: '30', label: '30 FPS' },
            { value: '60', label: '60 FPS' },
          ]}
          onChange={(value) => setDraft((current) => ({ ...current, maxScreenShareFps: Number(value) }))}
        />
      </Section>

      <div className="sticky bottom-0 mt-8 border-t border-border-subtle bg-background/95 py-4 backdrop-blur">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs text-text-muted">{t('adminSettings.voiceMedia.footer')}</p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={reset}
              disabled={!dirty || saving}
              className="rounded-lg border border-border-subtle px-4 py-2 text-sm font-medium text-text-secondary disabled:cursor-not-allowed disabled:opacity-50"
            >
              {t('adminSettings.common.reset')}
            </button>
            <button
              type="button"
              onClick={save}
              disabled={!serverId || !dirty || saving}
              className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-on-primary disabled:cursor-not-allowed disabled:opacity-50"
            >
              {saving ? t('adminSettings.common.saving') : t('common.save')}
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}

function defaultDraft(serverId: string): VoiceSettingsView {
  return {
    serverId,
    defaultUserLimit: null,
    requirePushToTalk: false,
    startMuted: false,
    allowCamera: true,
    allowScreenShare: true,
    maxCameraUsersPerRoom: null,
    maxScreenShareUsersPerRoom: null,
    maxScreenShareHeight: 1080,
    maxScreenShareFps: 30,
    updatedAt: new Date(0).toISOString(),
  };
}

function Section({
  title,
  icon,
  children,
}: {
  title: string;
  icon: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mb-8">
      <h2 className="text-lg font-semibold text-text-primary flex items-center gap-2 border-b border-border-subtle pb-2 mb-4">
        <span className="material-symbols-outlined text-primary">{icon}</span>
        {title}
      </h2>
      <div className="bg-surface rounded-xl border border-border-subtle divide-y divide-border-subtle">
        {children}
      </div>
    </section>
  );
}

function ToggleRow({
  label,
  description,
  checked,
  onChange,
}: {
  label: string;
  description: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <div className="grid grid-cols-[1fr_auto] gap-4 px-5 py-4 items-center">
      <div>
        <p className="text-sm text-text-primary font-medium">{label}</p>
        <p className="text-xs text-text-muted mt-1">{description}</p>
      </div>
      <button
        type="button"
        onClick={() => onChange(!checked)}
        className={`relative h-6 w-11 rounded-full transition-colors ${
          checked ? 'bg-primary-container' : 'bg-surface-container-high'
        }`}
        aria-pressed={checked}
      >
        <span
          className={`absolute top-1 h-4 w-4 rounded-full transition-all ${
            checked ? 'right-1 bg-[#07101E]' : 'left-1 bg-text-muted'
          }`}
        />
      </button>
    </div>
  );
}

function NumberRow({
  label,
  description,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  description: string;
  value: number | null;
  min: number;
  max: number;
  onChange: (value: number | null) => void;
}) {
  const t = useT();
  return (
    <div className="grid gap-4 px-5 py-4 md:grid-cols-[1fr_140px] md:items-center">
      <div>
        <p className="text-sm text-text-primary font-medium">{label}</p>
        <p className="text-xs text-text-muted mt-1">{description}</p>
      </div>
      <input
        type="number"
        min={min}
        max={max}
        value={value ?? ''}
        placeholder={t('adminSettings.voiceMedia.noLimit')}
        onChange={(event) => {
          if (event.target.value.trim() === '') {
            onChange(null);
            return;
          }
          const next = Number(event.target.value);
          onChange(Number.isFinite(next) ? Math.min(max, Math.max(min, Math.trunc(next))) : null);
        }}
        className="w-full rounded-lg border border-border-subtle bg-surface-container px-3 py-2 text-sm text-text-primary placeholder-text-muted focus:outline-none focus:ring-1 focus:ring-primary-container"
      />
    </div>
  );
}

function SelectRow({
  label,
  description,
  value,
  options,
  onChange,
}: {
  label: string;
  description: string;
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange: (value: string) => void;
}) {
  return (
    <div className="grid gap-4 px-5 py-4 md:grid-cols-[1fr_180px] md:items-center">
      <div>
        <p className="text-sm font-medium text-text-primary">{label}</p>
        <p className="mt-1 text-xs text-text-muted">{description}</p>
      </div>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="w-full rounded-lg border border-border-subtle bg-surface-container px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-primary-container"
      >
        {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
    </div>
  );
}

function Alert({ tone, text }: { tone: 'success' | 'danger'; text: string }) {
  const className =
    tone === 'success'
      ? 'mb-4 rounded-lg border border-success/40 bg-success/10 p-4 text-sm text-success'
      : 'mb-4 rounded-lg border border-danger/40 bg-danger/10 p-4 text-sm text-danger';
  return <div className={className}>{text}</div>;
}
