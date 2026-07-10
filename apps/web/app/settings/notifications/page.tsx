'use client';

import { useEffect, useMemo, useState } from 'react';
import SettingsShell from '@/app/SettingsShell';
import SettingsStickyFooter from '@/app/settings/SettingsStickyFooter';

type NotificationLevel = 'all' | 'mentions' | 'nothing';
type Sound = 'default' | 'subtle' | 'none';

type NotificationPreferences = {
  level: NotificationLevel;
  desktopEnabled: boolean;
  showPreview: boolean;
  sound: Sound;
  unreadBadge: boolean;
  suppressWhileInVoice: boolean;
  emailDigest: boolean;
  mobilePushEnabled: boolean;
};

type SettingsResponse = {
  settings: {
    theme: string;
    notifications: Partial<NotificationPreferences> | Record<string, unknown>;
    updatedAt: string;
  };
};

const DEFAULT_NOTIFICATIONS: NotificationPreferences = {
  level: 'mentions',
  desktopEnabled: true,
  showPreview: true,
  sound: 'default',
  unreadBadge: true,
  suppressWhileInVoice: true,
  emailDigest: false,
  mobilePushEnabled: false,
};

const LEVEL_OPTIONS: { value: NotificationLevel; label: string; description: string; icon: string }[] = [
  {
    value: 'all',
    label: 'All messages',
    description: 'Every new message in joined channels.',
    icon: 'notifications_active',
  },
  {
    value: 'mentions',
    label: 'Mentions only',
    description: 'Only when someone @mentions or replies to you.',
    icon: 'alternate_email',
  },
  {
    value: 'nothing',
    label: 'Nothing',
    description: 'Disable all in-app notifications.',
    icon: 'notifications_off',
  },
];

const SOUND_OPTIONS: { value: Sound; label: string; description: string }[] = [
  { value: 'default', label: 'Default chime', description: 'LobbyForge signature' },
  { value: 'subtle', label: 'Subtle pop', description: 'Soft, low-volume ping' },
  { value: 'none', label: 'No sound', description: 'Silent notifications only' },
];

async function jsonFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { credentials: 'same-origin', ...init });
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    throw new Error(`HTTP ${res.status} ${JSON.stringify(detail)}`);
  }
  return (await res.json()) as T;
}

function coerceLevel(value: unknown): NotificationLevel {
  return value === 'all' || value === 'nothing' ? value : 'mentions';
}

function coerceSound(value: unknown): Sound {
  return value === 'subtle' || value === 'none' ? value : 'default';
}

function coerceBool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function mergeNotifications(value: unknown): NotificationPreferences {
  const input = value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
  return {
    level: coerceLevel(input.level),
    desktopEnabled: coerceBool(input.desktopEnabled, DEFAULT_NOTIFICATIONS.desktopEnabled),
    showPreview: coerceBool(input.showPreview, DEFAULT_NOTIFICATIONS.showPreview),
    sound: coerceSound(input.sound),
    unreadBadge: coerceBool(input.unreadBadge, DEFAULT_NOTIFICATIONS.unreadBadge),
    suppressWhileInVoice: coerceBool(
      input.suppressWhileInVoice,
      DEFAULT_NOTIFICATIONS.suppressWhileInVoice
    ),
    emailDigest: coerceBool(input.emailDigest, DEFAULT_NOTIFICATIONS.emailDigest),
    mobilePushEnabled: coerceBool(
      input.mobilePushEnabled,
      DEFAULT_NOTIFICATIONS.mobilePushEnabled
    ),
  };
}

