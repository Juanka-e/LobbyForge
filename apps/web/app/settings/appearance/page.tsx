'use client';

import { useEffect, useMemo, useState } from 'react';
import SettingsShell from '@/app/SettingsShell';
import SettingsStickyFooter from '@/app/settings/SettingsStickyFooter';

type ThemeChoice = 'dark' | 'dim' | 'light' | 'system';
type Density = 'comfortable' | 'compact';

type SettingsResponse = {
  settings: {
    theme: string;
    notifications: Record<string, unknown>;
    audio: Record<string, unknown>;
    privacy: Record<string, unknown>;
    keybinds: Record<string, unknown>;
    updatedAt: string;
  };
};

type AppearanceExtra = {
  accent: string;
  density: Density;
  compactMessageSpacing: boolean;
  showAvatarsInChat: boolean;
  hideEmptyChannels: boolean;
};

const THEME_OPTIONS: { value: ThemeChoice; label: string; hint: string }[] = [
  { value: 'dark', label: 'Dark', hint: 'Default - deep navy surface' },
  { value: 'dim', label: 'Dim', hint: 'Soft slate with reduced contrast' },
  { value: 'light', label: 'Light', hint: 'Daytime palette (preview only)' },
  { value: 'system', label: 'System', hint: 'Match the OS preference' },
];

const ACCENT_PRESETS: { value: string; label: string }[] = [
  { value: '#8FB8FF', label: 'Ice Blue' },
  { value: '#bcc7da', label: 'Steel' },
  { value: '#deb063', label: 'Soft Amber' },
  { value: '#7CCFA6', label: 'Sage' },
  { value: '#E98282', label: 'Coral' },
];

const DEFAULT_EXTRA: AppearanceExtra = {
  accent: '#8FB8FF',
  density: 'comfortable',
  compactMessageSpacing: false,
  showAvatarsInChat: true,
  hideEmptyChannels: false,
};

const APPEARANCE_STORAGE_KEY = 'lf-appearance';

async function jsonFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { credentials: 'same-origin', ...init });
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    throw new Error(`HTTP ${res.status} ${JSON.stringify(detail)}`);
  }
  return (await res.json()) as T;
}

function coerceTheme(value: string): ThemeChoice {
  if (value === 'dark' || value === 'dim' || value === 'light' || value === 'system') return value;
  return 'dark';
}

