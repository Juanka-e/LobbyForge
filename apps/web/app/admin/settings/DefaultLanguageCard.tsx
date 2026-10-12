'use client';

import { useId, useState } from 'react';
import { useT } from '@/lib/i18n/client';
import type { DefaultLocaleAdminView } from '@/lib/i18n/instance-default';

/** The select's value for "nothing saved here". Not a locale code (codes never contain a colon). */
const NOT_SET = ':none';

/**
 * Admin → Overview → Default language (docs/TRANSLATING.md). Lists every
 * language installed on disk — a language added later appears here with
 * no code change — and says which step decides the default today: the
 * value saved here, LOBBYFORGE_DEFAULT_LOCALE, or English.
 * PUT /api/admin/default-locale saves it (instance owner only).
 */
export default function DefaultLanguageCard({ initial }: { initial: DefaultLocaleAdminView }) {
  const t = useT();
  const selectId = useId();
  const [view, setView] = useState(initial);
  const [draft, setDraft] = useState(initial.savedInstalled && initial.saved ? initial.saved : NOT_SET);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);

  const savedValue = view.savedInstalled && view.saved ? view.saved : NOT_SET;
  const nameOf = (code: string | null) => view.locales.find((l) => l.code === code)?.name ?? code ?? '';

  async function save() {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch('/api/admin/default-locale', {
        method: 'PUT',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ locale: draft === NOT_SET ? null : draft }),
      });
      if (!res.ok) throw new Error(String(res.status));
      const next = (await res.json()) as DefaultLocaleAdminView;
      setView(next);
      setDraft(next.savedInstalled && next.saved ? next.saved : NOT_SET);
      setMessage({ tone: 'ok', text: t('adminSettings.overview.language.saved') });
    } catch {
      setMessage({ tone: 'error', text: t('adminSettings.overview.language.saveFailed') });
    } finally {
      setBusy(false);
    }
  }

  const effective = nameOf(view.code);
  const sourceText =
    view.source === 'saved'
      ? t('adminSettings.overview.language.sourceSaved', { language: effective })
      : view.source === 'env'
        ? t('adminSettings.overview.language.sourceEnv', { language: effective, env: 'LOBBYFORGE_DEFAULT_LOCALE' })
        : t('adminSettings.overview.language.sourceFallback', { language: effective });

  return (
    <section className="rounded-xl border border-border-subtle bg-surface/80 backdrop-blur-sm p-6">
      <h2 className="text-base font-semibold text-text-primary">{t('adminSettings.overview.language.title')}</h2>
      <p className="mt-1 text-sm text-text-secondary">{t('adminSettings.overview.language.description')}</p>

      <div className="mt-4 flex flex-wrap items-end gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <label htmlFor={selectId} className="text-sm font-medium text-text-primary">
            {t('adminSettings.overview.language.label')}
          </label>
          <select
            id={selectId}
            value={draft}
            disabled={busy}
            onChange={(event) => setDraft(event.target.value)}
            className="w-full max-w-md rounded-md border border-border-subtle bg-background px-3 py-2 text-sm text-text-primary focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/30"
          >
            <option value={NOT_SET}>{t('adminSettings.overview.language.notSet')}</option>
            {view.locales.map((locale) => (
              <option key={locale.code} value={locale.code} lang={locale.code}>
                {t('adminSettings.overview.language.option', {
                  name: locale.englishName && locale.englishName !== locale.name ? `${locale.name} (${locale.englishName})` : locale.name,
                  status: locale.status,
                })}
              </option>
            ))}
          </select>
        </div>
        <button
          type="button"
          disabled={busy || draft === savedValue}
          onClick={() => void save()}
          className="rounded-lg bg-primary-container px-4 py-2 font-label-sm text-on-primary-container hover:brightness-110 transition-all disabled:opacity-40"
        >
          {busy ? t('adminSettings.overview.language.saving') : t('adminSettings.overview.language.save')}
        </button>
      </div>

      <p className="mt-3 text-sm text-text-secondary" data-testid="default-language-source">
        {sourceText}
      </p>
      {view.source === 'saved' && view.env && view.envInstalled && view.env !== view.code ? (
        <p className="mt-1 text-xs text-text-muted">
          {t('adminSettings.overview.language.envOverridden', { env: 'LOBBYFORGE_DEFAULT_LOCALE', language: nameOf(view.env) })}
        </p>
      ) : null}
      {view.env && !view.envInstalled ? (
        <p className="mt-1 text-xs text-danger">
          {t('adminSettings.overview.language.envUnknown', { env: 'LOBBYFORGE_DEFAULT_LOCALE', value: view.env })}
        </p>
      ) : null}
      {view.saved && !view.savedInstalled ? (
        <p className="mt-1 text-xs text-danger">
          {t('adminSettings.overview.language.savedUnknown', { value: view.saved })}
        </p>
      ) : null}
      <p className="mt-3 text-xs text-text-muted">{t('adminSettings.overview.language.addHint')}</p>
      {message ? (
        <p role={message.tone === 'error' ? 'alert' : 'status'} className={`mt-3 text-xs ${message.tone === 'error' ? 'text-danger' : 'text-text-secondary'}`}>
          {message.text}
        </p>
      ) : null}
    </section>
  );
}
