'use client';

import { useMemo, useState } from 'react';

type RegistrationMode = 'open' | 'invite_only' | 'closed';

type Settings = {
  registrationMode: RegistrationMode;
  guestAccessEnabled: boolean;
  seoIndexingEnabled: boolean;
  seoTitle: string | null;
  seoDescription: string | null;
};

const REGISTRATION_OPTIONS: Array<{
  value: RegistrationMode;
  title: string;
  description: string;
}> = [
  {
    value: 'open',
    title: 'Open registration',
    description: 'New people can create accounts and join the first community when guest access allows it.',
  },
  {
    value: 'invite_only',
    title: 'Invite only',
    description: 'A valid invite link is required. Direct visits cannot enter the community without an invite.',
  },
  {
    value: 'closed',
    title: 'Closed',
    description: 'New registrations are blocked. Existing signed-in members and admins can continue using the instance.',
  },
];

export default function InstanceAccessForm({ initial }: { initial: Settings }) {
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
            <h2 className="text-base font-semibold text-text-primary">Access mode</h2>
            <p className="mt-1 text-sm text-text-secondary">
              Choose how people can reach this self-hosted instance.
            </p>
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
                    <span className="block text-sm font-medium text-text-primary">{option.title}</span>
                    <span className="mt-1 block text-sm text-text-secondary">{option.description}</span>
                  </span>
                </label>
              );
            })}
          </div>

          <div className="mt-5 border-t border-border-subtle pt-5">
            <Toggle
              checked={settings.guestAccessEnabled && settings.registrationMode !== 'closed'}
              disabled={settings.registrationMode === 'closed'}
              label="Allow guest access"
              description="Guests can enter permitted flows without creating a password account. Closed mode always disables this."
              onChange={(checked) => {
                setSettings((current) => ({ ...current, guestAccessEnabled: checked }));
                setStatus('idle');
              }}
            />
          </div>
        </section>

        <section className="rounded-xl border border-border-subtle bg-surface p-5">
          <div className="mb-4">
            <h2 className="text-base font-semibold text-text-primary">Search visibility</h2>
            <p className="mt-1 text-sm text-text-secondary">
              Decide whether public pages should be indexable and tune the basic SEO copy.
            </p>
          </div>

          <Toggle
            checked={settings.seoIndexingEnabled}
            label="Allow search engine indexing"
            description="When disabled, robots.txt and page metadata both request no indexing."
            onChange={(checked) => {
              setSettings((current) => ({ ...current, seoIndexingEnabled: checked }));
              setStatus('idle');
            }}
          />

          <div className="mt-5 grid gap-4">
            <label className="block">
              <span className="mb-1.5 flex items-center justify-between text-xs text-text-muted">
                SEO title
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
                SEO description
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
      </div>

      <div className="sticky bottom-0 mt-8 border-t border-border-subtle bg-background/95 px-0 py-4 backdrop-blur">
        <div className="flex max-w-4xl flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="min-h-5 text-sm" aria-live="polite">
            {status === 'saved' ? <span className="text-success">Saved.</span> : null}
            {status === 'error' ? <span className="text-danger">{error ?? 'Could not save settings.'}</span> : null}
            {status === 'idle' && dirty ? <span className="text-text-secondary">You have unsaved changes.</span> : null}
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={reset}
              disabled={!dirty || status === 'saving'}
              className="rounded-lg border border-border-strong px-4 py-2 text-sm font-medium text-text-secondary transition-colors hover:bg-surface-raised hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-40"
            >
              Reset
            </button>
            <button
              type="button"
              onClick={save}
              disabled={!dirty || status === 'saving'}
              className="rounded-lg bg-primary-container px-4 py-2 text-sm font-semibold text-on-primary-container transition-all hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {status === 'saving' ? 'Saving...' : 'Save changes'}
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
