'use client';

import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import { useT } from '@/lib/i18n/client';
import type { Translator } from '@/lib/i18n/core';
import { MAIL_PROVIDERS } from '@/lib/mail/providers';
import {
  LOCK_ENV,
  applyPort,
  applyPreset,
  buildPutBody,
  buildTestBody,
  draftFrom,
  draftIssues,
  groupProviders,
  hostForPreset,
  isConnectionDirty,
  isDirty,
  parseAdminMailSettings,
  parseTestOutcome,
  breaksRequiredTransport,
  passwordMissing,
  passwordMustBeReentered,
  reenablingRequiredSince,
  requiredBlockedReason,
  transportLockedByRequired,
  type AdminMailSettings,
  type EmailVerificationMode,
  type LockableField,
  type MailDraft,
  type MailProviderPreset,
  type MailTestDetail,
  type MailTestOutcome,
  type MailTestResult,
  type SecretAction,
  type SmtpSecurity,
} from './mail-settings-model';
import {
  ChoiceCards,
  LockedNote,
  Note,
  Section,
  Toggle,
  fieldLabel,
  focusRing,
  hintClass,
  inputClass,
  primaryButton,
  secondaryButton,
} from './parts';

const ENDPOINT = '/api/admin/mail';

type SaveState = { state: 'idle' | 'saving' | 'saved' } | { state: 'error'; message: string };
type TestState = { state: 'idle' | 'running' } | { state: 'error'; message: string } | ({ state: 'done' } & MailTestOutcome);

/** Every test result in words (§5) — the record type makes a new code a compile error until it is here. */
const TEST_RESULT_KEYS: Record<MailTestResult, string> = {
  ok: 'adminSettings.email.test.result.ok',
  timeout: 'adminSettings.email.test.result.timeout',
  tls: 'adminSettings.email.test.result.tls',
  auth: 'adminSettings.email.test.result.auth',
  sender_rejected: 'adminSettings.email.test.result.senderRejected',
  recipient_rejected: 'adminSettings.email.test.result.recipientRejected',
  connection: 'adminSettings.email.test.result.connection',
  host_not_allowed: 'adminSettings.email.test.result.hostNotAllowed',
  not_configured: 'adminSettings.email.test.result.notConfigured',
};

/** Every `detail` code (lib/mail/types.ts MAIL_TEST_DETAILS) in words. */
const TEST_DETAIL_KEYS: Record<MailTestDetail, string> = {
  try_port_2525: 'adminSettings.email.test.detail.tryPort2525',
  try_port_2587: 'adminSettings.email.test.detail.tryPort2587',
  use_starttls: 'adminSettings.email.test.detail.useStarttls',
  use_tls: 'adminSettings.email.test.detail.useTls',
  tls_certificate: 'adminSettings.email.test.detail.tlsCertificate',
  check_credentials: 'adminSettings.email.test.detail.checkCredentials',
  gmail_app_password: 'adminSettings.email.test.detail.gmailAppPassword',
  sender_domain: 'adminSettings.email.test.detail.senderDomain',
  message_rejected: 'adminSettings.email.test.detail.messageRejected',
  host_not_found: 'adminSettings.email.test.detail.hostNotFound',
  connection_refused: 'adminSettings.email.test.detail.connectionRefused',
  port_not_allowed: 'adminSettings.email.test.detail.portNotAllowed',
  address_not_allowed: 'adminSettings.email.test.detail.addressNotAllowed',
  security_not_allowed: 'adminSettings.email.test.detail.securityNotAllowed',
  invalid_host: 'adminSettings.email.test.detail.invalidHost',
  missing_host: 'adminSettings.email.test.detail.missingHost',
  missing_port: 'adminSettings.email.test.detail.missingPort',
  missing_from: 'adminSettings.email.test.detail.missingFrom',
  missing_recipient: 'adminSettings.email.test.detail.missingRecipient',
  password_undecryptable: 'adminSettings.email.test.detail.passwordUndecryptable',
};

export function testResultKey(result: MailTestResult): string {
  return TEST_RESULT_KEYS[result];
}

/** A detail code we explain, or null (an unknown code adds nothing; it is never shown raw). */
export function testDetailKey(detail: string | null): string | null {
  return detail && Object.hasOwn(TEST_DETAIL_KEYS, detail) ? TEST_DETAIL_KEYS[detail as MailTestDetail] : null;
}

const FIELD_LABEL_KEYS: Record<string, string> = {
  provider: 'adminSettings.email.provider.legend',
  region: 'adminSettings.email.connection.region',
  host: 'adminSettings.email.connection.host',
  port: 'adminSettings.email.connection.port',
  security: 'adminSettings.email.connection.security',
  username: 'adminSettings.email.connection.username',
  password: 'adminSettings.email.connection.password',
  from: 'adminSettings.email.connection.from',
  dailyLimit: 'adminSettings.email.limit.label',
  verification: 'adminSettings.email.verification.title',
  disposable: 'adminSettings.email.disposable.title',
};

function issueFields(t: Translator, issues: unknown): string {
  if (!Array.isArray(issues)) return '';
  const names = new Set<string>();
  for (const issue of issues) {
    const path = typeof issue === 'object' && issue !== null ? (issue as { path?: unknown }).path : null;
    const first = Array.isArray(path) ? String(path[0] ?? '') : typeof path === 'string' ? path.split('.')[0] ?? '' : '';
    if (first && Object.hasOwn(FIELD_LABEL_KEYS, first)) names.add(t(FIELD_LABEL_KEYS[first]!));
  }
  return [...names].join(', ');
}

