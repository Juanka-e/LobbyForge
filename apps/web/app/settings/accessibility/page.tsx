'use client';

import { useEffect, useMemo, useState } from 'react';
import SettingsShell from '@/app/SettingsShell';
import SettingsStickyFooter from '@/app/settings/SettingsStickyFooter';
import { useT } from '@/lib/i18n/client';
import { rich } from '@/lib/i18n/rich';

/**
 * User Settings -> Accessibility.
 *
 * Local browser preferences only. LobbyForge reads the OS-level
 * prefers-reduced-motion and prefers-contrast media queries to adapt
 * the UI automatically. These toggles let the user override the OS
 * setting on a per-browser basis.
 *
 * State lives in localStorage - these preferences are NOT synced to
 * the server because they are device-specific (a high-contrast monitor
 * at home doesn't mean the same for a laptop on the go).
 */

const STORAGE_KEY = 'lf-accessibility';

interface AccessibilitySettings {
  reducedMotion: 'auto' | 'on' | 'off';
  highContrast: 'auto' | 'on' | 'off';
  largeText: boolean;
  alwaysShowFocus: boolean;
}

const DEFAULTS: AccessibilitySettings = {
  reducedMotion: 'auto',
  highContrast: 'auto',
  largeText: false,
  alwaysShowFocus: true,
};

// Labels are message keys, resolved where they render.
const TRIPLE_OPTIONS: { value: 'auto' | 'on' | 'off'; labelKey: string }[] = [
  { value: 'auto', labelKey: 'settings.accessibility.option.auto' },
  { value: 'on', labelKey: 'settings.accessibility.option.on' },
  { value: 'off', labelKey: 'settings.accessibility.option.off' },
];

function loadFromStorage(): AccessibilitySettings {
  if (typeof window === 'undefined') return DEFAULTS;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULTS;
    const parsed = JSON.parse(raw) as Partial<AccessibilitySettings>;
    return { ...DEFAULTS, ...parsed };
  } catch {
    return DEFAULTS;
  }
}

function saveToStorage(settings: AccessibilitySettings): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    /* storage full or disabled - non-fatal */
  }
}

function applyAccessibilitySettings(
  settings: AccessibilitySettings,
  systemMotion: boolean,
  systemContrast: boolean
): void {
  const root = document.documentElement;
  const wantsReduced =
    settings.reducedMotion === 'on' ||
    (settings.reducedMotion === 'auto' && systemMotion);
  const wantsContrast =
    settings.highContrast === 'on' ||
    (settings.highContrast === 'auto' && systemContrast);

  root.classList.toggle('force-reduced-motion', wantsReduced);
  root.classList.toggle('force-high-contrast', wantsContrast);
  root.classList.toggle('force-large-text', settings.largeText);
  root.classList.toggle('force-visible-focus', settings.alwaysShowFocus);
}

