'use client';

import { useCallback, useEffect, useId, useState, type ReactNode } from 'react';
import { useT } from '@/lib/i18n/client';
import type { Translator } from '@/lib/i18n/core';
import {
  LOCK_ENV,
  MIN_SCORE,
  THRESHOLD,
  buildPutBody,
  buildTestBody,
  draftFrom,
  isDirty,
  isExternal,
  isFuture,
  missingKeys,
  parseAdminCaptchaSettings,
  parseTestResult,
  type AdminCaptchaSettings,
  type CaptchaDraft,
  type CaptchaOptions,
  type CaptchaProviderChoice,
  type CaptchaSurfaces,
  type CaptchaTestResult,
  type ExternalProvider,
  type SecretAction,
} from './bot-protection-model';
import { PrivacyNoticeDialog, type PrivacyNoticeSet } from './PrivacyNoticeDialog';

const ENDPOINT = '/api/admin/captcha';

const PROVIDER_OPTIONS: Array<{ value: CaptchaProviderChoice; recommended?: boolean }> = [
  { value: 'none' },
  { value: 'altcha', recommended: true },
  { value: 'turnstile' },
  { value: 'recaptcha' },
];

/** Product names are not translated. */
const PRODUCT: Record<CaptchaProviderChoice, string> = {
  none: '',
  altcha: 'ALTCHA',
  turnstile: 'Cloudflare Turnstile',
  recaptcha: 'Google reCAPTCHA',
};

const TOGGLE_SURFACES: Array<{ key: 'register' | 'invite_register' | 'guest'; id: string }> = [
  { key: 'register', id: 'register' },
  { key: 'invite_register', id: 'inviteRegister' },
  { key: 'guest', id: 'guest' },
];

const inputClass =
  'w-full rounded-lg border border-border-strong bg-surface-raised px-3 py-2 text-sm text-text-primary outline-none focus:border-primary disabled:cursor-not-allowed disabled:opacity-60 read-only:text-text-secondary';
const fieldLabel = 'mb-1.5 block text-xs text-text-muted';
const secondaryButton =
  'rounded-lg border border-border-strong px-3 py-1.5 text-sm font-medium text-text-secondary transition-colors hover:bg-surface-raised hover:text-text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-40';
const focusRing = 'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary';

type SaveState = { state: 'idle' | 'saving' | 'saved' } | { state: 'error'; message: string };
type TestState =
  | { state: 'idle' | 'running' | 'error' }
  | { state: 'done'; result: CaptchaTestResult; detail: string | null };

function formatTime(t: Translator, iso: string): string {
  return new Intl.DateTimeFormat(t.locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso));
}

function saveErrorMessage(t: Translator, status: number, body: Record<string, unknown>, provider: CaptchaProviderChoice): string {
  if (status === 409 && body.error === 'locked_by_env') {
    const field = typeof body.field === 'string' ? body.field : '';
    const name = Object.hasOwn(LOCK_ENV, field) ? LOCK_ENV[field as keyof typeof LOCK_ENV] : field;
    return t('adminSettings.botProtection.error.locked', { name });
  }
  if (status === 400 && body.error === 'keys_required') {
    return t('adminSettings.botProtection.keys.required', { provider: PRODUCT[provider] });
  }
  if (status === 400 && body.error === 'invalid_settings') return t('adminSettings.botProtection.error.invalid');
  return t('adminSettings.botProtection.saveFailed');
}

/**
 * Admin → Settings → Authentication → "Bot protection" (docs/CAPTCHA.md
 * §6, §6.1). Loads and saves through `/api/admin/captcha` on its own — it
 * is not part of the instance-access form's save bar, so it carries its
 * own Save. The secret key is write-only: the API only ever says whether
 * one is set and its last characters.
 */
