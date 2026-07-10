'use client';

import { useMemo, useState, type FormEvent } from 'react';

type Step = 'name' | 'owner' | 'access' | 'seo' | 'review';

const STEPS: { id: Step; label: string; description: string }[] = [
  { id: 'name', label: 'Instance', description: 'Name your community.' },
  { id: 'owner', label: 'Owner', description: 'Create the first admin account.' },
  { id: 'access', label: 'Access', description: 'Choose who can join.' },
  { id: 'seo', label: 'Discovery', description: 'Search engine visibility.' },
  { id: 'review', label: 'Review', description: 'Confirm and finish.' },
];

type RegistrationMode = 'open' | 'invite_only' | 'closed';

interface FormState {
  setupToken: string;
  instanceName: string;
  ownerDisplayName: string;
  ownerEmail: string;
  ownerPassword: string;
  registrationMode: RegistrationMode;
  guestAccessEnabled: boolean;
  seoIndexingEnabled: boolean;
  seoTitle: string;
  seoDescription: string;
}

const ACCESS_OPTIONS: {
  value: RegistrationMode;
  label: string;
  description: string;
}[] = [
  {
    value: 'open',
    label: 'Open',
    description: 'Anyone can create an account. Recommended for public communities.',
  },
  {
    value: 'invite_only',
    label: 'Invite only',
    description: 'New accounts need a working invite code from an existing member.',
  },
  {
    value: 'closed',
    label: 'Closed',
    description: 'No new accounts. Useful for private groups and migration windows.',
  },
];

