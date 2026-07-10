'use client';

import { useEffect, useMemo, useState } from 'react';
import SettingsShell from '@/app/SettingsShell';
import SettingsStickyFooter from '@/app/settings/SettingsStickyFooter';
import {
  DEFAULT_KEYBIND_PREFERENCES,
  mergeKeybindPreferences,
  type KeybindAction,
  type KeybindPreferences,
} from '@/lib/keybind-preferences';

type SettingsResponse = {
  settings: {
    keybinds: Record<string, unknown>;
    updatedAt: string;
  };
};

const ACTIONS: { key: KeybindAction; label: string; description: string; icon: string }[] = [
  { key: 'pushToTalk', label: 'Push to talk', description: 'Hold this key to open your mic in a voice room.', icon: 'keyboard_voice' },
  { key: 'toggleMute', label: 'Toggle mute', description: 'Reserved for the global mute shortcut.', icon: 'mic_off' },
  { key: 'toggleDeafen', label: 'Toggle deafen', description: 'Reserved for muting incoming voice audio.', icon: 'headphones' },
  { key: 'toggleCamera', label: 'Toggle camera', description: 'Reserved for quickly turning camera on or off.', icon: 'videocam' },
  { key: 'toggleScreenShare', label: 'Toggle screen share', description: 'Reserved for quickly starting or stopping share.', icon: 'screen_share' },
];

async function jsonFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { credentials: 'same-origin', ...init });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as T;
}

function eventLabel(event: KeyboardEvent): string {
  if (event.code === 'Space') return 'Space';
  if (event.key.length === 1) return event.key.toUpperCase();
  return event.key || event.code;
}

export default function KeybindSettingsPage() {
  const [prefs, setPrefs] = useState<KeybindPreferences>(DEFAULT_KEYBIND_PREFERENCES);
  const [savedSnapshot, setSavedSnapshot] = useState<KeybindPreferences>(DEFAULT_KEYBIND_PREFERENCES);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [status, setStatus] = useState('Loading settings...');
  const [busy, setBusy] = useState(false);
  const [capturing, setCapturing] = useState<KeybindAction | null>(null);

  const dirty = useMemo(() => JSON.stringify(prefs) !== JSON.stringify(savedSnapshot), [prefs, savedSnapshot]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const data = await jsonFetch<SettingsResponse>('/api/settings/me');
        if (cancelled) return;
        const merged = mergeKeybindPreferences(data.settings.keybinds);
        setPrefs(merged);
        setSavedSnapshot(merged);
        setUpdatedAt(data.settings.updatedAt);
        setStatus('Ready');
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
    if (!capturing) return;
    const onKeyDown = (event: KeyboardEvent) => {
      event.preventDefault();
      if (event.key === 'Escape') {
        setCapturing(null);
        return;
      }
      setPrefs((current) => ({
        ...current,
        [capturing]: { code: event.code, label: eventLabel(event) },
      }));
      setCapturing(null);
    };
    window.addEventListener('keydown', onKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true });
  }, [capturing]);

  async function save() {
    setBusy(true);
    setStatus('Saving...');
    try {
      const data = await jsonFetch<SettingsResponse>('/api/settings/me', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keybinds: prefs }),
      });
      const merged = mergeKeybindPreferences(data.settings.keybinds);
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
    setPrefs(DEFAULT_KEYBIND_PREFERENCES);
    setCapturing(null);
  }

  return (
    <SettingsShell scope="user">
      <section className="mx-auto max-w-3xl space-y-8 pb-32">
        <header>
          <h1 className="text-2xl font-semibold text-text-primary">Keybinds</h1>
          <p className="mt-1 text-sm text-text-secondary">
            Customize keyboard and mouse shortcuts used by voice controls.
          </p>
        </header>

        <section className="space-y-4">
          <h2 className="border-b border-border-subtle pb-2 text-xs font-bold uppercase tracking-wider text-text-secondary">
            Voice Controls
          </h2>
          <div className="rounded-xl border border-border-subtle bg-surface p-6">
            {ACTIONS.map((action, index) => (
              <div
                key={action.key}
                className={`flex items-center justify-between gap-4 ${index === ACTIONS.length - 1 ? '' : 'border-b border-border-subtle pb-4 mb-4'}`}
              >
                <div className="flex min-w-0 items-start gap-3">
                  <span className="material-symbols-outlined mt-0.5 shrink-0 text-[18px] text-text-secondary" aria-hidden>
                    {action.icon}
                  </span>
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-text-primary">{action.label}</p>
                    <p className="text-xs text-text-muted">{action.description}</p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setCapturing(action.key)}
                  className="min-w-28 rounded-md border border-border-strong bg-surface-raised px-3 py-2 text-sm font-medium text-text-primary hover:bg-surface-container"
                >
                  {capturing === action.key ? 'Press key...' : prefs[action.key].label}
                </button>
              </div>
            ))}
          </div>
        </section>

        <SettingsStickyFooter
          status={status}
          updatedAt={updatedAt}
          dirty={dirty}
          busy={busy}
          onReset={reset}
          onSave={save}
        />
      </section>
    </SettingsShell>
  );
}