function lockedMessage(t: Translator, body: Record<string, unknown>): string {
  const field = typeof body.field === 'string' ? body.field : '';
  const name = Object.hasOwn(LOCK_ENV, field) ? LOCK_ENV[field as LockableField] : field;
  return t('adminSettings.email.error.locked', { name });
}

/** A missing re-entered password, however the server names it. */
function isPasswordRequired(body: Record<string, unknown>): boolean {
  if (body.error === 'password_required' || body.detail === 'password_required') return true;
  return (
    body.error === 'invalid_settings' &&
    Array.isArray(body.issues) &&
    body.issues.some((issue) => {
      const record = typeof issue === 'object' && issue !== null ? (issue as { path?: unknown; message?: unknown }) : {};
      const path = Array.isArray(record.path) ? record.path.join('.') : String(record.path ?? '');
      return path === 'password' && (record.message === 'required' || record.message === 'password_required');
    })
  );
}

export function saveErrorMessage(t: Translator, status: number, body: Record<string, unknown>): string {
  if (body.error === 'locked_by_env') return lockedMessage(t, body);
  if (body.error === 'transport_required') return t('adminSettings.email.error.transportRequired');
  if (isPasswordRequired(body)) return t('adminSettings.email.error.passwordRequired');
  if (status === 409 && body.error === 'test_required') return t('adminSettings.email.error.testRequired');
  if (status === 400 && body.error === 'host_not_allowed') {
    const detail = testDetailKey(typeof body.detail === 'string' ? body.detail : null);
    return detail ? `${t('adminSettings.email.error.hostNotAllowed')} ${t(detail)}` : t('adminSettings.email.error.hostNotAllowed');
  }
  if (status === 400 && body.error === 'invalid_settings') {
    const fields = issueFields(t, body.issues);
    return fields ? t('adminSettings.email.error.invalidFields', { fields }) : t('adminSettings.email.error.invalid');
  }
  if (status === 503) return t('adminSettings.email.error.unavailable');
  return t('adminSettings.email.saveFailed');
}

/** Why a test was not run at all (the request was refused, not the SMTP server). */
export function testRefusalMessage(t: Translator, body: Record<string, unknown>): string {
  if (body.error === 'locked_by_env') return lockedMessage(t, body);
  if (isPasswordRequired(body)) return t('adminSettings.email.error.passwordRequired');
  if (body.error === 'invalid_settings') return t('adminSettings.email.error.invalid');
  return t('adminSettings.email.test.failed');
}

function formatTime(t: Translator, iso: string): string {
  return new Intl.DateTimeFormat(t.locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso));
}

function formatDate(t: Translator, iso: string): string {
  return new Intl.DateTimeFormat(t.locale, { dateStyle: 'long' }).format(new Date(iso));
}

const SECURITY_LABEL: Record<SmtpSecurity, string> = {
  tls: 'TLS',
  starttls: 'STARTTLS',
  none: '',
};

function securityText(t: Translator, security: SmtpSecurity): string {
  return security === 'none' ? t('adminSettings.email.security.none') : SECURITY_LABEL[security];
}

function regionLabel(t: Translator, id: string): string {
  if (id === 'global') return t('adminSettings.email.connection.regionGlobal');
  return /^[a-z]{2}$/.test(id) ? id.toUpperCase() : id;
}

/** "300 emails a day", "1,000 emails a month, at most 200 a day". */
export function freeLimitText(t: Translator, freeTier: MailProviderPreset['freeTier']): string | null {
  if (!freeTier) return null;
  const { perDay, perMonth } = freeTier;
  if (perMonth && perDay) return t('adminSettings.email.limitFree.monthAndDay', { month: perMonth, day: perDay });
  if (perMonth) return t('adminSettings.email.limitFree.month', { count: perMonth });
  if (perDay) return t('adminSettings.email.limitFree.day', { count: perDay });
  return null;
}

const TIERS = ['professional', 'free', 'custom', 'development'] as const;

/**
 * Admin → Settings → Email (docs/EMAIL.md §5.1). Loads and saves through
 * `/api/admin/mail`. The provider picker is rendered from the registry
 * (`lib/mail/providers.ts`): choosing a preset fills host, port and
 * security and shows its hints, limits and data-region note. The SMTP
 * password is write-only; the API only says whether one is set and its
 * last characters.
 */
