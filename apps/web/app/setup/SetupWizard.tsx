'use client';

import { useMemo, useState, type FormEvent } from 'react';
import { I18nProvider, useT } from '@/lib/i18n/client';
import type { LocaleInfo, Messages } from '@/lib/i18n/core';
import { serializeLocaleCookie } from '@/lib/i18n/locale-cookie';
import { initialOf } from '@/lib/initial';
import { rich } from '@/lib/i18n/rich';

type Step = 'language' | 'name' | 'owner' | 'access' | 'seo' | 'review';

/** Labels are message keys, resolved with `t()` where they render. */
const STEPS: { id: Step; labelKey: string; descriptionKey: string }[] = [
  { id: 'language', labelKey: 'auth.setup.steps.language.label', descriptionKey: 'auth.setup.steps.language.description' },
  { id: 'name', labelKey: 'auth.setup.steps.name.label', descriptionKey: 'auth.setup.steps.name.description' },
  { id: 'owner', labelKey: 'auth.setup.steps.owner.label', descriptionKey: 'auth.setup.steps.owner.description' },
  { id: 'access', labelKey: 'auth.setup.steps.access.label', descriptionKey: 'auth.setup.steps.access.description' },
  { id: 'seo', labelKey: 'auth.setup.steps.seo.label', descriptionKey: 'auth.setup.steps.seo.description' },
  { id: 'review', labelKey: 'auth.setup.steps.review.label', descriptionKey: 'auth.setup.steps.review.description' },
];

type RegistrationMode = 'open' | 'invite_only' | 'closed';

interface FormState {
  setupToken: string;
  instanceName: string;
  /** Optional logo uploaded during setup (data URL). */
  instanceLogoDataUrl: string | null;
  ownerDisplayName: string;
  ownerEmail: string;
  ownerPassword: string;
  registrationMode: RegistrationMode;
  guestAccessEnabled: boolean;
  seoIndexingEnabled: boolean;
  seoTitle: string;
  seoDescription: string;
  /** Register this instance in the official discovery directory. */
  registerForDiscovery: boolean;
  /** Short description for the discovery listing. */
  discoveryDescription: string;
}

const ACCESS_OPTIONS: {
  value: RegistrationMode;
  labelKey: string;
  descriptionKey: string;
}[] = [
  {
    value: 'open',
    labelKey: 'auth.setup.access.open.label',
    descriptionKey: 'auth.setup.access.open.description',
  },
  {
    value: 'invite_only',
    labelKey: 'auth.setup.access.inviteOnly.label',
    descriptionKey: 'auth.setup.access.inviteOnly.description',
  },
  {
    value: 'closed',
    labelKey: 'auth.setup.access.closed.label',
    descriptionKey: 'auth.setup.access.closed.description',
  },
];

/**
 * One installed language as the wizard needs it: its metadata, and its
 * setup strings already merged over English (`setupLanguages` in
 * `./setup-languages.ts`). Every language on disk is passed, so one added
 * later shows up on the first step with no code change.
 */
export interface SetupLanguage {
  info: LocaleInfo;
  messages: Messages;
  englishPlurals: string[];
}

interface WizardProps {
  defaultInstanceName: string;
  defaultOwnerDisplayName: string;
  setupTokenRequired: boolean;
  instanceId: string;
  isOfficialHost: boolean;
}

/**
 * The first-run wizard. Its first step picks the language, and the wizard
 * switches to it at once — every step after renders in it — because each
 * language's setup strings are already on the page. The choice is also
 * written to the `lf_locale` cookie (a reload keeps it), and on completion
 * saved as the instance default and as the owner account's language.
 */
export default function SetupWizard({
  languages,
  initialLocale,
  ...props
}: WizardProps & { languages: SetupLanguage[]; initialLocale: string }) {
  const [locale, setLocale] = useState(
    () => languages.find((l) => l.info.code === initialLocale)?.info.code ?? languages[0]?.info.code ?? 'en'
  );
  const active = languages.find((l) => l.info.code === locale) ?? languages[0];

  function chooseLanguage(code: string) {
    if (!languages.some((l) => l.info.code === code)) return;
    setLocale(code);
    // The wizard is the whole page here (no global header on /setup), so
    // the document's language is the wizard's: casing and screen readers.
    document.documentElement.lang = code;
    document.documentElement.dir = languages.find((l) => l.info.code === code)?.info.dir ?? 'ltr';
    try {
      document.cookie = serializeLocaleCookie(code);
    } catch {
      // Cookies blocked: the choice still reaches the server with the form.
    }
  }

  return (
    <I18nProvider
      locale={active?.info.code ?? locale}
      dir={active?.info.dir ?? 'ltr'}
      messages={active?.messages ?? {}}
      englishPlurals={active?.englishPlurals ?? []}
      locales={languages.map((l) => l.info)}
      choice={locale}
    >
      <WizardBody {...props} languages={languages} locale={locale} onChooseLanguage={chooseLanguage} />
    </I18nProvider>
  );
}

