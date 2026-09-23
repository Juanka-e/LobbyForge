'use client';

import { useEffect, useMemo, useState } from 'react';
import SettingsShell from '@/app/SettingsShell';
import SettingsStickyFooter, { type SettingsStatus } from '@/app/settings/SettingsStickyFooter';
import { useT } from '@/lib/i18n/client';
import { rich } from '@/lib/i18n/rich';

type NotificationLevel = 'all' | 'mentions' | 'nothing';
type Sound = 'default' | 'subtle' | 'none';

type NotificationPreferences = {
  level: NotificationLevel;
  desktopEnabled: boolean;
  showPreview: boolean;
  sound: Sound;
  unreadBadge: boolean;
  suppressWhileInVoice: boolean;
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
};

// Labels are message keys, resolved where they render.
type LevelOption = { value: NotificationLevel; labelKey: string; descriptionKey: string; icon: string };

const LEVEL_OPTIONS: LevelOption[] = [
  {
    value: 'all',
    labelKey: 'settings.notifications.level.all',
    descriptionKey: 'settings.notifications.level.allHint',
    icon: 'notifications_active',
  },
  {
    value: 'mentions',
    labelKey: 'settings.notifications.level.mentions',
    descriptionKey: 'settings.notifications.level.mentionsHint',
    icon: 'alternate_email',
  },
  {
    value: 'nothing',
    labelKey: 'settings.notifications.level.nothing',
    descriptionKey: 'settings.notifications.level.nothingHint',
    icon: 'notifications_off',
  },
];

const SOUND_OPTIONS: { value: Sound; labelKey: string; descriptionKey: string }[] = [
  { value: 'default', labelKey: 'settings.notifications.sound.default', descriptionKey: 'settings.notifications.sound.defaultHint' },
  { value: 'subtle', labelKey: 'settings.notifications.sound.subtle', descriptionKey: 'settings.notifications.sound.subtleHint' },
  { value: 'none', labelKey: 'settings.notifications.sound.none', descriptionKey: 'settings.notifications.sound.noneHint' },
];

type BrowserPermission = 'unknown' | 'granted' | 'denied' | 'default';

function permissionLabelKey(permission: BrowserPermission): string {
  if (permission === 'granted') return 'settings.notifications.permission.granted';
  if (permission === 'denied') return 'settings.notifications.permission.denied';
  if (permission === 'default') return 'settings.notifications.permission.default';
  return 'settings.notifications.permission.unsupported';
}

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
  };
}

