'use client';

import { useMemo, useState } from 'react';
import { useT } from '@/lib/i18n/client';

type RegistrationMode = 'open' | 'invite_only' | 'closed';

type Settings = {
  registrationMode: RegistrationMode;
  guestAccessEnabled: boolean;
  seoIndexingEnabled: boolean;
  seoTitle: string | null;
  seoDescription: string | null;
};

/** Message keys, resolved with `t` where the option renders. */
const REGISTRATION_OPTIONS: Array<{
  value: RegistrationMode;
  titleKey: string;
  descriptionKey: string;
}> = [
  {
    value: 'open',
    titleKey: 'adminSettings.auth.mode.openTitle',
    descriptionKey: 'adminSettings.auth.mode.openDescription',
  },
  {
    value: 'invite_only',
    titleKey: 'adminSettings.auth.mode.inviteOnlyTitle',
    descriptionKey: 'adminSettings.auth.mode.inviteOnlyDescription',
  },
  {
    value: 'closed',
    titleKey: 'adminSettings.auth.mode.closedTitle',
    descriptionKey: 'adminSettings.auth.mode.closedDescription',
  },
];

export default function InstanceAccessForm({
  initial,
  serverId,
}: {
  initial: Settings;
  serverId: string | null;
}) {
  const t = useT();
  const [settings, setSettings] = useState(initial);
  const [savedSettings, setSavedSettings] = useState(initial);
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);

  const dirty = useMemo(
    () => JSON.stringify(normalize(settings)) !== JSON.stringify(normalize(savedSettings)),
    [savedSettings, settings]
  );
  const titleLength = settings.seoTitle?.length ?? 0;
  const descriptionLength = settings.seoDescription?.length ?? 0;

  async function save() {
    setStatus('saving');
    setError(null);
    try {
      const response = await fetch('/api/admin/instance-settings', {
        method: 'PATCH',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(normalize(settings)),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${response.status}`);
      }
      const body = (await response.json()) as { settings: Settings };
      const next = normalize(body.settings);
      setSettings(next);
      setSavedSettings(next);
      setStatus('saved');
    } catch (err) {
      setStatus('error');
      setError((err as Error).message);
    }
  }

  function reset() {
    setSettings(savedSettings);
    setStatus('idle');
    setError(null);
  }

  return (
    <div className="relative min-h-[calc(100vh-180px)] pb-28">
      <div className="grid max-w-4xl gap-6">
        <section className="rounded-xl border border-border-subtle bg-surface p-5">
          <div className="mb-4">
            <h2 className="text-base font-semibold text-text-primary">{t('adminSettings.auth.accessMode.title')}</h2>
            <p className="mt-1 text-sm text-text-secondary">{t('adminSettings.auth.accessMode.description')}</p>
          </div>

          <div className="grid gap-3">
            {REGISTRATION_OPTIONS.map((option) => {
              const active = settings.registrationMode === option.value;
              return (
                <label
                  key={option.value}
                  className={`flex cursor-pointer gap-3 rounded-xl border p-4 transition-colors ${
                    active
                      ? 'border-primary-container bg-primary-container/10'
                      : 'border-border-subtle bg-surface-container/40 hover:bg-surface-raised/50'
                  }`}
                >
                  <input
                    type="radio"
                    name="registrationMode"
                    value={option.value}
                    checked={active}
                    onChange={() => {
                      setSettings((current) => ({
                        ...current,
                        registrationMode: option.value,
                        guestAccessEnabled: option.value === 'closed' ? false : current.guestAccessEnabled,
                      }));
                      setStatus('idle');
                    }}
                    className="mt-1"
                  />
                  <span>
                    <span className="block text-sm font-medium text-text-primary">{t(option.titleKey)}</span>
                    <span className="mt-1 block text-sm text-text-secondary">{t(option.descriptionKey)}</span>
                  </span>
                </label>
              );
            })}
          </div>

          <div className="mt-5 border-t border-border-subtle pt-5">
            <Toggle
              checked={settings.guestAccessEnabled && settings.registrationMode !== 'closed'}
              disabled={settings.registrationMode === 'closed'}
              label={t('adminSettings.auth.guest.label')}
              description={t('adminSettings.auth.guest.description')}
              onChange={(checked) => {
                setSettings((current) => ({ ...current, guestAccessEnabled: checked }));
                setStatus('idle');
              }}
            />
          </div>
        </section>

        <section className="rounded-xl border border-border-subtle bg-surface p-5">
          <div className="mb-4">
            <h2 className="text-base font-semibold text-text-primary">{t('adminSettings.auth.search.title')}</h2>
            <p className="mt-1 text-sm text-text-secondary">{t('adminSettings.auth.search.description')}</p>
          </div>

          <Toggle
            checked={settings.seoIndexingEnabled}
            label={t('adminSettings.auth.indexing.label')}
            description={t('adminSettings.auth.indexing.description')}
            onChange={(checked) => {
              setSettings((current) => ({ ...current, seoIndexingEnabled: checked }));
              setStatus('idle');
            }}
          />

          <div className="mt-5 grid gap-4">
            <label className="block">
              <span className="mb-1.5 flex items-center justify-between text-xs text-text-muted">
                {t('adminSettings.auth.seoTitle')}
                <span>{titleLength}/70</span>
              </span>
              <input
                value={settings.seoTitle ?? ''}
                maxLength={70}
                onChange={(event) => {
                  setSettings((current) => ({ ...current, seoTitle: event.target.value || null }));
                  setStatus('idle');
                }}
                className="w-full rounded-lg border border-border-strong bg-surface-raised px-3 py-2 text-sm text-text-primary outline-none"
              />
            </label>

            <label className="block">
              <span className="mb-1.5 flex items-center justify-between text-xs text-text-muted">
                {t('adminSettings.auth.seoDescription')}
                <span>{descriptionLength}/160</span>
              </span>
              <textarea
                value={settings.seoDescription ?? ''}
                maxLength={160}
                rows={4}
                onChange={(event) => {
                  setSettings((current) => ({ ...current, seoDescription: event.target.value || null }));
                  setStatus('idle');
                }}
                className="w-full resize-y rounded-lg border border-border-strong bg-surface-raised px-3 py-2 text-sm text-text-primary outline-none"
              />
            </label>
          </div>
        </section>

        <section className="rounded-xl border border-border-subtle bg-surface p-5">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 className="text-base font-semibold text-text-primary">{t('adminSettings.auth.identity.title')}</h2>
              <p className="mt-1 max-w-2xl text-sm text-text-secondary">{t('adminSettings.auth.identity.description')}</p>
            </div>
            {serverId ? (
              <a
                href={`/servers/${encodeURIComponent(serverId)}?tab=access`}
                className="inline-flex shrink-0 items-center justify-center gap-2 rounded-lg border border-border-strong px-4 py-2 text-sm font-medium text-text-primary transition-colors hover:bg-surface-raised"
              >
                <span className="material-symbols-outlined text-lg" aria-hidden>shield_lock</span>
                {t('adminSettings.auth.identity.open')}
              </a>
            ) : (
              <span className="text-sm text-danger">{t('adminSettings.auth.identity.noCommunity')}</span>
            )}
          </div>
        </section>
      </div>

      <div className="sticky bottom-0 mt-8 border-t border-border-subtle bg-background/95 px-0 py-4 backdrop-blur">
        <div className="flex max-w-4xl flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="min-h-5 text-sm" aria-live="polite">
            {status === 'saved' ? <span className="text-success">{t('adminSettings.auth.saved')}</span> : null}
            {status === 'error' ? (
              <span className="text-danger">{error ?? t('adminSettings.auth.saveFailed')}</span>
            ) : null}
            {status === 'idle' && dirty ? (
              <span className="text-text-secondary">{t('adminSettings.auth.unsaved')}</span>
            ) : null}
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={reset}
              disabled={!dirty || status === 'saving'}
              className="rounded-lg border border-border-strong px-4 py-2 text-sm font-medium text-text-secondary transition-colors hover:bg-surface-raised hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-40"
            >
              {t('adminSettings.common.reset')}
            </button>
            <button
              type="button"
              onClick={save}
              disabled={!dirty || status === 'saving'}
              className="rounded-lg bg-primary-container px-4 py-2 text-sm font-semibold text-on-primary-container transition-all hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {status === 'saving' ? t('adminSettings.common.saving') : t('adminSettings.auth.saveChanges')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function Toggle(props: {
  checked: boolean;
  disabled?: boolean;
  label: string;
  description: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label
      className={`flex gap-3 rounded-xl border border-border-subtle bg-surface-container/40 p-4 ${
        props.disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'
      }`}
    >
      <input
        type="checkbox"
        checked={props.checked}
        disabled={props.disabled}
        onChange={(event) => props.onChange(event.target.checked)}
        className="mt-1"
      />
      <span>
        <span className="block text-sm font-medium text-text-primary">{props.label}</span>
        <span className="mt-1 block text-sm text-text-secondary">{props.description}</span>
      </span>
    </label>
  );
}

function normalize(settings: Settings): Settings {
  return {
    registrationMode: settings.registrationMode,
    guestAccessEnabled: settings.registrationMode === 'closed' ? false : settings.guestAccessEnabled,
    seoIndexingEnabled: settings.seoIndexingEnabled,
    seoTitle: trimToNull(settings.seoTitle),
    seoDescription: trimToNull(settings.seoDescription),
  };
}

function trimToNull(value: string | null): string | null {
  const trimmed = value?.trim() ?? '';
  return trimmed ? trimmed : null;
}