function WizardBody({
  defaultInstanceName,
  defaultOwnerDisplayName,
  setupTokenRequired,
  instanceId,
  isOfficialHost,
  languages,
  locale,
  onChooseLanguage,
}: WizardProps & { languages: SetupLanguage[]; locale: string; onChooseLanguage: (code: string) => void }) {
  const t = useT();
  const dir = languages.find((l) => l.info.code === locale)?.info.dir ?? 'ltr';
  const [stepIndex, setStepIndex] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [form, setForm] = useState<FormState>({
    setupToken: '',
    instanceName: defaultInstanceName,
    instanceLogoDataUrl: null,
    ownerDisplayName: defaultOwnerDisplayName,
    ownerEmail: '',
    ownerPassword: '',
    registrationMode: 'invite_only',
    guestAccessEnabled: true,
    seoIndexingEnabled: false,
    seoTitle: '',
    seoDescription: '',
    registerForDiscovery: false,
    discoveryDescription: '',
  });

  const currentStep = STEPS[stepIndex]!;
  // The discovery sentence carries a link in the middle; split the whole
  // phrase around it so each language can place the link where it reads.

  const canAdvance = useMemo(() => {
    if (currentStep.id === 'name') {
      const trimmed = form.instanceName.trim();
      return trimmed.length >= 2 && trimmed.length <= 80 && (!setupTokenRequired || form.setupToken.length >= 16);
    }
    if (currentStep.id === 'owner') {
      const trimmed = form.ownerDisplayName.trim();
      return trimmed.length >= 2 && trimmed.length <= 64 && /\S+@\S+\.\S+/.test(form.ownerEmail) && form.ownerPassword.length >= 12;
    }
    return true;
  }, [currentStep.id, form.instanceName, form.ownerDisplayName, form.ownerEmail, form.ownerPassword, form.setupToken, setupTokenRequired]);

  function update<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  function next() {
    if (!canAdvance) return;
    setError(null);
    setStepIndex((i) => Math.min(STEPS.length - 1, i + 1));
  }

  function back() {
    setError(null);
    setStepIndex((i) => Math.max(0, i - 1));
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch('/api/setup/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          setupToken: form.setupToken || undefined,
          instanceName: form.instanceName.trim(),
          ownerDisplayName: form.ownerDisplayName.trim(),
          ownerEmail: form.ownerEmail.trim().toLowerCase(),
          ownerPassword: form.ownerPassword,
          registrationMode: form.registrationMode,
          guestAccessEnabled: form.guestAccessEnabled,
          seoIndexingEnabled: form.seoIndexingEnabled,
          seoTitle: form.seoTitle.trim() || null,
          seoDescription: form.seoDescription.trim() || null,
          locale,
        }),
      });
      if (!res.ok) {
        const detail = await res.json().catch(() => ({}));
        throw new Error(detail?.error ?? `HTTP ${res.status}`);
      }
      // Upload the optional logo AFTER bootstrap (the endpoint needs the
      // owner session the setup response just set). Failure is non-fatal —
      // the community works without a logo.
      if (form.instanceLogoDataUrl) {
        try {
          await fetch('/api/admin/instance-logo', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ dataUrl: form.instanceLogoDataUrl }),
          });
        } catch {
          // ignore — logo is cosmetic
        }
      }
      window.location.assign('/lobby');
    } catch (err) {
      setError((err as Error).message);
      setSubmitting(false);
    }
  }

  return (
    <section
      lang={locale}
      dir={dir}
      className="w-full max-w-2xl rounded-lg border border-border-subtle bg-surface-raised shadow-lg overflow-hidden"
    >
      <header className="px-6 py-5 border-b border-border-subtle flex flex-col gap-3">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            {form.instanceLogoDataUrl ? (
              // eslint-disable-next-line @next/next/no-img-element -- data URL preview
              <img
                src={form.instanceLogoDataUrl}
                alt=""
                className="size-11 rounded-lg object-cover"
              />
            ) : (
              <div className="size-11 rounded-lg bg-primary-container flex items-center justify-center font-bold text-on-primary-container">
                {initialOf(form.instanceName, { locale: t.locale, fallback: 'L' })}
              </div>
            )}
            <div className="min-w-0">
              <p className="truncate text-xs uppercase tracking-wider text-text-muted">
                {t('auth.setup.eyebrow')}
              </p>
              <h1 className="truncate text-balance text-lg font-semibold text-text-primary">
                {form.instanceName || t('auth.setup.welcome')}
              </h1>
            </div>
          </div>
          <p className="hidden sm:block text-xs text-text-muted font-label-xs">
            {t('auth.setup.instanceIdLabel')}&nbsp;<span className="font-mono text-text-secondary">{instanceId}</span>
          </p>
        </div>
        <ProgressBar stepIndex={stepIndex} />
      </header>

      <form onSubmit={submit} className="px-6 py-6 flex flex-col gap-5">
        <header className="flex flex-col gap-1">
          <h2 className="text-base font-semibold text-text-primary">
            {t('auth.setup.stepHeading', {
              current: stepIndex + 1,
              total: STEPS.length,
              label: t(currentStep.labelKey),
            })}
          </h2>
          <p className="text-sm text-text-secondary">{t(currentStep.descriptionKey)}</p>
        </header>

        {currentStep.id === 'language' && (
          <LanguageStep languages={languages} locale={locale} onChoose={onChooseLanguage} />
        )}

        {currentStep.id === 'name' && (
          <div className="grid gap-4">
          <Field label={t('auth.setup.instanceName.label')} hint={t('auth.setup.instanceName.hint')}>
            <input
              type="text"
              required
              minLength={2}
              maxLength={80}
              autoFocus
              value={form.instanceName}
              onChange={(e) => update('instanceName', e.target.value)}
              className="w-full rounded-md border border-border-subtle bg-background px-3 py-2 text-sm text-text-primary focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/30"
              placeholder={t('auth.setup.instanceName.placeholder')}
            />
          </Field>
          <Field
            label={t('auth.setup.logo.label')}
            hint={t('auth.setup.logo.hint')}
          >
            <div className="flex items-center gap-3">
              <input
                type="file"
                accept="image/png,image/jpeg,image/gif,image/webp"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  if (file.size > 2 * 1024 * 1024) {
                    setError(t('auth.setup.logo.tooLarge'));
                    return;
                  }
                  const reader = new FileReader();
                  reader.onload = () => update('instanceLogoDataUrl', String(reader.result));
                  reader.onerror = () => setError(t('auth.setup.logo.readFailed'));
                  reader.readAsDataURL(file);
                }}
                className="text-sm text-text-secondary file:mr-3 file:rounded-md file:border-0 file:bg-surface-container file:px-3 file:py-1.5 file:text-xs file:text-text-primary"
              />
              {form.instanceLogoDataUrl ? (
                <button
                  type="button"
                  onClick={() => update('instanceLogoDataUrl', null)}
                  className="text-xs text-text-muted underline"
                >
                  {t('auth.setup.logo.remove')}
                </button>
              ) : null}
            </div>
          </Field>
          {setupTokenRequired ? (
            <Field label={t('auth.setup.token.label')} hint={t('auth.setup.token.hint')}>
              <input
                type="password"
                required
                minLength={16}
                maxLength={256}
                autoComplete="one-time-code"
                value={form.setupToken}
                onChange={(e) => update('setupToken', e.target.value)}
                className="w-full rounded-md border border-border-subtle bg-background px-3 py-2 font-mono text-sm text-text-primary focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/30"
                placeholder={t('auth.setup.token.placeholder')}
              />
            </Field>
          ) : null}
          </div>
        )}

        {currentStep.id === 'owner' && (
          <div className="grid gap-4">
          <Field label={t('auth.setup.ownerName.label')} hint={t('auth.setup.ownerName.hint')}>
            <input
              type="text"
              required
              minLength={2}
              maxLength={64}
              autoFocus
              value={form.ownerDisplayName}
              onChange={(e) => update('ownerDisplayName', e.target.value)}
              className="w-full rounded-md border border-border-subtle bg-background px-3 py-2 text-sm text-text-primary focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/30"
              placeholder="juanka"
            />
          </Field>
          <Field label={t('auth.setup.ownerEmail.label')} hint={t('auth.setup.ownerEmail.hint')}>
            <input
              type="email"
              required
              maxLength={254}
              autoComplete="email"
              value={form.ownerEmail}
              onChange={(e) => update('ownerEmail', e.target.value)}
              className="w-full rounded-md border border-border-subtle bg-background px-3 py-2 text-sm text-text-primary focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/30"
              placeholder="owner@example.com"
            />
          </Field>
          <Field label={t('auth.setup.ownerPassword.label')} hint={t('auth.setup.ownerPassword.hint')}>
            <input
              type="password"
              required
              minLength={12}
              maxLength={128}
              autoComplete="new-password"
              value={form.ownerPassword}
              onChange={(e) => update('ownerPassword', e.target.value)}
              className="w-full rounded-md border border-border-subtle bg-background px-3 py-2 text-sm text-text-primary focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/30"
              placeholder={t('auth.setup.ownerPassword.placeholder')}
            />
          </Field>
          </div>
        )}

        {currentStep.id === 'access' && (
          <fieldset className="flex flex-col gap-3">
            <legend className="text-sm font-medium text-text-primary">{t('auth.setup.access.legend')}</legend>
            <div className="grid gap-2">
              {ACCESS_OPTIONS.map((option) => {
                const active = form.registrationMode === option.value;
                return (
                  <label
                    key={option.value}
                    className={`flex cursor-pointer flex-col gap-1 rounded-md border px-3 py-3 transition ${
                      active
                        ? 'border-primary bg-primary/10'
                        : 'border-border-subtle bg-background hover:border-border-strong'
                    }`}
                  >
                    <span className="flex items-center gap-2 text-sm font-medium text-text-primary">
                      <input
                        type="radio"
                        name="registrationMode"
                        value={option.value}
                        checked={active}
                        onChange={() => update('registrationMode', option.value)}
                        className="accent-primary"
                      />
                      {t(option.labelKey)}
                    </span>
                    <span className="pl-6 text-xs text-text-secondary">{t(option.descriptionKey)}</span>
                  </label>
                );
              })}
            </div>
            <label className="mt-1 inline-flex items-center gap-2 text-sm text-text-secondary">
              <input
                type="checkbox"
                checked={form.guestAccessEnabled}
                disabled={form.registrationMode === 'closed'}
                onChange={(e) => update('guestAccessEnabled', e.target.checked)}
                className="accent-primary"
              />
              {t('auth.setup.access.allowGuests')}
            </label>
          </fieldset>
        )}

        {currentStep.id === 'seo' && (
          <div className="flex flex-col gap-4">
            {/* Privacy warning — prominently shown before the SEO toggle. */}
            {!form.seoIndexingEnabled ? (
              <div className="rounded-lg border border-success/30 bg-success/5 p-3 flex items-start gap-2">
                <span className="material-symbols-outlined text-success text-[18px] mt-0.5">lock</span>
                <div>
                  <p className="text-sm font-medium text-success">{t('auth.setup.seo.blockedTitle')}</p>
                  <p className="text-xs text-text-secondary mt-0.5">
                    {t('auth.setup.seo.blockedBody')}
                  </p>
                </div>
              </div>
            ) : (
              <div className="rounded-lg border border-tertiary/40 bg-tertiary/5 p-3 flex items-start gap-2">
                <span className="material-symbols-outlined text-tertiary text-[18px] mt-0.5">warning</span>
                <div>
                  <p className="text-sm font-medium text-tertiary">{t('auth.setup.seo.onTitle')}</p>
                  <p className="text-xs text-text-secondary mt-0.5">
                    {t('auth.setup.seo.onBody')} <strong>{t('auth.setup.seo.onCacheWarning')}</strong>{' '}
                    {t('auth.setup.seo.onScrapers')}
                  </p>
                </div>
              </div>
            )}
            <label className="inline-flex items-center gap-2 text-sm text-text-primary">
              <input
                type="checkbox"
                checked={form.seoIndexingEnabled}
                onChange={(e) => update('seoIndexingEnabled', e.target.checked)}
                className="accent-primary"
              />
              {t('auth.setup.seo.allowIndexing')}
            </label>
            <Field label={t('auth.setup.seo.titleLabel')} hint={t('auth.setup.seo.titleHint')}>
              <input
                type="text"
                maxLength={70}
                disabled={!form.seoIndexingEnabled}
                value={form.seoTitle}
                onChange={(e) => update('seoTitle', e.target.value)}
                className="w-full rounded-md border border-border-subtle bg-background px-3 py-2 text-sm text-text-primary focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/30 disabled:opacity-50"
                placeholder={form.instanceName}
              />
            </Field>
            <Field
              label={t('auth.setup.seo.descriptionLabel')}
              hint={t('auth.setup.seo.descriptionHint')}
            >
              <textarea
                maxLength={160}
                rows={3}
                disabled={!form.seoIndexingEnabled}
                value={form.seoDescription}
                onChange={(e) => update('seoDescription', e.target.value)}
                className="w-full rounded-md border border-border-subtle bg-background px-3 py-2 text-sm text-text-primary focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/30 disabled:opacity-50"
                placeholder={t('auth.setup.seo.descriptionPlaceholder')}
              />
            </Field>

            {/* Discovery registration (official instance only) */}
            {isOfficialHost ? (
              <div className="mt-4 rounded-lg border border-border-subtle p-4 space-y-3">
                <label className="flex items-start gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={form.registerForDiscovery}
                    onChange={(e) => update('registerForDiscovery', e.target.checked)}
                    className="accent-primary mt-0.5"
                  />
                  <div>
                    <span className="text-sm font-medium text-text-primary">{t('auth.setup.discovery.optIn')}</span>
                    <p className="text-xs text-text-secondary mt-0.5">
                      {rich(t('auth.setup.discovery.body'), { link: <a href="/discover" className="text-primary hover:underline">{t('auth.setup.discovery.link')}</a> })}
                    </p>
                  </div>
                </label>
                {form.registerForDiscovery ? (
                  <Field label={t('auth.setup.discovery.descriptionLabel')} hint={t('auth.setup.discovery.descriptionHint')}>
                    <textarea
                      maxLength={200}
                      rows={2}
                      value={form.discoveryDescription}
                      onChange={(e) => update('discoveryDescription', e.target.value)}
                      className="w-full rounded-md border border-border-subtle bg-background px-3 py-2 text-sm text-text-primary focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/30"
                      placeholder={t('auth.setup.discovery.descriptionPlaceholder')}
                    />
                  </Field>
                ) : null}
              </div>
            ) : null}
          </div>
        )}

        {currentStep.id === 'review' && (
          <ReviewPanel form={form} languageName={languages.find((l) => l.info.code === locale)?.info.name ?? locale} />
        )}

        {error && (
          <p
            role="alert"
            className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger"
          >
            {error}
          </p>
        )}

        <footer className="flex items-center justify-between gap-3 pt-2">
          <button
            type="button"
            onClick={back}
            disabled={stepIndex === 0 || submitting}
            className="rounded-md px-3 py-2 text-sm text-text-secondary hover:bg-surface-variant/40 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {t('auth.setup.back')}
          </button>
          {/* Distinct keys: without them React reuses the Continue button as
              the submit button, and in a real browser the click that opens
              the review step turns into a submit before the review shows. */}
          {stepIndex < STEPS.length - 1 ? (
            <button
              key="continue"
              type="button"
              onClick={next}
              disabled={!canAdvance}
              className="rounded-md bg-primary-container px-4 py-2 text-sm font-semibold text-on-primary-container hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {t('auth.setup.continue')}
            </button>
          ) : (
            <button
              key="finish"
              type="submit"
              disabled={submitting}
              className="rounded-md bg-primary-container px-4 py-2 text-sm font-semibold text-on-primary-container hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {submitting ? t('auth.setup.finishing') : t('auth.setup.finish')}
            </button>
          )}
        </footer>
      </form>
    </section>
  );
}