export default function BotProtectionCard({ notices }: { notices: PrivacyNoticeSet[] }) {
  const t = useT();
  const ids = useId();
  const [load, setLoad] = useState<'loading' | 'error' | 'ready'>('loading');
  const [saved, setSaved] = useState<AdminCaptchaSettings | null>(null);
  const [draft, setDraft] = useState<CaptchaDraft | null>(null);
  const [secret, setSecret] = useState<SecretAction>({ kind: 'keep' });
  const [save, setSave] = useState<SaveState>({ state: 'idle' });
  const [test, setTest] = useState<TestState>({ state: 'idle' });
  const [privacyFor, setPrivacyFor] = useState<ExternalProvider | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const apply = useCallback((settings: AdminCaptchaSettings) => {
    setSaved(settings);
    setDraft(draftFrom(settings));
    setSecret({ kind: 'keep' });
    setTest({ state: 'idle' });
  }, []);

  const fetchSettings = useCallback(async () => {
    setLoad('loading');
    try {
      const response = await fetch(ENDPOINT, { credentials: 'same-origin', cache: 'no-store' });
      const parsed = response.ok ? parseAdminCaptchaSettings(await response.json()) : null;
      if (!parsed) {
        setLoad('error');
        return;
      }
      apply(parsed);
      setLoad('ready');
    } catch {
      setLoad('error');
    }
  }, [apply]);

  useEffect(() => {
    void fetchSettings();
  }, [fetchSettings]);

  // "Ends at …" lines disappear on their own once the time has passed.
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const header = (
    <div className="mb-4">
      <h2 id={`${ids}-title`} className="text-base font-semibold text-text-primary">
        {t('adminSettings.botProtection.title')}
      </h2>
      <p className="mt-1 max-w-2xl text-sm text-text-secondary">{t('adminSettings.botProtection.description')}</p>
    </div>
  );

  if (load !== 'ready' || !saved || !draft) {
    return (
      <section aria-labelledby={`${ids}-title`} className="rounded-xl border border-border-subtle bg-surface p-5">
        {header}
        {load === 'error' ? (
          <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-danger/40 bg-danger/10 p-4">
            <p className="text-sm text-text-primary">{t('adminSettings.botProtection.loadFailed')}</p>
            <button type="button" onClick={() => void fetchSettings()} className={secondaryButton}>
              {t('adminSettings.botProtection.retry')}
            </button>
          </div>
        ) : (
          <p role="status" className="text-sm text-text-muted">
            {t('adminSettings.botProtection.loading')}
          </p>
        )}
      </section>
    );
  }

  const dirty = isDirty(saved, draft, secret);
  const saving = save.state === 'saving';
  const off = draft.provider === 'none';
  const external = isExternal(draft.provider);

  function update(patch: Partial<CaptchaDraft>) {
    setDraft((current) => (current ? { ...current, ...patch } : current));
    setSave({ state: 'idle' });
    setTest({ state: 'idle' });
  }
  const updateSurfaces = (patch: Partial<CaptchaSurfaces>) => draft && update({ surfaces: { ...draft.surfaces, ...patch } });
  const updateOptions = (patch: Partial<CaptchaOptions>) => draft && update({ options: { ...draft.options, ...patch } });

  function chooseProvider(next: CaptchaProviderChoice) {
    if (!draft || next === draft.provider) return;
    // Data leaves the instance: explain that first (and for each company).
    if (isExternal(next)) {
      setPrivacyFor(next);
      return;
    }
    update({ provider: next });
  }

  function changeSecret(next: SecretAction) {
    setSecret(next);
    setSave({ state: 'idle' });
    setTest({ state: 'idle' });
  }

  function resetDraft() {
    if (!saved) return;
    apply(saved);
    setSave({ state: 'idle' });
  }

  async function saveSettings() {
    if (!saved || !draft) return;
    if (missingKeys(saved, draft, secret)) {
      setSave({ state: 'error', message: t('adminSettings.botProtection.keys.required', { provider: PRODUCT[draft.provider] }) });
      return;
    }
    setSave({ state: 'saving' });
    try {
      const response = await fetch(ENDPOINT, {
        method: 'PUT',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(buildPutBody(saved, draft, secret)),
      });
      const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      const parsed = response.ok ? parseAdminCaptchaSettings(body) : null;
      if (parsed) {
        apply(parsed);
        setSave({ state: 'saved' });
        return;
      }
      setSave({ state: 'error', message: saveErrorMessage(t, response.status, body, draft.provider) });
    } catch {
      setSave({ state: 'error', message: t('adminSettings.botProtection.saveFailed') });
    }
  }

  async function runTest() {
    if (!saved || !draft) return;
    setTest({ state: 'running' });
    try {
      const response = await fetch(`${ENDPOINT}/test`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(buildTestBody(saved, draft, secret)),
      });
      const parsed = response.ok ? parseTestResult(await response.json()) : null;
      setTest(parsed ? { state: 'done', ...parsed } : { state: 'error' });
    } catch {
      setTest({ state: 'error' });
    }
  }

  const autoAttack = isFuture(saved.attackMode.autoUntil, now) ? saved.attackMode.autoUntil : null;
  const breakerUntil = saved.breaker.open && isExternal(saved.provider) ? saved.breaker.until : null;

  return (
    <section aria-labelledby={`${ids}-title`} className="rounded-xl border border-border-subtle bg-surface p-5">
      {header}

      {saved.breaker.open && isExternal(saved.provider) ? (
        <p role="status" className="mb-4 flex gap-2 rounded-xl border border-ember/40 bg-ember/10 px-3.5 py-2.5 text-sm text-text-primary">
          <span className="material-symbols-outlined text-lg text-ember" aria-hidden>
            warning
          </span>
          <span className="text-pretty">
            {breakerUntil && isFuture(breakerUntil, now)
              ? t('adminSettings.botProtection.breaker.openUntil', { provider: PRODUCT[saved.provider], time: formatTime(t, breakerUntil) })
              : t('adminSettings.botProtection.breaker.open', { provider: PRODUCT[saved.provider] })}
          </span>
        </p>
      ) : null}

      {/* Provider */}
      <fieldset disabled={saved.locked.provider} className="min-w-0">
        <legend className="mb-3 text-sm font-semibold text-text-primary">{t('adminSettings.botProtection.provider.legend')}</legend>
        <div className="grid gap-3 sm:grid-cols-2">
          {PROVIDER_OPTIONS.map((option) => {
            const active = draft.provider === option.value;
            return (
              <label
                key={option.value}
                className={`flex gap-3 rounded-xl border p-4 transition-colors ${
                  saved.locked.provider ? 'cursor-not-allowed opacity-70' : 'cursor-pointer'
                } ${
                  active
                    ? 'border-primary-container bg-primary-container/10'
                    : 'border-border-subtle bg-surface-container/40 hover:bg-surface-raised/50'
                }`}
              >
                <input
                  type="radio"
                  name={`${ids}-provider`}
                  value={option.value}
                  checked={active}
                  onChange={() => chooseProvider(option.value)}
                  className="mt-1"
                />
                <span className="min-w-0">
                  <span className="flex flex-wrap items-center gap-2 text-sm font-medium text-text-primary">
                    {t(`adminSettings.botProtection.provider.${option.value}.title`)}
                    {option.recommended ? (
                      <span className="rounded-full border border-success/40 bg-success/10 px-2 py-0.5 text-xs font-medium text-success">
                        {t('adminSettings.botProtection.provider.recommended')}
                      </span>
                    ) : null}
                  </span>
                  <span className="mt-1 block text-sm text-text-secondary">
                    {t(`adminSettings.botProtection.provider.${option.value}.description`)}
                  </span>
                </span>
              </label>
            );
          })}
        </div>
        {saved.locked.provider ? <LockedNote name={LOCK_ENV.provider} /> : null}
      </fieldset>

      {/* Keys */}
      {external ? (
        <Section title={t('adminSettings.botProtection.keys.title')}>
          <div className="grid gap-4 md:grid-cols-2">
            <div className="min-w-0">
              <label htmlFor={`${ids}-site-key`} className={fieldLabel}>
                {t('adminSettings.botProtection.keys.siteKey')}
              </label>
              <input
                id={`${ids}-site-key`}
                value={draft.siteKey}
                readOnly={saved.locked.siteKey}
                onChange={(event) => update({ siteKey: event.target.value })}
                autoComplete="off"
                spellCheck={false}
                maxLength={256}
                className={`${inputClass} font-mono`}
              />
              {saved.locked.siteKey ? <LockedNote name={LOCK_ENV.siteKey} /> : null}
            </div>
            <div className="min-w-0">
              <SecretField
                id={`${ids}-secret`}
                saved={saved}
                action={secret}
                onChange={changeSecret}
              />
            </div>
          </div>
        </Section>
      ) : null}

      {/* Provider options */}
      {draft.provider === 'altcha' ? (
        <Section title={t('adminSettings.botProtection.options.title')}>
          <ChoiceGroup
            name={`${ids}-difficulty`}
            legend={t('adminSettings.botProtection.options.altchaDifficulty')}
            value={draft.options.altchaDifficulty}
            onChange={(value) => updateOptions({ altchaDifficulty: value })}
            choices={[
              { value: 'normal', label: t('adminSettings.botProtection.options.difficultyNormal') },
              { value: 'hard', label: t('adminSettings.botProtection.options.difficultyHard') },
            ]}
          />
        </Section>
      ) : null}
      {draft.provider === 'turnstile' ? (
        <Section title={t('adminSettings.botProtection.options.title')}>
          <ChoiceGroup
            name={`${ids}-appearance`}
            legend={t('adminSettings.botProtection.options.turnstileAppearance')}
            value={draft.options.turnstileAppearance}
            onChange={(value) => updateOptions({ turnstileAppearance: value })}
            choices={[
              { value: 'interaction-only', label: t('adminSettings.botProtection.options.appearanceInteractionOnly') },
              { value: 'always', label: t('adminSettings.botProtection.options.appearanceAlways') },
            ]}
          />
          <p className="mt-3 flex gap-2 text-sm text-text-secondary">
            <span className="material-symbols-outlined text-lg text-text-muted" aria-hidden>
              info
            </span>
            <span className="text-pretty">{t('adminSettings.botProtection.options.turnstileModeNote')}</span>
          </p>
        </Section>
      ) : null}
      {draft.provider === 'recaptcha' ? (
        <Section title={t('adminSettings.botProtection.options.title')}>
          <div className="grid gap-4 md:grid-cols-2">
            <div className="min-w-0">
              <label htmlFor={`${ids}-version`} className={fieldLabel}>
                {t('adminSettings.botProtection.options.recaptchaVersion')}
              </label>
              <select
                id={`${ids}-version`}
                value={draft.options.recaptchaVersion}
                onChange={(event) => updateOptions({ recaptchaVersion: event.target.value as CaptchaOptions['recaptchaVersion'] })}
                className={inputClass}
              >
                <option value="v3">{t('adminSettings.botProtection.options.versionV3')}</option>
                <option value="v2_checkbox">{t('adminSettings.botProtection.options.versionV2Checkbox')}</option>
                <option value="v2_invisible">{t('adminSettings.botProtection.options.versionV2Invisible')}</option>
              </select>
            </div>
            {draft.options.recaptchaVersion === 'v3' ? (
              <div className="min-w-0">
                <label htmlFor={`${ids}-score`} className={fieldLabel}>
                  {t('adminSettings.botProtection.options.recaptchaMinScore')}
                </label>
                <input
                  id={`${ids}-score`}
                  type="number"
                  inputMode="decimal"
                  min={MIN_SCORE.min}
                  max={MIN_SCORE.max}
                  step={MIN_SCORE.step}
                  value={draft.options.recaptchaMinScore}
                  aria-describedby={`${ids}-score-hint`}
                  onChange={(event) => {
                    const value = Number(event.target.value);
                    if (Number.isFinite(value)) {
                      updateOptions({ recaptchaMinScore: Math.min(MIN_SCORE.max, Math.max(MIN_SCORE.min, Math.round(value * 10) / 10)) });
                    }
                  }}
                  className={inputClass}
                />
                <p id={`${ids}-score-hint`} className="mt-1.5 text-xs text-text-muted">
                  {t('adminSettings.botProtection.options.minScoreHint')}
                </p>
              </div>
            ) : null}
          </div>
        </Section>
      ) : null}

      {/* Surfaces */}
      <Section title={t('adminSettings.botProtection.surfaces.title')}>
        <fieldset disabled={off} className="grid min-w-0 gap-3">
          <legend className="sr-only">{t('adminSettings.botProtection.surfaces.title')}</legend>
          {off ? <p className="text-sm text-text-muted">{t('adminSettings.botProtection.offNote')}</p> : null}
          <div className="grid gap-3 md:grid-cols-3">
            {TOGGLE_SURFACES.map((surface) => (
              <Toggle
                key={surface.key}
                checked={draft.surfaces[surface.key] === 'on'}
                disabled={off}
                label={t(`adminSettings.botProtection.surfaces.${surface.id}.label`)}
                description={t(`adminSettings.botProtection.surfaces.${surface.id}.description`)}
                onChange={(checked) => updateSurfaces({ [surface.key]: checked ? 'on' : 'off' } as Partial<CaptchaSurfaces>)}
              />
            ))}
          </div>
          <div className="rounded-xl border border-border-subtle bg-surface-container/40 p-4">
            <ChoiceGroup
              name={`${ids}-login`}
              legend={t('adminSettings.botProtection.surfaces.login.label')}
              description={t('adminSettings.botProtection.surfaces.login.description')}
              value={draft.surfaces.login}
              disabled={off}
              onChange={(value) => updateSurfaces({ login: value })}
              choices={[
                { value: 'off', label: t('adminSettings.botProtection.surfaces.login.off') },
                { value: 'adaptive', label: t('adminSettings.botProtection.surfaces.login.adaptive') },
                { value: 'always', label: t('adminSettings.botProtection.surfaces.login.always') },
              ]}
            />
            {draft.surfaces.login === 'adaptive' ? (
              <div className="mt-4 max-w-xs">
                <label htmlFor={`${ids}-threshold`} className={fieldLabel}>
                  {t('adminSettings.botProtection.surfaces.threshold')}
                </label>
                <input
                  id={`${ids}-threshold`}
                  type="number"
                  inputMode="numeric"
                  min={THRESHOLD.min}
                  max={THRESHOLD.max}
                  step={1}
                  value={draft.options.loginFailureThreshold}
                  disabled={off}
                  aria-describedby={`${ids}-threshold-hint`}
                  onChange={(event) => {
                    const value = Math.round(Number(event.target.value));
                    if (Number.isFinite(value)) {
                      updateOptions({ loginFailureThreshold: Math.min(THRESHOLD.max, Math.max(THRESHOLD.min, value)) });
                    }
                  }}
                  className={inputClass}
                />
                <p id={`${ids}-threshold-hint`} className="mt-1.5 text-xs text-text-muted">
                  {t('adminSettings.botProtection.surfaces.thresholdHint')}
                </p>
              </div>
            ) : null}
          </div>
        </fieldset>
      </Section>

      {/* Attack mode */}
      <Section title={t('adminSettings.botProtection.attack.title')}>
        <Toggle
          checked={draft.attackMode}
          disabled={off}
          label={t('adminSettings.botProtection.attack.label')}
          description={t('adminSettings.botProtection.attack.description')}
          onChange={(checked) => update({ attackMode: checked })}
        />
        {autoAttack ? (
          <p role="status" className="mt-3 flex gap-2 rounded-xl border border-ember/40 bg-ember/10 px-3.5 py-2.5 text-sm text-text-primary">
            <span className="material-symbols-outlined text-lg text-ember" aria-hidden>
              shield
            </span>
            <span className="text-pretty">
              {t('adminSettings.botProtection.attack.auto', { time: formatTime(t, autoAttack) })}
            </span>
          </p>
        ) : null}
      </Section>

      {/* Test */}
      <Section title={t('adminSettings.botProtection.test.title')}>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <button
            type="button"
            onClick={() => void runTest()}
            disabled={test.state === 'running' || off}
            className={`${secondaryButton} inline-flex shrink-0 items-center justify-center gap-2 px-4 py-2`}
          >
            <span className="material-symbols-outlined text-lg" aria-hidden>
              network_check
            </span>
            {test.state === 'running' ? t('adminSettings.botProtection.test.running') : t('adminSettings.botProtection.test.button')}
          </button>
          <div className="min-h-5 min-w-0 text-sm" aria-live="polite">
            {test.state === 'done' ? <TestOutcome result={test.result} detail={test.detail} /> : null}
            {test.state === 'error' ? <span className="text-danger">{t('adminSettings.botProtection.test.failed')}</span> : null}
          </div>
        </div>
        {dirty && external ? (
          <p className="mt-2 text-xs text-text-muted">{t('adminSettings.botProtection.test.unsavedNote')}</p>
        ) : null}
      </Section>

      {/* Save */}
      <div className="mt-5 flex flex-col gap-3 border-t border-border-subtle pt-5 sm:flex-row sm:items-center sm:justify-between">
        <p className="min-h-5 text-sm" aria-live="polite">
          {save.state === 'saved' ? <span className="text-success">{t('adminSettings.botProtection.saved')}</span> : null}
          {save.state === 'error' ? <span className="text-danger">{save.message}</span> : null}
          {save.state === 'idle' && dirty ? <span className="text-text-secondary">{t('adminSettings.botProtection.unsaved')}</span> : null}
        </p>
        <div className="flex gap-2">
          <button type="button" onClick={resetDraft} disabled={!dirty || saving} className={`${secondaryButton} px-4 py-2`}>
            {t('adminSettings.common.reset')}
          </button>
          <button
            type="button"
            onClick={() => void saveSettings()}
            disabled={!dirty || saving}
            className={`rounded-lg bg-primary-container px-4 py-2 text-sm font-semibold text-on-primary-container transition-all hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40 ${focusRing}`}
          >
            {saving ? t('adminSettings.common.saving') : t('adminSettings.botProtection.save')}
          </button>
        </div>
      </div>

      {privacyFor ? (
        <PrivacyNoticeDialog
          provider={privacyFor}
          notices={notices}
          onCancel={() => setPrivacyFor(null)}
          onConfirm={() => {
            update({ provider: privacyFor });
            setPrivacyFor(null);
          }}
        />
      ) : null}
    </section>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="mt-5 border-t border-border-subtle pt-5">
      <h3 className="mb-3 text-sm font-semibold text-text-primary">{title}</h3>
      {children}
    </div>
  );
}

