'use client';

import { useEffect } from 'react';

type ThemeChoice = 'dark' | 'dim' | 'light' | 'system';
type Density = 'comfortable' | 'compact';

type AppearanceExtra = {
  accent: string;
  density: Density;
  compactMessageSpacing: boolean;
  showAvatarsInChat: boolean;
  hideEmptyChannels: boolean;
};

type SettingsResponse = {
  settings?: {
    theme?: string;
  };
};

const APPEARANCE_STORAGE_KEY = 'lf-appearance';
const DEFAULT_EXTRA: AppearanceExtra = {
  accent: '#8FB8FF',
  density: 'comfortable',
  compactMessageSpacing: false,
  showAvatarsInChat: true,
  hideEmptyChannels: false,
};

function normalizeHex(value: unknown): string {
  if (typeof value !== 'string') return DEFAULT_EXTRA.accent;
  const trimmed = value.trim().toUpperCase().replace(/^#/, '');
  return /^[0-9A-F]{6}$/.test(trimmed) ? `#${trimmed}` : DEFAULT_EXTRA.accent;
}

function coerceTheme(value: unknown): ThemeChoice {
  if (value === 'dark' || value === 'dim' || value === 'light' || value === 'system') {
    return value;
  }
  return 'dark';
}

function resolveTheme(theme: ThemeChoice): Exclude<ThemeChoice, 'system'> {
  if (theme !== 'system') return theme;
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

function loadExtra(): AppearanceExtra {
  try {
    const raw = window.localStorage.getItem(APPEARANCE_STORAGE_KEY);
    if (!raw) return DEFAULT_EXTRA;
    const parsed = JSON.parse(raw) as Partial<AppearanceExtra>;
    return {
      accent: normalizeHex(parsed.accent),
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

export function applyAppearanceTheme(theme: ThemeChoice): void {
  const root = document.documentElement;
  const resolved = resolveTheme(theme);
  root.classList.toggle('dark', resolved !== 'light');
  root.classList.toggle('lf-theme-dark', resolved === 'dark');
  root.classList.toggle('lf-theme-dim', resolved === 'dim');
  root.classList.toggle('lf-theme-light', resolved === 'light');
  root.dataset.lfTheme = theme;
}

export function applyAppearanceExtra(extra: AppearanceExtra): void {
  const root = document.documentElement;
  root.style.setProperty('--lf-user-accent', normalizeHex(extra.accent));
  root.classList.toggle('lf-density-compact', extra.density === 'compact');
  root.classList.toggle('lf-chat-compact', extra.compactMessageSpacing);
  root.classList.toggle('lf-chat-hide-avatars', !extra.showAvatarsInChat);
  root.classList.toggle('lf-hide-empty-channels', extra.hideEmptyChannels);
}

export default function AppearanceRuntime() {
  useEffect(() => {
    applyAppearanceExtra(loadExtra());

    let cancelled = false;
    async function loadTheme() {
      try {
        const res = await fetch('/api/settings/me', {
          credentials: 'same-origin',
          cache: 'no-store',
        });
        if (!res.ok) return;
        const data = (await res.json()) as SettingsResponse;
        if (!cancelled) applyAppearanceTheme(coerceTheme(data.settings?.theme));
      } catch {
        /* Appearance sync is best-effort; unauthenticated pages keep default dark. */
      }
    }

    void loadTheme();
    const media = window.matchMedia('(prefers-color-scheme: light)');
    const onSystemTheme = () => {
      if (document.documentElement.dataset.lfTheme === 'system') {
        applyAppearanceTheme('system');
      }
    };
    media.addEventListener('change', onSystemTheme);
    return () => {
      cancelled = true;
      media.removeEventListener('change', onSystemTheme);
    };
  }, []);

  return null;
}