export default function SetupWizard({
  defaultInstanceName,
  defaultOwnerDisplayName,
  setupTokenRequired,
  instanceId,
}: {
  defaultInstanceName: string;
  defaultOwnerDisplayName: string;
  setupTokenRequired: boolean;
  instanceId: string;
}) {
  const [stepIndex, setStepIndex] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [form, setForm] = useState<FormState>({
    setupToken: '',
    instanceName: defaultInstanceName,
    ownerDisplayName: defaultOwnerDisplayName,
    ownerEmail: '',
    ownerPassword: '',
    registrationMode: 'invite_only',
    guestAccessEnabled: true,
    seoIndexingEnabled: false,
    seoTitle: '',
    seoDescription: '',
  });

  const currentStep = STEPS[stepIndex]!;

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
        }),
      });
      if (!res.ok) {
        const detail = await res.json().catch(() => ({}));
        throw new Error(detail?.error ?? `HTTP ${res.status}`);
      }
      window.location.assign('/lobby');
    } catch (err) {
      setError((err as Error).message);
      setSubmitting(false);
    }
  }

  return (
    <section className="w-full max-w-2xl rounded-lg border border-border-subtle bg-surface-raised shadow-lg overflow-hidden">
      <header className="px-6 py-5 border-b border-border-subtle flex flex-col gap-3">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <div className="size-11 rounded-lg bg-primary-container flex items-center justify-center font-bold text-[#07101e]">
              {form.instanceName.charAt(0).toUpperCase() || 'L'}
            </div>
            <div className="min-w-0">
              <p className="truncate text-xs uppercase tracking-wider text-text-muted">
                First-run setup
              </p>
              <h1 className="truncate text-balance text-lg font-semibold text-text-primary">
                {form.instanceName || 'Welcome to LobbyForge'}
              </h1>
            </div>
          </div>
          <p className="hidden sm:block text-xs text-text-muted font-label-xs">
            Instance&nbsp;<span className="font-mono text-text-secondary">{instanceId}</span>
          </p>
        </div>
        <ProgressBar stepIndex={stepIndex} />
      </header>

      <form onSubmit={submit} className="px-6 py-6 flex flex-col gap-5">
        <header className="flex flex-col gap-1">
          <h2 className="text-base font-semibold text-text-primary">
            Step {stepIndex + 1} of {STEPS.length} · {currentStep.label}
          </h2>
          <p className="text-sm text-text-secondary">{currentStep.description}</p>
        </header>

        {currentStep.id === 'name' && (
          <div className="grid gap-4">
          <Field label="Instance name" hint="Shown to members and in the page title.">
            <input
              type="text"
              required
              minLength={2}
              maxLength={80}
              autoFocus
              value={form.instanceName}
              onChange={(e) => update('instanceName', e.target.value)}
              className="w-full rounded-md border border-border-subtle bg-background px-3 py-2 text-sm text-text-primary focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/30"
              placeholder="Ankara Gaming Voice"
            />
          </Field>
          {setupTokenRequired ? (
            <Field label="Setup token" hint="Generated by the installer. It is never stored in the database.">
              <input
                type="password"
                required
                minLength={16}
                maxLength={256}
                autoComplete="one-time-code"
                value={form.setupToken}
                onChange={(e) => update('setupToken', e.target.value)}
                className="w-full rounded-md border border-border-subtle bg-background px-3 py-2 font-mono text-sm text-text-primary focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/30"
                placeholder="Paste installer setup token"
              />
            </Field>
          ) : null}
          </div>
        )}

        {currentStep.id === 'owner' && (
          <div className="grid gap-4">
          <Field label="Owner display name" hint="Shown to members across this community.">
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
          <Field label="Owner email" hint="Used to sign in to this self-hosted instance.">
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
          <Field label="Owner password" hint="At least 12 characters. Stored as a salted Scrypt hash.">
            <input
              type="password"
              required
              minLength={12}
              maxLength={128}
              autoComplete="new-password"
              value={form.ownerPassword}
              onChange={(e) => update('ownerPassword', e.target.value)}
              className="w-full rounded-md border border-border-subtle bg-background px-3 py-2 text-sm text-text-primary focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/30"
              placeholder="Create a secure password"
            />
          </Field>
          </div>
        )}

        {currentStep.id === 'access' && (
          <fieldset className="flex flex-col gap-3">
            <legend className="text-sm font-medium text-text-primary">Registration mode</legend>
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
                      {option.label}
                    </span>
                    <span className="pl-6 text-xs text-text-secondary">{option.description}</span>
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
              Allow guest accounts (display name only, no password)
            </label>
          </fieldset>
        )}

        {currentStep.id === 'seo' && (
          <div className="flex flex-col gap-4">
            <label className="inline-flex items-center gap-2 text-sm text-text-primary">
              <input
                type="checkbox"
                checked={form.seoIndexingEnabled}
                onChange={(e) => update('seoIndexingEnabled', e.target.checked)}
                className="accent-primary"
              />
              Allow search engines to index this instance
            </label>
            <Field label="SEO title (optional)" hint="Shown in browser tabs and search results. Max 70 chars.">
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
              label="SEO description (optional)"
              hint="Shown under the title in search results. Max 160 chars."
            >
              <textarea
                maxLength={160}
                rows={3}
                disabled={!form.seoIndexingEnabled}
                value={form.seoDescription}
                onChange={(e) => update('seoDescription', e.target.value)}
                className="w-full rounded-md border border-border-subtle bg-background px-3 py-2 text-sm text-text-primary focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/30 disabled:opacity-50"
                placeholder="A self-hosted voice community for gamers and friends."
              />
            </Field>
          </div>
        )}

        {currentStep.id === 'review' && <ReviewPanel form={form} />}

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
            Back
          </button>
          {stepIndex < STEPS.length - 1 ? (
            <button
              type="button"
              onClick={next}
              disabled={!canAdvance}
              className="rounded-md bg-primary-container px-4 py-2 text-sm font-semibold text-[#07101e] hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Continue
            </button>
          ) : (
            <button
              type="submit"
              disabled={submitting}
              className="rounded-md bg-primary-container px-4 py-2 text-sm font-semibold text-[#07101e] hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {submitting ? 'Finishing…' : 'Complete setup'}
            </button>
          )}
        </footer>
      </form>
    </section>
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
  return (
    <ol className="flex items-center gap-2" aria-label="Setup progress">
      {STEPS.map((step, index) => {
        const state =
          index < stepIndex ? 'done' : index === stepIndex ? 'current' : 'pending';
        return (
          <li key={step.id} className="flex flex-1 items-center gap-2 min-w-0">
            <span
              aria-hidden
              className={`flex size-6 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold ${
                state === 'done'
                  ? 'bg-success text-[#07101e]'
                  : state === 'current'
                    ? 'bg-primary-container text-[#07101e]'
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
              {step.label}
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

function ReviewPanel({ form }: { form: FormState }) {
  const rows: { label: string; value: string }[] = [
    { label: 'Instance name', value: form.instanceName.trim() || '—' },
    { label: 'Owner', value: form.ownerDisplayName.trim() || '—' },
    { label: 'Owner email', value: form.ownerEmail.trim() || '—' },
    {
      label: 'Registration',
      value: ACCESS_OPTIONS.find((o) => o.value === form.registrationMode)?.label ?? '—',
    },
    {
      label: 'Guest accounts',
      value: form.guestAccessEnabled && form.registrationMode !== 'closed' ? 'Enabled' : 'Disabled',
    },
    {
      label: 'Search indexing',
      value: form.seoIndexingEnabled ? 'Enabled' : 'Disabled',
    },
    { label: 'SEO title', value: form.seoTitle.trim() || '—' },
    { label: 'SEO description', value: form.seoDescription.trim() || '—' },
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