export default function NotificationsSettingsPage() {
  const [prefs, setPrefs] = useState<NotificationPreferences>(DEFAULT_NOTIFICATIONS);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [status, setStatus] = useState<string>('Loading settings...');
  const [busy, setBusy] = useState(false);
  const [savedSnapshot, setSavedSnapshot] = useState<NotificationPreferences>(DEFAULT_NOTIFICATIONS);
  const [browserPermission, setBrowserPermission] = useState<'unknown' | 'granted' | 'denied' | 'default'>(
    'unknown'
  );

  const dirty = useMemo(
    () => JSON.stringify(prefs) !== JSON.stringify(savedSnapshot),
    [prefs, savedSnapshot]
  );
  const disabled = busy || !dirty;

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        let data: SettingsResponse;
        try {
          data = await jsonFetch<SettingsResponse>('/api/settings/me');
        } catch (err) {
          if (!(err as Error).message.startsWith('HTTP 401')) throw err;
          await jsonFetch('/api/auth/guest', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
          });
          data = await jsonFetch<SettingsResponse>('/api/settings/me');
        }
        if (!cancelled) {
          const merged = mergeNotifications(data.settings.notifications);
          setPrefs(merged);
          setSavedSnapshot(merged);
          setUpdatedAt(data.settings.updatedAt);
          setStatus('Ready');
        }
      } catch (err) {
        if (!cancelled) setStatus((err as Error).message);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined' || !('Notification' in window)) {
      setBrowserPermission('unknown');
      return;
    }
    setBrowserPermission((window.Notification.permission as 'granted' | 'denied' | 'default') ?? 'default');
  }, []);

  function patch(patch: Partial<NotificationPreferences>) {
    setPrefs((current) => ({ ...current, ...patch }));
  }

  async function requestBrowserPermission() {
    if (typeof window === 'undefined' || !('Notification' in window)) {
      setStatus('Browser does not support desktop notifications.');
      return;
    }
    try {
      const result = await window.Notification.requestPermission();
      setBrowserPermission(result as 'granted' | 'denied' | 'default');
      setStatus(`Browser permission: ${result}`);
    } catch (err) {
      setStatus(`Browser permission request failed: ${(err as Error).message}`);
    }
  }

  async function save() {
    setBusy(true);
    setStatus('Saving...');
    try {
      const data = await jsonFetch<SettingsResponse>('/api/settings/me', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ notifications: prefs }),
      });
      const merged = mergeNotifications(data.settings.notifications);
      setPrefs(merged);
      setSavedSnapshot(merged);
      setUpdatedAt(data.settings.updatedAt);
      setStatus('Saved');
    } catch (err) {
      setStatus((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function reset() {
    setPrefs(DEFAULT_NOTIFICATIONS);
  }

  const browserPermissionLabel =
    browserPermission === 'granted'
      ? 'Granted'
      : browserPermission === 'denied'
        ? 'Blocked'
        : browserPermission === 'default'
          ? 'Ask on first use'
          : 'Unsupported';

  const browserPermissionTone =
    browserPermission === 'granted'
      ? 'success'
      : browserPermission === 'denied'
        ? 'danger'
        : 'muted';

  return (
    <SettingsShell scope="user">
      <section className="max-w-5xl mx-auto pb-32 grid gap-8 lg:grid-cols-12">
        <div className="lg:col-span-8 space-y-8">
          <header>
            <h1 className="text-2xl font-semibold text-text-primary">Notifications</h1>
            <p className="mt-1 text-sm text-text-secondary">
              Control how LobbyForge notifies you on this device.
            </p>
          </header>

          <Section title="Notification Level">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              {LEVEL_OPTIONS.map((option) => (
                <LevelCard
                  key={option.value}
                  option={option}
                  selected={prefs.level === option.value}
                  onSelect={() => patch({ level: option.value })}
                />
              ))}
            </div>
          </Section>

          <Section title="Desktop Notifications">
            <ToggleRow
              label="Enable desktop notifications"
              description="Receive native OS notifications."
              checked={prefs.desktopEnabled}
              onChange={(value) => patch({ desktopEnabled: value })}
            />
            <ToggleRow
              label="Show preview"
              description="Display message content in notifications."
              checked={prefs.showPreview}
              onChange={(value) => patch({ showPreview: value })}
            />
            <div className="flex items-center justify-between pt-3">
              <div>
                <p className="text-sm text-text-primary">Browser permission</p>
              </div>
              <div className="flex items-center gap-3">
                <PermissionBadge label={browserPermissionLabel} tone={browserPermissionTone} />
                {browserPermission !== 'granted' && browserPermission !== 'unknown' ? (
                  <button
                    type="button"
                    onClick={requestBrowserPermission}
                    className="px-3 py-1 rounded bg-surface-raised border border-border-strong text-xs font-medium text-text-primary hover:bg-surface-container transition-colors"
                  >
                    Request
                  </button>
                ) : null}
              </div>
            </div>
          </Section>

          <Section title="Notification Sound">
            <div className="space-y-3">
              {SOUND_OPTIONS.map((option) => (
                <RadioRow
                  key={option.value}
                  label={option.label}
                  description={option.description}
                  selected={prefs.sound === option.value}
                  onSelect={() => patch({ sound: option.value })}
                />
              ))}
            </div>
          </Section>

          <Section title="In-Experience Indicators">
            <ToggleRow
              label="Unread badge"
              description="Show a red dot on channels with unread mentions."
              checked={prefs.unreadBadge}
              onChange={(value) => patch({ unreadBadge: value })}
            />
            <ToggleRow
              label="Suppress while in voice"
              description="Pause desktop notifications while you are in a voice room."
              checked={prefs.suppressWhileInVoice}
              onChange={(value) => patch({ suppressWhileInVoice: value })}
              last
            />
          </Section>

          <Section title="Mobile & Email">
            <ToggleRow
              label="Mobile push (experimental)"
              description="Receive pushes via the LobbyForge companion app."
              checked={prefs.mobilePushEnabled}
              onChange={(value) => patch({ mobilePushEnabled: value })}
            />
            <ToggleRow
              label="Weekly email digest"
              description="A Monday-morning summary of messages and mentions."
              checked={prefs.emailDigest}
              onChange={(value) => patch({ emailDigest: value })}
              last
            />
          </Section>

          <SettingsStickyFooter
            status={status}
            updatedAt={updatedAt}
            dirty={dirty}
            busy={busy}
            onReset={reset}
            onSave={save}
            saveDisabled={disabled}
          />
        </div>

        <aside className="lg:col-span-4">
          <div className="sticky top-8 space-y-4">
            <h3 className="text-xs uppercase tracking-wider font-bold text-text-secondary border-b border-border-subtle pb-2">
              Preview
            </h3>
            <NotificationPreviewCard prefs={prefs} />
            <p className="text-xs text-text-muted flex items-start gap-2 pt-2">
              <span className="material-symbols-outlined text-[14px] shrink-0">info</span>
              Browser permission is per-device. Changes sync across your account on save.
            </p>
          </div>
        </aside>
      </section>
    </SettingsShell>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-4">
      <h2 className="text-xs uppercase tracking-wider text-text-secondary border-b border-border-subtle pb-2 font-bold">
        {title}
      </h2>
      <div className="rounded-xl bg-surface border border-border-subtle p-6 space-y-4">{children}</div>
    </section>
  );
}

function LevelCard({
  option,
  selected,
  onSelect,
}: {
  option: { value: NotificationLevel; label: string; description: string; icon: string };
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={`relative flex flex-col text-left bg-surface border rounded-xl p-4 cursor-pointer transition-colors ${
        selected
          ? 'border-primary bg-surface-container-high'
          : 'border-border-subtle hover:border-outline-variant'
      }`}
    >
      <div className="flex justify-between items-start mb-2">
        <span
          className={`material-symbols-outlined transition-colors ${
            selected ? 'text-primary' : 'text-text-muted group-hover:text-primary'
          }`}
        >
          {option.icon}
        </span>
        <span
          className={`w-5 h-5 rounded-full border-2 flex items-center justify-center transition-colors ${
            selected ? 'border-primary bg-primary' : 'border-border-strong'
          }`}
        >
          <span
            className={`w-2 h-2 rounded-full transition-opacity ${
              selected ? 'bg-background opacity-100' : 'bg-background opacity-0'
            }`}
          />
        </span>
      </div>
      <span className={`text-sm font-medium ${selected ? 'text-primary' : 'text-text-primary'}`}>
        {option.label}
      </span>
      <span className="text-xs text-text-muted mt-1">{option.description}</span>
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
  description?: string;
  checked: boolean;
  onChange: (value: boolean) => void;
  last?: boolean;
}) {
  return (
    <div
      className={`flex items-center justify-between gap-4 ${
        last ? '' : 'pb-4 border-b border-border-subtle'
      }`}
    >
      <div>
        <p className="text-sm text-text-primary">{label}</p>
        {description ? <p className="text-xs text-text-muted">{description}</p> : null}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={`relative w-10 h-6 rounded-full transition-colors flex-shrink-0 ${
          checked ? 'bg-primary/30 border border-primary' : 'bg-surface-container-high border border-border-subtle'
        }`}
      >
        <span
          className={`absolute top-1 w-4 h-4 rounded-full transition-all ${
            checked ? 'right-1 bg-primary' : 'left-1 bg-text-muted'
          }`}
        />
      </button>
    </div>
  );
}

function RadioRow({
  label,
  description,
  selected,
  onSelect,
}: {
  label: string;
  description: string;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`flex items-center justify-between w-full text-left p-3 rounded-lg border transition-colors ${
        selected
          ? 'bg-primary/5 border-primary/40'
          : 'bg-surface-raised border-border-strong hover:bg-surface-container'
      }`}
    >
      <div>
        <p className="text-sm text-text-primary">{label}</p>
        <p className="text-xs text-text-muted">{description}</p>
      </div>
      <span
        className={`w-4 h-4 rounded-full border-2 flex items-center justify-center flex-shrink-0 ${
          selected ? 'border-primary' : 'border-border-strong'
        }`}
      >
        {selected ? <span className="w-2 h-2 bg-primary rounded-full" /> : null}
      </span>
    </button>
  );
}

function PermissionBadge({
  label,
  tone,
}: {
  label: string;
  tone: 'success' | 'danger' | 'muted';
}) {
  const colorClass =
    tone === 'success' ? 'text-success' : tone === 'danger' ? 'text-danger' : 'text-text-muted';
  const icon =
    tone === 'success' ? 'check_circle' : tone === 'danger' ? 'block' : 'help';
  return (
    <span className={`text-xs flex items-center ${colorClass}`}>
      <span className="material-symbols-outlined text-[16px] mr-1">{icon}</span>
      {label}
    </span>
  );
}

function NotificationPreviewCard({ prefs }: { prefs: NotificationPreferences }) {
  const mute = !prefs.desktopEnabled || prefs.level === 'nothing';
  const sampleText =
    prefs.level === 'all'
      ? 'Ayse: anyone up for a quick match?'
      : prefs.level === 'mentions'
        ? '@juanka - ready for Hushle?'
        : 'You will not be notified.';
  return (
    <div className="rounded-xl border border-border-subtle bg-surface/80 backdrop-blur-md p-4 space-y-3">
      <div className="flex items-center gap-2 text-xs text-text-muted uppercase tracking-wider">
        <span className="material-symbols-outlined text-[14px]">notifications</span>
        Sample
      </div>
      <div
        className={`rounded-lg p-3 border ${
          mute ? 'bg-surface-container border-border-subtle opacity-60' : 'bg-surface-container-high border-primary/40'
        }`}
      >
        <div className="flex items-center gap-2 mb-1">
          <span className="material-symbols-outlined text-[16px] text-primary">
            {mute ? 'notifications_off' : 'notifications'}
          </span>
          <span className="text-xs font-semibold text-text-primary">LobbyForge</span>
          <span className="text-[10px] text-text-muted ml-auto">just now</span>
        </div>
        <p className="text-sm text-text-primary">{mute ? 'Notifications muted' : sampleText}</p>
        {prefs.showPreview && !mute ? (
          <p className="text-xs text-text-secondary mt-1">Main Lounge - #general</p>
        ) : null}
      </div>
      <p className="text-xs text-text-muted">
        Sound: <span className="text-text-primary">{prefs.sound}</span>
      </p>
    </div>
  );
}
