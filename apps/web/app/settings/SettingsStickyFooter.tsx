'use client';

import { useT } from '@/lib/i18n/client';
import type { Params } from '@/lib/i18n/core';

/**
 * What the footer says. Pages keep a message KEY here rather than
 * translated text, so a status set inside an async handler needs no
 * translator and is resolved at render. `text` is for messages that
 * arrive already written — a server or browser error — shown as-is.
 */
export type SettingsStatus = { key: string; params?: Params } | { text: string };

type SettingsStickyFooterProps = {
  status: SettingsStatus;
  updatedAt?: string | null;
  dirty: boolean;
  busy?: boolean;
  saveLabel?: string;
  savedLabel?: string;
  savingLabel?: string;
  resetLabel?: string;
  onSave: () => void;
  onReset?: () => void;
  saveDisabled?: boolean;
};

export default function SettingsStickyFooter({
  status,
  updatedAt,
  dirty,
  busy = false,
  saveLabel,
  savedLabel,
  savingLabel,
  resetLabel,
  onSave,
  onReset,
  saveDisabled,
}: SettingsStickyFooterProps) {
  const t = useT();
  const disabled = saveDisabled ?? (busy || !dirty);
  const message = 'key' in status ? t(status.key, status.params) : status.text;
  return (
    <footer className="sticky bottom-4 z-20 flex flex-col gap-3 rounded-xl border border-border-subtle bg-surface/95 p-3 shadow-xl shadow-black/30 backdrop-blur-md sm:flex-row sm:items-center sm:justify-between">
      <span className="min-w-0 text-xs text-text-muted">
        {message}
        {updatedAt
          ? ` - ${t('settings.footer.updated', { date: new Date(updatedAt).toLocaleString(t.locale) })}`
          : ''}
      </span>
      <div className="flex shrink-0 justify-end gap-2">
        {onReset ? (
          <button
            type="button"
            onClick={onReset}
            disabled={busy || !dirty}
            className="btn-secondary-sm disabled:cursor-not-allowed disabled:opacity-40"
          >
            {resetLabel ?? t('settings.footer.reset')}
          </button>
        ) : null}
        <button
          type="button"
          onClick={onSave}
          disabled={disabled}
          className="btn-primary-sm disabled:cursor-not-allowed disabled:opacity-40"
        >
          {busy
            ? (savingLabel ?? t('settings.footer.saving'))
            : dirty
              ? (saveLabel ?? t('settings.footer.save'))
              : (savedLabel ?? t('settings.footer.saved'))}
        </button>
      </div>
    </footer>
  );
}