function LockedNote({ name }: { name: string }) {
  const t = useT();
  return (
    <p className="mt-2 flex items-center gap-1.5 text-xs text-text-muted">
      <span className="material-symbols-outlined text-sm" aria-hidden>
        lock
      </span>
      <span>{t('adminSettings.botProtection.lockedBy', { name })}</span>
    </p>
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

function ChoiceGroup<T extends string>(props: {
  name: string;
  legend: string;
  description?: string;
  value: T;
  disabled?: boolean;
  choices: Array<{ value: T; label: string }>;
  onChange: (value: T) => void;
}) {
  return (
    <fieldset disabled={props.disabled} className="min-w-0">
      <legend className="text-sm font-medium text-text-primary">{props.legend}</legend>
      {props.description ? <p className="mt-1 text-sm text-text-secondary">{props.description}</p> : null}
      <div className="mt-3 flex flex-wrap gap-2">
        {props.choices.map((choice) => {
          const active = props.value === choice.value;
          return (
            <label
              key={choice.value}
              className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-sm transition-colors focus-within:outline focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-primary ${
                props.disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'
              } ${
                active
                  ? 'border-primary-container bg-primary-container/10 text-text-primary'
                  : 'border-border-subtle bg-surface-container/40 text-text-secondary hover:bg-surface-raised/50'
              }`}
            >
              <input
                type="radio"
                name={props.name}
                value={choice.value}
                checked={active}
                onChange={() => props.onChange(choice.value)}
              />
              {choice.label}
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

function SecretField({
  id,
  saved,
  action,
  onChange,
}: {
  id: string;
  saved: AdminCaptchaSettings;
  action: SecretAction;
  onChange: (next: SecretAction) => void;
}) {
  const t = useT();
  const label = (
    <label htmlFor={id} className={fieldLabel}>
      {t('adminSettings.botProtection.keys.secretKey')}
    </label>
  );
  const hint = (
    <p id={`${id}-hint`} className="mt-1.5 text-xs text-text-muted">
      {t('adminSettings.botProtection.keys.secretHint')}
    </p>
  );

  if (saved.locked.secretKey) {
    return (
      <>
        <span className={fieldLabel}>{t('adminSettings.botProtection.keys.secretKey')}</span>
        <p className="rounded-lg border border-border-subtle bg-surface-raised px-3 py-2 text-sm text-text-secondary">
          {t('adminSettings.botProtection.keys.secretFromEnv')}
        </p>
        <LockedNote name={LOCK_ENV.secretKey} />
      </>
    );
  }

  if (saved.secretSet && action.kind === 'keep') {
    return (
      <>
        <span className={fieldLabel}>{t('adminSettings.botProtection.keys.secretKey')}</span>
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border-subtle bg-surface-raised px-3 py-1.5">
          <span className="text-sm text-text-secondary">
            {saved.secretHint
              ? t('adminSettings.botProtection.keys.secretSaved', { hint: saved.secretHint })
              : t('adminSettings.botProtection.keys.secretSavedNoHint')}
          </span>
          <span className="flex gap-2">
            <button type="button" onClick={() => onChange({ kind: 'replace', value: '' })} className={secondaryButton}>
              {t('adminSettings.botProtection.keys.replace')}
            </button>
            <button type="button" onClick={() => onChange({ kind: 'clear' })} className={secondaryButton}>
              {t('adminSettings.botProtection.keys.clear')}
            </button>
          </span>
        </div>
        {hint}
      </>
    );
  }

  if (action.kind === 'clear') {
    return (
      <>
        <span className={fieldLabel}>{t('adminSettings.botProtection.keys.secretKey')}</span>
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-danger/40 bg-danger/10 px-3 py-1.5">
          <span className="text-sm text-text-primary">{t('adminSettings.botProtection.keys.clearPending')}</span>
          <button type="button" onClick={() => onChange({ kind: 'keep' })} className={secondaryButton}>
            {t('adminSettings.botProtection.keys.undo')}
          </button>
        </div>
      </>
    );
  }

  const value = action.kind === 'replace' ? action.value : '';
  return (
    <>
      {label}
      <div className="flex gap-2">
        <input
          id={id}
          type="password"
          value={value}
          onChange={(event) => onChange({ kind: 'replace', value: event.target.value })}
          autoComplete="new-password"
          spellCheck={false}
          maxLength={512}
          data-1p-ignore="true"
          data-lpignore="true"
          placeholder={
            saved.secretSet
              ? t('adminSettings.botProtection.keys.newSecretPlaceholder')
              : t('adminSettings.botProtection.keys.secretNotSet')
          }
          aria-describedby={`${id}-hint`}
          className={`${inputClass} font-mono`}
        />
        {saved.secretSet ? (
          <button type="button" onClick={() => onChange({ kind: 'keep' })} className={`${secondaryButton} shrink-0`}>
            {t('adminSettings.botProtection.keys.keepSaved')}
          </button>
        ) : null}
      </div>
      {hint}
    </>
  );
}

const TEST_RESULT_KEYS: Record<CaptchaTestResult, string> = {
  ok: 'adminSettings.botProtection.test.result.ok',
  bad_secret: 'adminSettings.botProtection.test.result.badSecret',
  unreachable: 'adminSettings.botProtection.test.result.unreachable',
  missing_keys: 'adminSettings.botProtection.test.result.missingKeys',
  not_applicable: 'adminSettings.botProtection.test.result.notApplicable',
};

/** The test's `detail` codes we explain; any other code adds nothing (it is not shown raw). */
const TEST_DETAIL_KEYS: Record<string, string> = {
  secret_undecryptable: 'adminSettings.botProtection.test.detail.secretUndecryptable',
  missing_site_key: 'adminSettings.botProtection.test.detail.missingSiteKey',
  missing_secret_key: 'adminSettings.botProtection.test.detail.missingSecretKey',
  missing_both: 'adminSettings.botProtection.test.detail.missingBoth',
  test_keys: 'adminSettings.botProtection.test.detail.testKeys',
  recaptcha_reachability_only: 'adminSettings.botProtection.test.detail.recaptchaReachabilityOnly',
};

function TestOutcome({ result, detail }: { result: CaptchaTestResult; detail: string | null }) {
  const t = useT();
  const detailKey = detail && Object.hasOwn(TEST_DETAIL_KEYS, detail) ? TEST_DETAIL_KEYS[detail] : null;
  const tone = result === 'ok' ? 'text-success' : result === 'not_applicable' ? 'text-text-secondary' : 'text-danger';
  const icon = result === 'ok' ? 'check_circle' : result === 'not_applicable' ? 'info' : 'error';
  return (
    <span className={`flex items-start gap-1.5 ${tone}`}>
      <span className="material-symbols-outlined text-lg" aria-hidden>
        {icon}
      </span>
      <span className="min-w-0">
        <span className="block">{t(TEST_RESULT_KEYS[result])}</span>
        {detailKey ? <span className="mt-0.5 block text-pretty text-xs text-text-secondary">{t(detailKey)}</span> : null}
      </span>
    </span>
  );
}