function normalizeHex(value: string): string {
  const trimmed = value.trim().toUpperCase().replace(/^#/, '');
  return /^[0-9A-F]{6}$/.test(trimmed) ? `#${trimmed}` : DEFAULT_EXTRA.accent;
}

function loadExtraFromStorage(): AppearanceExtra {
  if (typeof window === 'undefined') return DEFAULT_EXTRA;
  try {
    const raw = window.localStorage.getItem(APPEARANCE_STORAGE_KEY);
    if (!raw) return DEFAULT_EXTRA;
    const parsed = JSON.parse(raw) as Partial<AppearanceExtra>;
    return {
      accent: normalizeHex(parsed.accent ?? DEFAULT_EXTRA.accent),
      density: parsed.density === 'compact' ? 'compact' : 'comfortable',
      compactMessageSpacing:
        typeof parsed.compactMessageSpacing === 'boolean'
          ? parsed.compactMessageSpacing
          : DEFAULT_EXTRA.compactMessageSpacing,
      showAvatarsInChat:
        typeof parsed.showAvatarsInChat === 'boolean'
          ? parsed.showAvatarsInChat
          : DEFAULT_EXTRA.showAvatarsInChat,
      hideEmptyChannels:
        typeof parsed.hideEmptyChannels === 'boolean'
          ? parsed.hideEmptyChannels
          : DEFAULT_EXTRA.hideEmptyChannels,
    };
  } catch {
    return DEFAULT_EXTRA;
  }
}

function saveExtraToStorage(extra: AppearanceExtra): void {
  try {
    window.localStorage.setItem(APPEARANCE_STORAGE_KEY, JSON.stringify(extra));
  } catch {
    /* local preference persistence is best-effort */
  }
}

function applyAppearanceExtra(extra: AppearanceExtra): void {
  const root = document.documentElement;
  root.style.setProperty('--lf-user-accent', extra.accent);
  root.classList.toggle('lf-density-compact', extra.density === 'compact');
  root.classList.toggle('lf-chat-compact', extra.compactMessageSpacing);
  root.classList.toggle('lf-chat-hide-avatars', !extra.showAvatarsInChat);
  root.classList.toggle('lf-hide-empty-channels', extra.hideEmptyChannels);
}

function applyAppearanceTheme(theme: ThemeChoice): void {
  const root = document.documentElement;
  const resolved =
    theme === 'system'
      ? window.matchMedia('(prefers-color-scheme: light)').matches
        ? 'light'
        : 'dark'
      : theme;
  root.classList.toggle('dark', resolved !== 'light');
  root.classList.toggle('lf-theme-dark', resolved === 'dark');
  root.classList.toggle('lf-theme-dim', resolved === 'dim');
  root.classList.toggle('lf-theme-light', resolved === 'light');
  root.dataset.lfTheme = theme;
}

export default function AppearanceSettingsPage() {
  const [theme, setTheme] = useState<ThemeChoice>('dark');
  const [extra, setExtra] = useState<AppearanceExtra>(DEFAULT_EXTRA);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [status, setStatus] = useState<string>('Loading settings...');
  const [busy, setBusy] = useState(false);
  const [themeDirty, setThemeDirty] = useState(false);
  const [savedExtraSnapshot, setSavedExtraSnapshot] = useState<AppearanceExtra>(DEFAULT_EXTRA);

  const extraDirty = useMemo(
    () => JSON.stringify(extra) !== JSON.stringify(savedExtraSnapshot),
    [extra, savedExtraSnapshot]
  );
  const dirty = themeDirty || extraDirty;
  const disabled = busy || !dirty;

  useEffect(() => {
    let cancelled = false;
    const storedExtra = loadExtraFromStorage();
    setExtra(storedExtra);
    setSavedExtraSnapshot(storedExtra);
    applyAppearanceExtra(storedExtra);
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
          const nextTheme = coerceTheme(data.settings.theme);
          setTheme(nextTheme);
          applyAppearanceTheme(nextTheme);
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

  function patchTheme(next: ThemeChoice) {
    setTheme(next);
    applyAppearanceTheme(next);
    setThemeDirty(true);
  }

  function patchExtra(patch: Partial<AppearanceExtra>) {
    setExtra((current) => {
      const next = { ...current, ...patch };
      applyAppearanceExtra(next);
      return next;
    });
  }

  async function save() {
    setBusy(true);
    setStatus('Saving...');
    try {
      let nextUpdatedAt = updatedAt;
      if (themeDirty) {
        const data = await jsonFetch<SettingsResponse>('/api/settings/me', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ theme }),
        });
        const nextTheme = coerceTheme(data.settings.theme);
        setTheme(nextTheme);
        applyAppearanceTheme(nextTheme);
        nextUpdatedAt = data.settings.updatedAt;
        setUpdatedAt(data.settings.updatedAt);
        setThemeDirty(false);
      }
      saveExtraToStorage(extra);
      applyAppearanceExtra(extra);
      setSavedExtraSnapshot(extra);
      if (!themeDirty && nextUpdatedAt) setUpdatedAt(nextUpdatedAt);
      setStatus('Saved');
    } catch (err) {
      setStatus((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function reset() {
    setExtra(DEFAULT_EXTRA);
    patchTheme('dark');
  }

  return (
    <SettingsShell scope="user">
      <section className="max-w-5xl mx-auto pb-32 grid gap-8 lg:grid-cols-12">
        <div className="lg:col-span-8 space-y-8">
          <header>
            <h1 className="text-2xl font-semibold text-text-primary">Appearance</h1>
            <p className="mt-1 text-sm text-text-secondary">
              Adjust how LobbyForge looks on this device. Theme is saved per account; the rest is local.
            </p>
          </header>

          <Section title="Theme">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              {THEME_OPTIONS.map((option) => (
                <ThemeTile
                  key={option.value}
                  option={option}
                  selected={theme === option.value}
                  onSelect={() => patchTheme(option.value)}
                />
              ))}
            </div>
          </Section>

          <Section title="Accent Color">
            <div className="flex flex-wrap items-center gap-4">
              <div className="flex flex-wrap gap-3">
                {ACCENT_PRESETS.map((preset) => {
                  const selected = preset.value === extra.accent;
                  return (
                    <button
                      key={preset.value}
                      type="button"
                      aria-label={preset.label}
                      aria-pressed={selected}
                      onClick={() => patchExtra({ accent: preset.value })}
                      className={`w-8 h-8 rounded-full transition-transform hover:scale-110 ${
                        selected
                          ? 'ring-2 ring-offset-2 ring-offset-background ring-primary'
                          : ''
                      }`}
                      style={{ backgroundColor: preset.value }}
                    >
                      {selected ? (
                        <span
                          className="material-symbols-outlined text-background text-[18px]"
                          aria-hidden
                        >
                          check
                        </span>
                      ) : null}
                    </button>
                  );
                })}
              </div>
              <div className="flex items-center gap-2 bg-surface border border-border-subtle rounded px-3 py-1.5">
                <span className="text-text-muted font-mono text-sm">#</span>
                <input
                  type="text"
                  value={extra.accent.replace(/^#/, '')}
                  onChange={(event) => patchExtra({ accent: normalizeHex(event.target.value) })}
                  maxLength={6}
                  className="bg-transparent border-none p-0 w-20 text-text-primary font-mono text-sm focus:ring-0 uppercase"
                />
              </div>
            </div>
            <p className="text-xs text-text-muted flex items-center gap-1">
              <span className="material-symbols-outlined text-[14px]">info</span>
              LobbyForge keeps text contrast readable automatically.
            </p>
          </Section>

          <Section title="Interface Density">
            <div className="flex bg-surface-container rounded-lg p-1 border border-border-subtle max-w-md">
              {(['comfortable', 'compact'] as Density[]).map((value) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => patchExtra({ density: value })}
                  className={`flex-1 py-2 px-4 rounded-md font-medium text-center transition-colors ${
                    extra.density === value
                      ? 'bg-surface-raised text-text-primary shadow-sm border border-border-subtle'
                      : 'text-text-secondary hover:text-text-primary'
                  }`}
                >
                  {value === 'comfortable' ? 'Comfortable' : 'Compact'}
                </button>
              ))}
            </div>
          </Section>

          <Section title="Chat Appearance">
            <Toggle
              label="Compact message spacing"
              description="Reduces vertical space between chat messages."
              checked={extra.compactMessageSpacing}
              onChange={(value) => patchExtra({ compactMessageSpacing: value })}
            />
            <Toggle
              label="Show avatars in chat"
              description="Display user avatars next to their messages."
              checked={extra.showAvatarsInChat}
              onChange={(value) => patchExtra({ showAvatarsInChat: value })}
            />
          </Section>

          <Section title="Sidebar Display">
            <Toggle
              label="Hide empty channels"
              description="Automatically hide voice channels with no active users."
              checked={extra.hideEmptyChannels}
              onChange={(value) => patchExtra({ hideEmptyChannels: value })}
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
              Live Preview
            </h3>
            <PreviewPanel theme={theme} accent={extra.accent} />
            <p className="text-xs text-text-muted flex items-start gap-2 pt-2">
              <span className="material-symbols-outlined text-[14px] shrink-0">info</span>
              Accent, density and sidebar toggles are local-only on this device and sync in a later milestone.
            </p>
          </div>
        </aside>
      </section>
    </SettingsShell>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-4">
      <h2 className="text-xs uppercase tracking-wider text-text-secondary border-b border-border-subtle pb-2 font-bold">
        {title}
      </h2>
      <div className="rounded-xl bg-surface border border-border-subtle p-6 space-y-4">{children}</div>
    </section>
  );
}

function ThemeTile({
  option,
  selected,
  onSelect,
}: {
  option: { value: ThemeChoice; label: string; hint: string };
  selected: boolean;
  onSelect: () => void;
}) {
  const previewClass =
    option.value === 'light'
      ? 'bg-gradient-to-br from-gray-100 to-[#f5f7fa]'
      : option.value === 'dim'
        ? 'bg-[#1e2532]'
        : option.value === 'system'
          ? 'bg-gradient-to-br from-gray-100 to-background'
          : 'bg-background';
  const sideClass =
    option.value === 'light' ? 'bg-surface-variant opacity-50' : 'bg-surface';
  const lineClass = option.value === 'dim' ? 'bg-[#3b4758]' : 'bg-surface-variant';
  const footerClass = option.value === 'dim' ? 'bg-[#151a24]' : 'bg-surface-container';

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={`group text-left rounded-lg p-1 transition-colors relative overflow-hidden ${
        selected
          ? 'border-2 border-primary bg-surface-raised'
          : 'border-2 border-transparent hover:border-border-strong bg-surface'
      }`}
    >
      <div className={`h-24 rounded border border-border-subtle p-2 flex gap-2 ${previewClass}`}>
        <div className={`w-8 h-full rounded-sm ${sideClass}`} />
        <div className="flex-1 h-full flex flex-col gap-1">
          <div className={`h-2 w-1/2 rounded-sm ${lineClass}`} />
          <div className={`h-2 w-3/4 rounded-sm ${lineClass}`} />
          <div className={`mt-auto h-3 w-full rounded-sm ${footerClass}`} />
        </div>
        {option.value === 'system' ? (
          <div className="flex-1 h-full flex items-center justify-center">
            <span className="material-symbols-outlined text-text-muted text-sm">brightness_auto</span>
          </div>
        ) : null}
      </div>
      <div className="flex items-center gap-2 p-2">
        <span
          className={`w-4 h-4 rounded-full border-2 flex items-center justify-center ${
            selected ? 'border-primary' : 'border-outline group-hover:border-text-secondary'
          }`}
        >
          {selected ? <span className="w-2 h-2 rounded-full bg-primary" /> : null}
        </span>
        <span className={`font-medium ${selected ? 'text-text-primary' : 'text-text-secondary group-hover:text-text-primary'}`}>
          {option.label}
        </span>
      </div>
      {selected ? (
        <div className="absolute inset-0 bg-primary/5 pointer-events-none rounded-lg" aria-hidden />
      ) : null}
    </button>
  );
}

function Toggle({
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
    <label
      className={`flex items-center justify-between cursor-pointer gap-4 ${
        last ? '' : 'pb-4 border-b border-border-subtle'
      }`}
    >
      <div>
        <p className="text-sm text-text-primary font-medium">{label}</p>
        <p className="text-xs text-text-muted">{description}</p>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={`relative w-10 h-6 rounded-full border transition-colors flex-shrink-0 ${
          checked
            ? 'bg-primary/20 border-primary'
            : 'bg-surface-container-high border-border-subtle'
        }`}
      >
        <span
          className={`absolute top-1 w-4 h-4 rounded-full transition-all ${
            checked ? 'right-1 bg-primary' : 'left-1 bg-text-muted'
          }`}
        />
      </button>
    </label>
  );
}

function PreviewPanel({ theme, accent }: { theme: ThemeChoice; accent: string }) {
  return (
    <div className="bg-surface rounded-xl border border-border-subtle shadow-lg overflow-hidden">
      <div className="h-8 border-b border-border-subtle flex items-center px-3 bg-surface-raised">
        <span className="material-symbols-outlined text-[14px] text-text-muted mr-2">tag</span>
        <span className="font-bold text-text-primary text-xs">general</span>
        <span className="ml-auto text-[10px] text-text-muted uppercase tracking-wider">
          {theme}
        </span>
      </div>
      <div className="flex text-[10px] leading-tight">
        <div className="w-24 border-r border-border-subtle bg-background p-2 space-y-2">
          <div className="text-text-secondary flex items-center gap-1 opacity-70">
            <span className="material-symbols-outlined text-[10px]">tag</span>general
          </div>
          <div className="text-text-secondary flex items-center gap-1 opacity-70">
            <span className="material-symbols-outlined text-[10px]">tag</span>clips
          </div>
          <div className="pt-1">
            <div
              className="font-medium flex items-center gap-1 p-1 rounded"
              style={{ backgroundColor: `${accent}22`, color: accent }}
            >
              <span className="material-symbols-outlined text-[10px]">volume_up</span>Main Lounge
            </div>
            <div className="pl-4 pt-1 flex items-center gap-1 text-text-secondary opacity-80">
              <span className="w-3 h-3 rounded-full bg-surface-variant inline-block" /> juanka
            </div>
            <div className="pl-4 pt-1 flex items-center gap-1 text-text-secondary opacity-80">
              <span className="w-3 h-3 rounded-full bg-surface-variant inline-block" /> Ayse
            </div>
          </div>
        </div>
        <div className="flex-1 p-3 bg-surface flex flex-col justify-end space-y-3">
          <div className="flex gap-2">
            <div className="w-6 h-6 rounded-full bg-surface-container flex-shrink-0" />
            <div>
              <div className="flex items-baseline gap-1">
                <span className="font-bold text-text-primary">Ayse</span>
                <span className="text-[8px] text-text-muted">Today at 4:20 PM</span>
              </div>
              <div className="text-text-secondary mt-0.5">Anyone up for a quick match?</div>
            </div>
          </div>
          <div className="w-full bg-surface-container rounded border border-border-subtle p-1 flex items-center text-text-muted">
            Message #general...
          </div>
        </div>
      </div>
    </div>
  );
}