/**
 * Step 1: every installed language, each in its own name (with its English
 * name beside it), so whoever runs setup finds theirs whatever language
 * the page opened in. Picking one switches the wizard at once.
 */
function LanguageStep({
  languages,
  locale,
  onChoose,
}: {
  languages: SetupLanguage[];
  locale: string;
  onChoose: (code: string) => void;
}) {
  const t = useT();
  return (
    <div className="flex flex-col gap-2">
      <div
        role="radiogroup"
        aria-label={t('auth.setup.language.legend')}
        className="overflow-hidden rounded-md border border-border-subtle bg-background"
      >
        {languages.map(({ info }) => {
          const selected = info.code === locale;
          return (
            <button
              key={info.code}
              type="button"
              role="radio"
              aria-checked={selected}
              lang={info.code}
              dir={info.dir}
              onClick={() => onChoose(info.code)}
              className={`flex w-full items-center gap-3 border-b border-border-subtle px-4 py-2.5 text-left last:border-b-0 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary ${
                selected ? 'bg-primary/10 text-text-primary' : 'text-text-secondary hover:bg-surface-container hover:text-text-primary'
              }`}
            >
              <span
                aria-hidden
                className={`grid size-4 flex-shrink-0 place-items-center rounded-full border ${
                  selected ? 'border-primary' : 'border-border-subtle'
                }`}
              >
                {selected ? <span className="size-2 rounded-full bg-primary" /> : null}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{info.name}</span>
                {info.englishName && info.englishName !== info.name ? (
                  <span className="block truncate text-xs text-text-muted" lang="en" dir="ltr">
                    {info.englishName}
                  </span>
                ) : null}
              </span>
              {info.status === 'partial' ? (
                <span
                  className="flex-shrink-0 rounded border border-border-subtle px-1.5 py-0.5 text-[11px] text-text-muted"
                  lang={locale}
                >
                  {t('auth.setup.language.partial')}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
      <p className="text-xs text-text-muted">{t('auth.setup.language.hint')}</p>
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-sm font-medium text-text-primary">{label}</span>
      {children}
      {hint && <span className="text-xs text-text-muted">{hint}</span>}
    </label>
  );
}

function ProgressBar({ stepIndex }: { stepIndex: number }) {
  const t = useT();
  return (
    <ol className="flex items-center gap-2" aria-label={t('auth.setup.progressLabel')}>
      {STEPS.map((step, index) => {
        const state =
          index < stepIndex ? 'done' : index === stepIndex ? 'current' : 'pending';
        return (
          <li key={step.id} className="flex flex-1 items-center gap-2 min-w-0">
            <span
              aria-hidden
              className={`flex size-6 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold ${
                state === 'done'
                  ? 'bg-success text-on-primary-container'
                  : state === 'current'
                    ? 'bg-primary-container text-on-primary-container'
                    : 'border border-border-subtle bg-background text-text-muted'
              }`}
            >
              {index + 1}
            </span>
            <span
              className={`truncate text-xs ${
                state === 'pending' ? 'text-text-muted' : 'text-text-secondary'
              }`}
            >
              {t(step.labelKey)}
            </span>
            {index < STEPS.length - 1 && (
              <span
                aria-hidden
                className={`mx-1 h-px flex-1 ${
                  state === 'done' ? 'bg-success/60' : 'bg-border-subtle'
                }`}
              />
            )}
          </li>
        );
      })}
    </ol>
  );
}

function ReviewPanel({ form, languageName }: { form: FormState; languageName: string }) {
  const t = useT();
  const onOff = (on: boolean) => (on ? t('auth.setup.review.enabled') : t('auth.setup.review.disabled'));
  const accessKey = ACCESS_OPTIONS.find((o) => o.value === form.registrationMode)?.labelKey;
  const rows: { label: string; value: string }[] = [
    { label: t('auth.setup.review.language'), value: languageName },
    { label: t('auth.setup.instanceName.label'), value: form.instanceName.trim() || '—' },
    { label: t('auth.setup.review.owner'), value: form.ownerDisplayName.trim() || '—' },
    { label: t('auth.setup.ownerEmail.label'), value: form.ownerEmail.trim() || '—' },
    {
      label: t('auth.setup.review.registration'),
      value: accessKey ? t(accessKey) : '—',
    },
    {
      label: t('auth.setup.review.guestAccounts'),
      value: onOff(form.guestAccessEnabled && form.registrationMode !== 'closed'),
    },
    {
      label: t('auth.setup.review.searchIndexing'),
      value: onOff(form.seoIndexingEnabled),
    },
    { label: t('auth.setup.review.seoTitle'), value: form.seoTitle.trim() || '—' },
    { label: t('auth.setup.review.seoDescription'), value: form.seoDescription.trim() || '—' },
  ];

  return (
    <dl className="grid gap-2 rounded-md border border-border-subtle bg-background px-4 py-3">
      {rows.map((row) => (
        <div key={row.label} className="flex items-baseline justify-between gap-3">
          <dt className="text-xs uppercase tracking-wider text-text-muted">{row.label}</dt>
          <dd className="truncate text-sm text-text-primary">{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}