export default function NotificationsSettingsPage() {
  const t = useT();
  const [prefs, setPrefs] = useState<NotificationPreferences>(DEFAULT_NOTIFICATIONS);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [status, setStatus] = useState<SettingsStatus>({ key: 'settings.footer.loading' });
  const [busy, setBusy] = useState(false);
  const [savedSnapshot, setSavedSnapshot] = useState<NotificationPreferences>(DEFAULT_NOTIFICATIONS);
  const [browserPermission, setBrowserPermission] = useState<BrowserPermission>('unknown');

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
          setStatus({ key: 'settings.footer.ready' });
        }
      } catch (err) {
        if (!cancelled) setStatus({ text: (err as Error).message });
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
      setStatus({ key: 'settings.notifications.permission.noSupport' });
      return;
    }
    try {
      const result = await window.Notification.requestPermission();
      setBrowserPermission(result as 'granted' | 'denied' | 'default');
      setStatus({
        key: 'settings.notifications.permission.result',
        params: { result: t(permissionLabelKey(result as BrowserPermission)) },
      });
    } catch (err) {
      setStatus({ key: 'settings.notifications.permission.failed', params: { error: (err as Error).message } });
    }
  }

  async function save() {
    setBusy(true);
    setStatus({ key: 'settings.footer.saving' });
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
      setStatus({ key: 'settings.footer.saved' });
    } catch (err) {
      setStatus({ text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }

  function reset() {
    setPrefs(DEFAULT_NOTIFICATIONS);
  }

  const browserPermissionLabel = t(permissionLabelKey(browserPermission));

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
            <h1 className="text-2xl font-semibold text-text-primary">{t('settings.nav.user.notifications')}</h1>
            <p className="mt-1 text-sm text-text-secondary">{t('settings.notifications.description')}</p>
          </header>

          <Section title={t('settings.notifications.level.title')}>
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

          <Section title={t('settings.notifications.desktop.title')}>
            <ToggleRow
              label={t('settings.notifications.desktop.enable')}
              description={t('settings.notifications.desktop.enableHint')}
              checked={prefs.desktopEnabled}
              onChange={(value) => patch({ desktopEnabled: value })}
            />
            <ToggleRow
              label={t('settings.notifications.desktop.preview')}
              description={t('settings.notifications.desktop.previewHint')}
              checked={prefs.showPreview}
              onChange={(value) => patch({ showPreview: value })}
            />
            <div className="flex items-center justify-between pt-3">
              <div>
                <p className="text-sm text-text-primary">{t('settings.notifications.permission.label')}</p>
              </div>
              <div className="flex items-center gap-3">
                <PermissionBadge label={browserPermissionLabel} tone={browserPermissionTone} />
                {browserPermission !== 'granted' && browserPermission !== 'unknown' ? (
                  <button
                    type="button"
                    onClick={requestBrowserPermission}
                    className="px-3 py-1 rounded bg-surface-raised border border-border-strong text-xs font-medium text-text-primary hover:bg-surface-container transition-colors"
                  >
                    {t('settings.notifications.permission.request')}
                  </button>
                ) : null}
              </div>
            </div>
          </Section>

          <Section title={t('settings.notifications.sound.title')}>
            <div className="space-y-3">
              {SOUND_OPTIONS.map((option) => (
                <RadioRow
                  key={option.value}
                  label={t(option.labelKey)}
                  description={t(option.descriptionKey)}
                  selected={prefs.sound === option.value}
                  onSelect={() => patch({ sound: option.value })}
                />
              ))}
            </div>
          </Section>

          <Section title={t('settings.notifications.indicators.title')}>
            <ToggleRow
              label={t('settings.notifications.indicators.unread')}
              description={t('settings.notifications.indicators.unreadHint')}
              checked={prefs.unreadBadge}
              onChange={(value) => patch({ unreadBadge: value })}
            />
            <ToggleRow
              label={t('settings.notifications.indicators.suppress')}
              description={t('settings.notifications.indicators.suppressHint')}
              checked={prefs.suppressWhileInVoice}
              onChange={(value) => patch({ suppressWhileInVoice: value })}
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
              {t('settings.notifications.preview.title')}
            </h3>
            <NotificationPreviewCard prefs={prefs} />
            <p className="text-xs text-text-muted flex items-start gap-2 pt-2">
              <span className="material-symbols-outlined text-[14px] shrink-0">info</span>
              {t('settings.notifications.preview.note')}
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
  option: LevelOption;
  selected: boolean;
  onSelect: () => void;
}) {
  const t = useT();
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
        {t(option.labelKey)}
      </span>
      <span className="text-xs text-text-muted mt-1">{t(option.descriptionKey)}</span>
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

/**
 * A mock notification. The names in it (Ayse, juanka, Main Lounge,
 * #general) are sample data and stay as they are.
 */
function NotificationPreviewCard({ prefs }: { prefs: NotificationPreferences }) {
  const t = useT();
  const mute = !prefs.desktopEnabled || prefs.level === 'nothing';
  const sampleText =
    prefs.level === 'all'
      ? t('settings.notifications.preview.all', { name: 'Ayse' })
      : prefs.level === 'mentions'
        ? t('settings.notifications.preview.mention', { name: 'juanka' })
        : t('settings.notifications.preview.nothing');
  const soundKey = SOUND_OPTIONS.find((option) => option.value === prefs.sound)?.labelKey;
  // The value is highlighted, so the phrase is split around its placeholder.
  return (
    <div className="rounded-xl border border-border-subtle bg-surface/80 backdrop-blur-md p-4 space-y-3">
      <div className="flex items-center gap-2 text-xs text-text-muted uppercase tracking-wider">
        <span className="material-symbols-outlined text-[14px]">notifications</span>
        {t('settings.notifications.preview.sample')}
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
          <span className="text-[10px] text-text-muted ml-auto">{t('settings.notifications.preview.justNow')}</span>
        </div>
        <p className="text-sm text-text-primary">{mute ? t('settings.notifications.preview.muted') : sampleText}</p>
        {prefs.showPreview && !mute ? (
          <p className="text-xs text-text-secondary mt-1">Main Lounge - #general</p>
        ) : null}
      </div>
      <p className="text-xs text-text-muted">
        {rich(t('settings.notifications.preview.sound'), { sound: <span className="text-text-primary">{soundKey ? t(soundKey) : prefs.sound}</span> })}
      </p>
    </div>
  );
}
