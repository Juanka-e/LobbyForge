'use client';

import { useId, useRef, useState } from 'react';
import { Modal } from '@/components/Modal';
import { useT } from '@/lib/i18n/client';
import type { ExternalProvider } from './bot-protection-model';

/** The privacy-notice paragraphs in one language, from that language's catalogue. */
export interface PrivacyNoticeSet {
  code: string;
  /** The language's own name ("English", "Türkçe"). */
  name: string;
  altcha: string;
  turnstile: string;
  recaptcha: string;
}

const COMPANY: Record<ExternalProvider, string> = { turnstile: 'Cloudflare', recaptcha: 'Google' };
const PRODUCT: Record<ExternalProvider, string> = { turnstile: 'Cloudflare Turnstile', recaptcha: 'Google reCAPTCHA' };

/**
 * Picking an external provider moves visitor data to a third party; this
 * says so before the choice sticks, and hands the admin a ready paragraph
 * for their privacy notice in every language the instance ships complete
 * (a community's visitors may read another language than its admin).
 */
export function PrivacyNoticeDialog({
  provider,
  notices,
  onConfirm,
  onCancel,
}: {
  provider: ExternalProvider;
  notices: PrivacyNoticeSet[];
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const t = useT();
  const baseId = useId();
  const initial = Math.max(0, notices.findIndex((notice) => notice.code === t.locale));
  const [active, setActive] = useState(initial);
  const [copied, setCopied] = useState<string | null>(null);
  const [copyFailed, setCopyFailed] = useState<string | null>(null);
  const areas = useRef(new Map<string, HTMLTextAreaElement>());
  const notice = notices[active] ?? notices[0];

  async function copy(id: string, text: string) {
    setCopied(null);
    setCopyFailed(null);
    try {
      await navigator.clipboard.writeText(text);
      setCopied(id);
    } catch {
      // No clipboard permission: select it so Ctrl+C / long-press works.
      const area = areas.current.get(id);
      area?.focus();
      area?.select();
      setCopyFailed(id);
    }
  }

  // A render helper, not a component: the textarea must keep its node (and selection) across renders.
  function copyBlock(id: string, label: string, text: string, rows: number) {
    const fieldId = `${baseId}-${id}`;
    return (
      <div key={fieldId} className="grid gap-2">
        <div className="flex items-center justify-between gap-3">
          <label htmlFor={fieldId} className="text-sm font-medium text-text-primary">
            {label}
          </label>
          <button
            type="button"
            onClick={() => void copy(id, text)}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-border-strong px-3 py-1.5 text-sm font-medium text-text-primary hover:bg-surface-container focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
          >
            <span className="material-symbols-outlined text-base" aria-hidden>
              {copied === id ? 'check' : 'content_copy'}
            </span>
            {copied === id ? t('adminSettings.botProtection.privacy.copied') : t('adminSettings.botProtection.privacy.copy')}
          </button>
        </div>
        <textarea
          id={fieldId}
          ref={(node) => {
            if (node) areas.current.set(id, node);
            else areas.current.delete(id);
          }}
          readOnly
          rows={rows}
          value={text}
          lang={notice?.code}
          className="w-full resize-y rounded-lg border border-border-subtle bg-surface px-3 py-2 text-sm leading-relaxed text-text-primary outline-none focus:border-primary"
        />
        <p className="min-h-5 text-xs" aria-live="polite">
          {copyFailed === id ? <span className="text-text-secondary">{t('adminSettings.botProtection.privacy.copyFailed')}</span> : null}
        </p>
      </div>
    );
  }

  return (
    <Modal
      open
      onClose={onCancel}
      size="xl"
      disableBackdropClose
      title={t('adminSettings.botProtection.privacy.title', { provider: PRODUCT[provider] })}
      footer={
        <>
          <button
            type="button"
            onClick={onCancel}
            className="rounded-lg border border-border-strong px-4 py-2 text-sm font-medium text-text-secondary hover:bg-surface-container hover:text-text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
          >
            {t('adminSettings.botProtection.privacy.cancel')}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="rounded-lg bg-primary-container px-4 py-2 text-sm font-semibold text-on-primary-container hover:brightness-110 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
          >
            {t('adminSettings.botProtection.privacy.confirm', { provider: PRODUCT[provider] })}
          </button>
        </>
      }
    >
      <div className="grid gap-5 pb-4">
        <p className="text-pretty text-sm text-text-secondary">
          {t('adminSettings.botProtection.privacy.body', { provider: PRODUCT[provider], company: COMPANY[provider] })}
        </p>

        {notices.length > 1 ? (
          <div role="tablist" aria-label={t('adminSettings.botProtection.privacy.languages')} className="flex flex-wrap gap-2">
            {notices.map((set, index) => (
              <button
                key={set.code}
                type="button"
                role="tab"
                id={`${baseId}-tab-${set.code}`}
                aria-selected={index === active}
                aria-controls={`${baseId}-panel`}
                tabIndex={index === active ? 0 : -1}
                onClick={() => setActive(index)}
                onKeyDown={(event) => {
                  if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
                  event.preventDefault();
                  const next = (index + (event.key === 'ArrowRight' ? 1 : notices.length - 1)) % notices.length;
                  setActive(next);
                  document.getElementById(`${baseId}-tab-${notices[next]?.code}`)?.focus();
                }}
                className={`rounded-full border px-3 py-1 text-sm font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary ${
                  index === active
                    ? 'border-primary bg-primary/10 text-text-primary'
                    : 'border-border-subtle text-text-secondary hover:bg-surface-container'
                }`}
              >
                {set.name}
              </button>
            ))}
          </div>
        ) : null}

        {notice ? (
          <div
            id={`${baseId}-panel`}
            role={notices.length > 1 ? 'tabpanel' : undefined}
            aria-labelledby={notices.length > 1 ? `${baseId}-tab-${notice.code}` : undefined}
            className="grid gap-4"
          >
            {copyBlock(`${notice.code}-${provider}`, t('adminSettings.botProtection.privacy.noticeHeading'), notice[provider], 9)}
            {copyBlock(`${notice.code}-altcha`, t('adminSettings.botProtection.privacy.altchaHeading'), notice.altcha, 2)}
          </div>
        ) : null}
      </div>
    </Modal>
  );
}