export default function EmailSettingsCard({ providers }: { providers: readonly MailProviderPreset[] }) {
  const t = useT();
  const ids = useId();
  const [load, setLoad] = useState<'loading' | 'error' | 'ready'>('loading');
  const [saved, setSaved] = useState<AdminMailSettings | null>(null);
  const [draft, setDraft] = useState<MailDraft | null>(null);
  const [secret, setSecret] = useState<SecretAction>({ kind: 'keep' });
  const [save, setSave] = useState<SaveState>({ state: 'idle' });
  const [test, setTest] = useState<TestState>({ state: 'idle' });
  const [testTo, setTestTo] = useState('');

  const apply = useCallback((settings: AdminMailSettings) => {
    setSaved(settings);
    setDraft(draftFrom(settings));
    setSecret({ kind: 'keep' });
  }, []);

  const fetchSettings = useCallback(async () => {
    setLoad('loading');
    try {
      const response = await fetch(ENDPOINT, { credentials: 'same-origin', cache: 'no-store' });
      const parsed = response.ok ? parseAdminMailSettings(await response.json()) : null;
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

  // The saved provider stays choosable even where the registry would not
  // offer it now (mailpit configured on a server that later went to production).
  const offered = useMemo(() => {
    const list = [...providers];
    const current = saved ? MAIL_PROVIDERS.find((preset) => preset.id === saved.provider) : undefined;
    if (current && !list.some((preset) => preset.id === current.id)) list.push(current);
    return list;
  }, [providers, saved]);
  const groups = useMemo(() => groupProviders(offered), [offered]);

  const header = (
    <div className="mb-4">
      <h2 id={`${ids}-title`} className="text-base font-semibold text-text-primary">
        {t('adminSettings.email.card.title')}
      </h2>
      <p className="mt-1 max-w-2xl text-pretty text-sm text-text-secondary">{t('adminSettings.email.card.description')}</p>
    </div>
  );

  if (load !== 'ready' || !saved || !draft) {
    return (
      <section aria-labelledby={`${ids}-title`} className="rounded-xl border border-border-subtle bg-surface p-5">
        {header}
        {load === 'error' ? (
          <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-danger/40 bg-danger/10 p-4">
            <p className="text-sm text-text-primary">{t('adminSettings.email.loadFailed')}</p>
            <button type="button" onClick={() => void fetchSettings()} className={secondaryButton}>
              {t('adminSettings.email.retry')}
            </button>
          </div>
        ) : (
          <p role="status" className="text-sm text-text-muted">
            {t('adminSettings.email.loading')}
          </p>
        )}
      </section>
    );
  }

  const preset = offered.find((item) => item.id === draft.provider) ?? null;
  const off = draft.provider === 'none';
  const dirty = isDirty(saved, draft, secret);
  const connectionDirty = isConnectionDirty(saved, draft, secret);
  const saving = save.state === 'saving';
  const blocked = requiredBlockedReason(saved, draft, secret);
  // While Required is chosen, mail must keep working (no "No email", no clearing the password).
  const requiredOn = transportLockedByRequired(draft);
  const mustReenter = passwordMustBeReentered(saved, draft);
  const passwordGap = passwordMissing(saved, draft, secret);
  const reenabledSince = reenablingRequiredSince(saved, draft);
  const issues = draftIssues(draft);
  const fixedHost = Boolean(preset && preset.tier !== 'custom' && preset.tier !== 'development');
  const presetPorts = preset && preset.tier !== 'custom' ? preset.ports : null;
  const dailyLimit = saved.dailyLimit;

  function update(patch: Partial<MailDraft>) {
    setDraft((current) => (current ? { ...current, ...patch } : current));
    setSave({ state: 'idle' });
  }

  function chooseProvider(id: string) {
    if (!draft || id === draft.provider) return;
    const next = id === 'none' ? null : offered.find((item) => item.id === id) ?? null;
    setDraft(applyPreset(draft, next, id));
    setSave({ state: 'idle' });
    setTest({ state: 'idle' });
  }

  function changeSecret(next: SecretAction) {
    setSecret(next);
    setSave({ state: 'idle' });
  }

  function resetDraft() {
    if (!saved) return;
    apply(saved);
    setSave({ state: 'idle' });
  }

  async function saveSettings() {
    if (!saved || !draft) return;
    if (breaksRequiredTransport(saved, draft, secret)) {
      setSave({ state: 'error', message: t('adminSettings.email.error.transportRequired') });
      return;
    }
    if (passwordMissing(saved, draft, secret)) {
      setSave({ state: 'error', message: t('adminSettings.email.error.passwordRequired') });
      return;
    }
    if (draftIssues(draft).length > 0) {
      setSave({ state: 'error', message: t('adminSettings.email.error.fixFields') });
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
      const parsed = response.ok ? parseAdminMailSettings(body) : null;
      if (parsed) {
        apply(parsed);
        setSave({ state: 'saved' });
        return;
      }
      setSave({ state: 'error', message: saveErrorMessage(t, response.status, body) });
    } catch {
      setSave({ state: 'error', message: t('adminSettings.email.saveFailed') });
    }
  }

  async function runTest() {
    if (!saved || !draft) return;
    // The stored password is not tried against another server.
    if (passwordMissing(saved, draft, secret)) {
      setTest({ state: 'error', message: t('adminSettings.email.error.passwordRequired') });
      return;
    }
    setTest({ state: 'running' });
    const againstSaved = !isConnectionDirty(saved, draft, secret);
    try {
      const response = await fetch(`${ENDPOINT}/test`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(buildTestBody(saved, draft, secret, testTo)),
      });
      const answer = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      const parsed = response.ok ? parseTestOutcome(answer) : null;
      if (!parsed) {
        setTest({ state: 'error', message: response.ok ? t('adminSettings.email.test.failed') : testRefusalMessage(t, answer) });
        return;
      }
      setTest({ state: 'done', ...parsed });
      // Only a test of the SAVED settings is recorded (§5) — and it is what unlocks `required`.
      if (againstSaved) setSaved((current) => (current ? { ...current, lastTest: { at: new Date().toISOString(), result: parsed.result } } : current));
    } catch {
      setTest({ state: 'error', message: t('adminSettings.email.test.failed') });
    }
  }

  const modeChoices: Array<{ value: EmailVerificationMode; label: string; description: string; disabled?: boolean }> = [
    {
      value: 'off',
      label: t('adminSettings.email.verification.off.label'),
      description: t('adminSettings.email.verification.off.description'),
    },
    {
      value: 'optional',
      label: t('adminSettings.email.verification.optional.label'),
      description: t('adminSettings.email.verification.optional.description'),
    },
    {
      value: 'required',
      label: t('adminSettings.email.verification.required.label'),
      description: t('adminSettings.email.verification.required.description'),
      disabled: blocked !== 'none' && draft.mode !== 'required',
    },
  ];

  return (
    <section aria-labelledby={`${ids}-title`} className="rounded-xl border border-border-subtle bg-surface p-5">
      {header}

      {/* Provider */}
      <fieldset disabled={saved.locked.provider} className="min-w-0">
        <legend className="mb-3 text-sm font-semibold text-text-primary">{t('adminSettings.email.provider.legend')}</legend>
        <ProviderOption
          name={`${ids}-provider`}
          value="none"
          checked={off}
          locked={saved.locked.provider}
          disabled={requiredOn && !off}
          describedBy={requiredOn && !off ? ids + '-none-why' : undefined}
          title={t('adminSettings.email.provider.none.title')}
          line={t('adminSettings.email.provider.none.description')}
          onChoose={chooseProvider}
        />
        {requiredOn && !off ? (
          <p id={ids + '-none-why'} className="mt-2 flex gap-2 text-sm text-text-secondary">
            <span className="material-symbols-outlined text-lg text-text-muted" aria-hidden>
              lock
            </span>
            <span className="text-pretty">{t('adminSettings.email.provider.noneBlockedByRequired')}</span>
          </p>
        ) : null}
        {TIERS.map((tier) =>
          groups[tier].length > 0 ? (
            <div key={tier} className="mt-5">
              <p className="text-xs font-semibold uppercase tracking-wider text-text-secondary">
                {t(`adminSettings.email.provider.tier.${tier}.title`)}
              </p>
              <p className="mt-1 text-pretty text-sm text-text-secondary">{t(`adminSettings.email.provider.tier.${tier}.description`)}</p>
              <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {groups[tier].map((item) => (
                  <ProviderOption
                    key={item.id}
                    name={`${ids}-provider`}
                    value={item.id}
                    checked={draft.provider === item.id}
                    locked={saved.locked.provider}
                    title={item.id === 'custom' ? t('adminSettings.email.provider.custom.title') : item.name}
                    line={
                      freeLimitText(t, item.freeTier) ??
                      (item.tier === 'professional'
                        ? t('adminSettings.email.provider.payAsYouGo')
                        : t(`adminSettings.email.provider.${item.tier === 'development' ? 'mailpit' : 'custom'}.description`))
                    }
                    onChoose={chooseProvider}
                  />
                ))}
              </div>
            </div>
          ) : null
        )}
        {saved.locked.provider ? <LockedNote name={LOCK_ENV.provider} /> : null}
      </fieldset>

      {/* About the chosen provider */}
      {preset ? (
        <div className="mt-5 space-y-2 rounded-xl border border-border-subtle bg-surface-container/40 p-4" data-testid="provider-notes">
          <a
            href={preset.docsUrl}
            target="_blank"
            rel="noopener noreferrer"
            className={`inline-flex items-center gap-1.5 rounded-sm text-sm font-medium text-primary underline-offset-4 hover:underline ${focusRing}`}
          >
            {t('adminSettings.email.provider.docs', {
              name: preset.id === 'custom' ? t('adminSettings.email.provider.custom.docsName') : preset.name,
            })}
            <span className="material-symbols-outlined text-[16px]" aria-hidden>
              open_in_new
            </span>
            <span className="sr-only">{t('auth.official.newTab')}</span>
          </a>
          {preset.freeTier?.noteKey ? <Note icon="savings">{t(preset.freeTier.noteKey)}</Note> : null}
          {preset.pricingNoteKey ? <Note icon="payments">{t(preset.pricingNoteKey)}</Note> : null}
          {preset.dataRegionNoteKey ? <Note icon="public">{t(preset.dataRegionNoteKey)}</Note> : null}
          {preset.crossBorder ? (
            <Note icon="policy" tone="warning">
              {t('adminSettings.email.kvkk', { name: preset.name })}
            </Note>
          ) : null}
        </div>
      ) : null}

      {/* Connection */}
      {!off ? (
        <Section title={t('adminSettings.email.connection.title')}>
          <div className="grid gap-4 md:grid-cols-2">
            {preset?.regions?.length ? (
              <div className="min-w-0">
                <label htmlFor={`${ids}-region`} className={fieldLabel}>
                  {t('adminSettings.email.connection.region')}
                </label>
                <select
                  id={`${ids}-region`}
                  value={draft.region ?? preset.regions[0]!.id}
                  disabled={saved.locked.host}
                  onChange={(event) => update({ region: event.target.value, host: hostForPreset(preset, event.target.value) })}
                  className={inputClass}
                >
                  {preset.regions.map((region) => (
                    <option key={region.id} value={region.id}>
                      {regionLabel(t, region.id)}
                    </option>
                  ))}
                </select>
              </div>
            ) : null}
            <div className="min-w-0">
              <label htmlFor={`${ids}-host`} className={fieldLabel}>
                {t('adminSettings.email.connection.host')}
              </label>
              <input
                id={`${ids}-host`}
                value={draft.host}
                readOnly={saved.locked.host || fixedHost}
                onChange={(event) => update({ host: event.target.value })}
                autoComplete="off"
                spellCheck={false}
                maxLength={253}
                aria-invalid={issues.includes('host') || undefined}
                className={`${inputClass} font-mono`}
              />
              {saved.locked.host ? <LockedNote name={LOCK_ENV.host} /> : null}
            </div>
            <div className="min-w-0">
              <label htmlFor={`${ids}-port`} className={fieldLabel}>
                {t('adminSettings.email.connection.port')}
              </label>
              {presetPorts && !saved.locked.port ? (
                <select
                  id={`${ids}-port`}
                  value={draft.port}
                  disabled={saved.locked.security}
                  onChange={(event) => setDraft(applyPort(draft, preset, event.target.value))}
                  className={inputClass}
                >
                  {presetPorts.map((option, index) => (
                    <option key={option.port} value={String(option.port)}>
                      {index === 0
                        ? t('adminSettings.email.connection.portRecommended', {
                            port: option.port,
                            security: securityText(t, option.security),
                          })
                        : t('adminSettings.email.connection.portOption', {
                            port: option.port,
                            security: securityText(t, option.security),
                          })}
                    </option>
                  ))}
                  {draft.port && !presetPorts.some((option) => String(option.port) === draft.port) ? (
                    <option value={draft.port}>
                      {t('adminSettings.email.connection.portOption', { port: draft.port, security: securityText(t, draft.security) })}
                    </option>
                  ) : null}
                </select>
              ) : (
                <input
                  id={`${ids}-port`}
                  value={draft.port}
                  readOnly={saved.locked.port}
                  onChange={(event) => update({ port: event.target.value.replace(/\D/g, '').slice(0, 5) })}
                  inputMode="numeric"
                  autoComplete="off"
                  aria-invalid={issues.includes('port') || undefined}
                  aria-describedby={`${ids}-port-hint`}
                  className={inputClass}
                />
              )}
              {saved.locked.port ? <LockedNote name={LOCK_ENV.port} /> : null}
              {!presetPorts ? (
                <p id={`${ids}-port-hint`} className={hintClass}>
                  {t('adminSettings.email.connection.portHint')}
                </p>
              ) : null}
            </div>
            <div className="min-w-0">
              <label htmlFor={`${ids}-security`} className={fieldLabel}>
                {t('adminSettings.email.connection.security')}
              </label>
              <select
                id={`${ids}-security`}
                value={draft.security}
                // A preset's port decides its security; a custom server picks it.
                disabled={saved.locked.security || Boolean(presetPorts)}
                onChange={(event) => update({ security: event.target.value as SmtpSecurity })}
                className={inputClass}
              >
                <option value="starttls">STARTTLS</option>
                <option value="tls">TLS</option>
                <option value="none">{t('adminSettings.email.security.none')}</option>
              </select>
              {saved.locked.security ? <LockedNote name={LOCK_ENV.security} /> : null}
            </div>
            <div className="min-w-0">
              <label htmlFor={`${ids}-username`} className={fieldLabel}>
                {t('adminSettings.email.connection.username')}
              </label>
              <input
                id={`${ids}-username`}
                value={draft.username}
                readOnly={saved.locked.username}
                onChange={(event) => update({ username: event.target.value })}
                autoComplete="off"
                spellCheck={false}
                maxLength={320}
                aria-describedby={preset ? `${ids}-username-hint` : undefined}
                data-1p-ignore="true"
                data-lpignore="true"
                className={`${inputClass} font-mono`}
              />
              {saved.locked.username ? <LockedNote name={LOCK_ENV.username} /> : null}
              {preset ? (
                <p id={`${ids}-username-hint`} className={hintClass}>
                  {t(preset.usernameHint)}
                </p>
              ) : null}
            </div>
            <div className="min-w-0">
              <PasswordField
                id={`${ids}-password`}
                saved={saved}
                action={secret}
                hint={preset ? t(preset.passwordHint) : null}
                mustReenter={mustReenter}
                missing={passwordGap}
                clearBlocked={requiredOn}
                onChange={changeSecret}
              />
            </div>
            <div className="min-w-0 md:col-span-2">
              <label htmlFor={`${ids}-from`} className={fieldLabel}>
                {t('adminSettings.email.connection.from')}
              </label>
              <input
                id={`${ids}-from`}
                value={draft.from}
                readOnly={saved.locked.from}
                onChange={(event) => update({ from: event.target.value })}
                autoComplete="off"
                spellCheck={false}
                maxLength={320}
                placeholder="LobbyForge <no-reply@example.org>"
                aria-invalid={issues.includes('from') || undefined}
                aria-describedby={`${ids}-from-hint`}
                className={inputClass}
              />
              {saved.locked.from ? <LockedNote name={LOCK_ENV.from} /> : null}
              <p id={`${ids}-from-hint`} className={hintClass}>
                {t('adminSettings.email.connection.fromHint')}
              </p>
            </div>
          </div>
          {issues.some((issue) => issue === 'host' || issue === 'port' || issue === 'from') ? (
            <p className="mt-3 text-sm text-text-secondary">{t('adminSettings.email.connection.incomplete')}</p>
          ) : null}
        </Section>
      ) : (
        <div className="mt-5">
          <Note icon="mail_off">{t('adminSettings.email.offNote')}</Note>
        </div>
      )}

      {/* Sending limit */}
      {!off ? (
        <Section title={t('adminSettings.email.limit.title')}>
          <div className="grid gap-4 md:grid-cols-2">
            <div className="min-w-0">
              <label htmlFor={`${ids}-limit`} className={fieldLabel}>
                {t('adminSettings.email.limit.label')}
              </label>
              <input
                id={`${ids}-limit`}
                value={draft.dailyLimit}
                onChange={(event) => update({ dailyLimit: event.target.value.replace(/\D/g, '').slice(0, 7) })}
                inputMode="numeric"
                autoComplete="off"
                placeholder={t('adminSettings.email.limit.placeholder')}
                aria-invalid={issues.includes('dailyLimit') || undefined}
                aria-describedby={`${ids}-limit-hint`}
                className={inputClass}
              />
              <p id={`${ids}-limit-hint`} className={hintClass}>
                {t('adminSettings.email.limit.hint')}
              </p>
            </div>
            <div className="min-w-0 self-center">
              <p className="text-sm text-text-primary" role="status">
                {dailyLimit
                  ? t('adminSettings.email.limit.sentTodayOf', { count: saved.sentToday, limit: dailyLimit })
                  : t('adminSettings.email.limit.sentToday', { count: saved.sentToday })}
              </p>
            </div>
          </div>
        </Section>
      ) : null}

      {/* Test */}
      {!off ? (
        <Section title={t('adminSettings.email.test.title')} description={t('adminSettings.email.test.description')}>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
            <div className="min-w-0 sm:w-72">
              <label htmlFor={`${ids}-test-to`} className={fieldLabel}>
                {t('adminSettings.email.test.to')}
              </label>
              <input
                id={`${ids}-test-to`}
                type="email"
                value={testTo}
                onChange={(event) => setTestTo(event.target.value)}
                autoComplete="email"
                maxLength={254}
                placeholder={t('adminSettings.email.test.toPlaceholder')}
                className={inputClass}
              />
            </div>
            <button
              type="button"
              onClick={() => void runTest()}
              disabled={test.state === 'running'}
              className={`${secondaryButton} inline-flex shrink-0 items-center justify-center gap-2 px-4 py-2`}
            >
              <span className="material-symbols-outlined text-lg" aria-hidden>
                send
              </span>
              {test.state === 'running' ? t('adminSettings.email.test.running') : t('adminSettings.email.test.button')}
            </button>
          </div>
          <div className="mt-3 min-h-5 min-w-0 text-sm" aria-live="polite">
            {test.state === 'done' ? <TestOutcome result={test.result} detail={test.detail} /> : null}
            {test.state === 'error' ? <span className="text-danger">{test.message}</span> : null}
          </div>
          {connectionDirty ? <p className={hintClass}>{t('adminSettings.email.test.unsavedNote')}</p> : null}
          {saved.lastTest.at && saved.lastTest.result ? (
            <p className="mt-2 text-xs text-text-muted">
              {t('adminSettings.email.test.last', {
                time: formatTime(t, saved.lastTest.at),
                result: t(TEST_RESULT_KEYS[saved.lastTest.result]),
              })}
            </p>
          ) : null}
        </Section>
      ) : null}

      {/* Verification */}
      <Section title={t('adminSettings.email.verification.title')} description={t('adminSettings.email.verification.description')}>
        <ChoiceCards
          name={`${ids}-mode`}
          legend={t('adminSettings.email.verification.title')}
          value={draft.mode}
          disabled={saved.locked.verification}
          choices={modeChoices}
          describedBy={blocked !== 'none' && draft.mode !== 'required' ? `${ids}-required-why` : undefined}
          onChange={(mode) => update({ mode })}
        />
        {saved.locked.verification ? <LockedNote name={LOCK_ENV.verification} /> : null}
        {blocked !== 'none' && draft.mode !== 'required' && !saved.locked.verification ? (
          <p id={`${ids}-required-why`} className="mt-3 flex gap-2 text-sm text-text-secondary">
            <span className="material-symbols-outlined text-lg text-text-muted" aria-hidden>
              lock
            </span>
            <span className="text-pretty">{t(`adminSettings.email.verification.requiredBlocked.${blocked}`)}</span>
          </p>
        ) : null}
        {reenabledSince ? (
          <div className="mt-3" role="status">
            <Note icon="warning" tone="warning">
              {t('adminSettings.email.verification.reenableWarning', { date: formatDate(t, reenabledSince) })}
            </Note>
          </div>
        ) : saved.verification.enforcedSince && saved.verification.mode === 'required' ? (
          <p className="mt-3 text-pretty text-sm text-text-secondary">
            {t('adminSettings.email.verification.enforcedSince', { date: formatDate(t, saved.verification.enforcedSince) })}
          </p>
        ) : null}

        <fieldset className="mt-5 min-w-0" disabled={draft.mode === 'off'}>
          <legend className="text-sm font-medium text-text-primary">{t('adminSettings.email.verification.scope.legend')}</legend>
          <div className="mt-3 grid gap-3 md:grid-cols-2">
            <Toggle
              checked={draft.scope.open_register}
              disabled={draft.mode === 'off'}
              label={t('adminSettings.email.verification.scope.open.label')}
              description={t('adminSettings.email.verification.scope.open.description')}
              onChange={(checked) => update({ scope: { ...draft.scope, open_register: checked } })}
            />
            <Toggle
              checked={draft.scope.invite_register}
              disabled={draft.mode === 'off'}
              label={t('adminSettings.email.verification.scope.invite.label')}
              description={t('adminSettings.email.verification.scope.invite.description')}
              onChange={(checked) => update({ scope: { ...draft.scope, invite_register: checked } })}
            />
          </div>
        </fieldset>

        <div className="mt-5 max-w-sm">
          <label htmlFor={`${ids}-deadline`} className={fieldLabel}>
            {t('adminSettings.email.verification.deadline.label')}
          </label>
          <div className="flex gap-2">
            <input
              id={`${ids}-deadline`}
              type="date"
              value={draft.existingDeadline}
              disabled={draft.mode !== 'required'}
              onChange={(event) => update({ existingDeadline: event.target.value })}
              aria-describedby={`${ids}-deadline-hint`}
              className={inputClass}
            />
            {draft.existingDeadline ? (
              <button type="button" onClick={() => update({ existingDeadline: '' })} className={`${secondaryButton} shrink-0`}>
                {t('adminSettings.email.verification.deadline.clear')}
              </button>
            ) : null}
          </div>
          <p id={`${ids}-deadline-hint`} className={hintClass}>
            {t('adminSettings.email.verification.deadline.hint')}
          </p>
        </div>
      </Section>

      {/* Disposable addresses */}
      <Section title={t('adminSettings.email.disposable.title')}>
        <Toggle
          checked={draft.disposableBlock}
          label={t('adminSettings.email.disposable.block.label')}
          description={t('adminSettings.email.disposable.block.description')}
          onChange={(checked) => update({ disposableBlock: checked })}
        />
        <div className="mt-4 grid gap-4 md:grid-cols-2">
          <DomainList
            id={`${ids}-allow`}
            label={t('adminSettings.email.disposable.allow.label')}
            value={draft.allow}
            invalid={issues.includes('allow')}
            onChange={(allow) => update({ allow })}
          />
          <DomainList
            id={`${ids}-block`}
            label={t('adminSettings.email.disposable.blockExtra.label')}
            value={draft.blockExtra}
            invalid={issues.includes('blockExtra')}
            onChange={(blockExtra) => update({ blockExtra })}
          />
        </div>
        <p className={hintClass}>{t('adminSettings.email.disposable.hint')}</p>
      </Section>

      {/* Save */}
      <div className="mt-5 flex flex-col gap-3 border-t border-border-subtle pt-5 sm:flex-row sm:items-center sm:justify-between">
        <p className="min-h-5 text-sm" aria-live="polite">
          {save.state === 'saved' ? <span className="text-success">{t('adminSettings.email.saved')}</span> : null}
          {save.state === 'error' ? <span className="text-danger">{save.message}</span> : null}
          {save.state === 'idle' && dirty ? <span className="text-text-secondary">{t('adminSettings.email.unsaved')}</span> : null}
        </p>
        <div className="flex gap-2">
          <button type="button" onClick={resetDraft} disabled={!dirty || saving} className={`${secondaryButton} px-4 py-2`}>
            {t('adminSettings.common.reset')}
          </button>
          <button type="button" onClick={() => void saveSettings()} disabled={!dirty || saving} className={primaryButton}>
            {saving ? t('adminSettings.common.saving') : t('adminSettings.email.save')}
          </button>
        </div>
      </div>
    </section>
  );
}

function ProviderOption({
  name,
  value,
  checked,
  locked,
  disabled = false,
  describedBy,
  title,
  line,
  onChoose,
}: {
  name: string;
  value: string;
  checked: boolean;
  locked: boolean;
  disabled?: boolean;
  describedBy?: string;
  title: string;
  line: string;
  onChoose: (value: string) => void;
}) {
  return (
    <label
      className={`flex gap-3 rounded-xl border p-4 transition-colors focus-within:outline focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-primary ${
        locked || disabled ? 'cursor-not-allowed opacity-70' : 'cursor-pointer'
      } ${
        checked ? 'border-primary-container bg-primary-container/10' : 'border-border-subtle bg-surface-container/40 hover:bg-surface-raised/50'
      }`}
    >
      <input
        type="radio"
        name={name}
        value={value}
        checked={checked}
        disabled={disabled}
        aria-describedby={describedBy}
        onChange={() => onChoose(value)}
        className="mt-1"
      />
      <span className="min-w-0">
        <span className="block text-sm font-medium text-text-primary">{title}</span>
        <span className="mt-1 block text-pretty text-sm text-text-secondary">{line}</span>
      </span>
    </label>
  );
}

function DomainList({
  id,
  label,
  value,
  invalid,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  invalid: boolean;
  onChange: (value: string) => void;
}) {
  const t = useT();
  return (
    <div className="min-w-0">
      <label htmlFor={id} className={fieldLabel}>
        {label}
      </label>
      <textarea
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        rows={4}
        spellCheck={false}
        autoComplete="off"
        placeholder="example.org"
        aria-invalid={invalid || undefined}
        aria-describedby={invalid ? `${id}-invalid` : undefined}
        className={`${inputClass} resize-y font-mono`}
      />
      {invalid ? (
        <p id={`${id}-invalid`} className="mt-1.5 text-xs text-danger">
          {t('adminSettings.email.disposable.invalid')}
        </p>
      ) : null}
    </div>
  );
}

function PasswordField({
  id,
  saved,
  action,
  hint,
  mustReenter,
  missing,
  clearBlocked,
  onChange,
}: {
  id: string;
  saved: AdminMailSettings;
  action: SecretAction;
  hint: string | null;
  /** Provider, host or user name changed: the saved password is not reused (it must be typed again). */
  mustReenter: boolean;
  /** …and it has not been typed yet. */
  missing: boolean;
  /** Required mode: clearing the password would stop verification emails. */
  clearBlocked: boolean;
  onChange: (next: SecretAction) => void;
}) {
  const t = useT();
  const label = t('adminSettings.email.connection.password');
  const describedBy = [hint ? id + '-hint' : null, mustReenter ? id + '-reenter' : null].filter(Boolean).join(' ') || undefined;
  const hintLine = hint ? (
    <p id={id + '-hint'} className={hintClass}>
      {hint}
    </p>
  ) : null;
  const reenterLine = mustReenter ? (
    <p id={id + '-reenter'} className={`mt-1.5 flex gap-1.5 text-pretty text-xs ${missing ? 'text-text-primary' : 'text-text-muted'}`}>
      <span className={`material-symbols-outlined text-sm ${missing ? 'text-ember' : 'text-text-muted'}`} aria-hidden>
        key
      </span>
      <span>{t('adminSettings.email.connection.passwordReenter')}</span>
    </p>
  ) : null;

  if (saved.locked.password) {
    return (
      <>
        <span className={fieldLabel}>{label}</span>
        <p className="rounded-lg border border-border-subtle bg-surface-raised px-3 py-2 text-sm text-text-secondary">
          {t('adminSettings.email.connection.passwordFromEnv')}
        </p>
        <LockedNote name={LOCK_ENV.password} />
      </>
    );
  }

  // The saved password, kept — unless the connection changed and it has to be typed again.
  if (saved.passwordSet && action.kind === 'keep' && !mustReenter) {
    return (
      <>
        <span className={fieldLabel}>{label}</span>
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border-subtle bg-surface-raised px-3 py-1.5">
          <span className="text-sm text-text-secondary">
            {saved.passwordHint
              ? t('adminSettings.email.connection.passwordSaved', { hint: saved.passwordHint })
              : t('adminSettings.email.connection.passwordSavedNoHint')}
          </span>
          <span className="flex gap-2">
            <button type="button" onClick={() => onChange({ kind: 'replace', value: '' })} className={secondaryButton}>
              {t('adminSettings.email.connection.passwordReplace')}
            </button>
            <button
              type="button"
              onClick={() => onChange({ kind: 'clear' })}
              disabled={clearBlocked}
              aria-describedby={clearBlocked ? id + '-clear-why' : undefined}
              className={secondaryButton}
            >
              {t('adminSettings.email.connection.passwordClear')}
            </button>
          </span>
        </div>
        {clearBlocked ? (
          <p id={id + '-clear-why'} className={hintClass}>
            {t('adminSettings.email.connection.passwordClearBlocked')}
          </p>
        ) : null}
        {hintLine}
      </>
    );
  }

  if (action.kind === 'clear') {
    return (
      <>
        <span className={fieldLabel}>{label}</span>
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-danger/40 bg-danger/10 px-3 py-1.5">
          <span className="text-sm text-text-primary">{t('adminSettings.email.connection.passwordClearPending')}</span>
          <button type="button" onClick={() => onChange({ kind: 'keep' })} className={secondaryButton}>
            {t('adminSettings.email.connection.passwordUndo')}
          </button>
        </div>
        {clearBlocked ? <p className="mt-1.5 text-xs text-danger">{t('adminSettings.email.connection.passwordClearBlocked')}</p> : null}
      </>
    );
  }

  const value = action.kind === 'replace' ? action.value : '';
  return (
    <>
      <label htmlFor={id} className={fieldLabel}>
        {label}
      </label>
      <div className="flex gap-2">
        <input
          id={id}
          type="password"
          value={value}
          onChange={(event) => onChange({ kind: 'replace', value: event.target.value })}
          autoComplete="new-password"
          spellCheck={false}
          maxLength={512}
          required={mustReenter}
          aria-required={mustReenter || undefined}
          aria-invalid={missing || undefined}
          data-1p-ignore="true"
          data-lpignore="true"
          placeholder={
            saved.passwordSet ? t('adminSettings.email.connection.passwordNew') : t('adminSettings.email.connection.passwordNotSet')
          }
          aria-describedby={describedBy}
          className={`${inputClass} font-mono`}
        />
        {saved.passwordSet && !mustReenter ? (
          <button type="button" onClick={() => onChange({ kind: 'keep' })} className={`${secondaryButton} shrink-0`}>
            {t('adminSettings.email.connection.passwordKeep')}
          </button>
        ) : null}
      </div>
      {reenterLine}
      {hintLine}
    </>
  );
}

function TestOutcome({ result, detail }: { result: MailTestResult; detail: string | null }) {
  const t = useT();
  const detailKey = testDetailKey(detail);
  const ok = result === 'ok';
  return (
    <span className={`flex items-start gap-1.5 ${ok ? 'text-success' : 'text-danger'}`}>
      <span className="material-symbols-outlined text-lg" aria-hidden>
        {ok ? 'check_circle' : 'error'}
      </span>
      <span className="min-w-0">
        <span className="block">{t(TEST_RESULT_KEYS[result])}</span>
        {detailKey ? <span className="mt-0.5 block text-pretty text-xs text-text-secondary">{t(detailKey)}</span> : null}
      </span>
    </span>
  );
}