export default function AccessibilityPage() {
  const t = useT();
  const [settings, setSettings] = useState<AccessibilitySettings>(DEFAULTS);
  const [systemMotion, setSystemMotion] = useState(false);
  const [systemContrast, setSystemContrast] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    const loaded = loadFromStorage();
    const motion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    const contrast = window.matchMedia?.('(prefers-contrast: more)').matches ?? false;
    setSettings(loaded);
    setSystemMotion(motion);
    setSystemContrast(contrast);
    applyAccessibilitySettings(loaded, motion, contrast);
  }, []);

  const dirty = useMemo(() => {
    const stored = loadFromStorage();
    return JSON.stringify(settings) !== JSON.stringify(stored);
  }, [settings]);

  function patch<K extends keyof AccessibilitySettings>(key: K, value: AccessibilitySettings[K]) {
    setSettings((s) => ({ ...s, [key]: value }));
    setSaved(false);
  }

  function save() {
    saveToStorage(settings);
    setSaved(true);
    applyAccessibilitySettings(settings, systemMotion, systemContrast);
  }

  function reset() {
    setSettings(DEFAULTS);
    setSaved(false);
    applyAccessibilitySettings(DEFAULTS, systemMotion, systemContrast);
  }

  // The standards link sits mid-sentence, and its position differs by
  // language, so the sentence is split around its placeholder.

  return (
    <SettingsShell scope="user">
      <section className="max-w-3xl mx-auto pb-32 space-y-8">
        <header>
          <h1 className="text-2xl font-semibold text-text-primary">{t('settings.nav.user.accessibility')}</h1>
          <p className="mt-1 text-sm text-text-secondary">{t('settings.accessibility.description')}</p>
        </header>

        <Section title={t('settings.accessibility.motion.title')}>
          <TriField
            label={t('settings.accessibility.motion.reduced')}
            description={t(
              systemMotion ? 'settings.accessibility.motion.systemOn' : 'settings.accessibility.motion.systemOff'
            )}
            value={settings.reducedMotion}
            onChange={(v) => patch('reducedMotion', v)}
          />
        </Section>

        <Section title={t('settings.accessibility.contrast.title')}>
          <TriField
            label={t('settings.accessibility.contrast.high')}
            description={t(
              systemContrast ? 'settings.accessibility.contrast.systemOn' : 'settings.accessibility.contrast.systemOff'
            )}
            value={settings.highContrast}
            onChange={(v) => patch('highContrast', v)}
          />
          <ToggleRow
            icon="format_size"
            label={t('settings.accessibility.contrast.largeText')}
            description={t('settings.accessibility.contrast.largeTextHint')}
            checked={settings.largeText}
            onChange={(v) => patch('largeText', v)}
            last
          />
        </Section>

        <Section title={t('settings.accessibility.keyboard.title')}>
          <ToggleRow
            icon="keyboard"
            label={t('settings.accessibility.keyboard.focusRing')}
            description={t('settings.accessibility.keyboard.focusRingHint')}
            checked={settings.alwaysShowFocus}
            onChange={(v) => patch('alwaysShowFocus', v)}
            last
          />
        </Section>

        <div className="rounded-lg border border-border-subtle bg-surface-container-low p-4 flex gap-3">
          <span className="material-symbols-outlined text-text-muted text-[18px] shrink-0">devices</span>
          <p className="text-xs text-text-muted leading-relaxed">
            {t('settings.accessibility.note.storage')} {rich(t('settings.accessibility.note.standard'), {
              standard: (
                <a className="underline hover:text-text-secondary" href="https://www.w3.org/WAI/standards-guidelines/wcag/">
                  WCAG 2.2 AA
                </a>
              ),
            })} {t('settings.accessibility.note.issue')}
          </p>
        </div>

        <SettingsStickyFooter
          status={{
            key: saved
              ? 'settings.accessibility.status.saved'
              : dirty
                ? 'settings.accessibility.status.unsaved'
                : 'settings.accessibility.status.clean',
          }}
          dirty={dirty}
          onReset={reset}
          onSave={save}
          saveLabel={t('settings.accessibility.save')}
        />
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

function TriField({
  label,
  description,
  value,
  onChange,
}: {
  label: string;
  description: string;
  value: 'auto' | 'on' | 'off';
  onChange: (value: 'auto' | 'on' | 'off') => void;
}) {
  const t = useT();
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="min-w-0">
        <p className="text-sm text-text-primary font-medium">{label}</p>
        <p className="text-xs text-text-muted">{description}</p>
      </div>
      <div className="flex bg-surface-container rounded-lg p-1 border border-border-subtle flex-shrink-0">
        {TRIPLE_OPTIONS.map((option) => (
          <button
            key={option.value}
            type="button"
            onClick={() => onChange(option.value)}
            className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${
              value === option.value
                ? 'bg-surface-raised text-text-primary shadow-sm'
                : 'text-text-secondary hover:text-text-primary'
            }`}
          >
            {t(option.labelKey)}
          </button>
        ))}
      </div>
    </div>
  );
}

function ToggleRow({
  icon,
  label,
  description,
  checked,
  onChange,
  last = false,
}: {
  icon: string;
  label: string;
  description: string;
  checked: boolean;
  onChange: (value: boolean) => void;
  last?: boolean;
}) {
  return (
    <div className={`flex items-center justify-between gap-4 ${last ? '' : 'pb-4 border-b border-border-subtle'}`}>
      <div className="flex items-start gap-3 min-w-0">
        <span className="material-symbols-outlined text-[18px] text-text-secondary mt-0.5 shrink-0">{icon}</span>
        <div className="min-w-0">
          <p className="text-sm text-text-primary font-medium">{label}</p>
          <p className="text-xs text-text-muted">{description}</p>
        </div>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        onClick={() => onChange(!checked)}
        className={`relative w-10 h-6 rounded-full border transition-colors flex-shrink-0 cursor-pointer ${
          checked ? 'bg-primary/20 border-primary' : 'bg-surface-container-high border-border-subtle'
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

