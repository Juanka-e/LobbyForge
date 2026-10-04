'use client';

import { useEffect, useState, type MouseEvent } from 'react';
import { useT } from '@/lib/i18n/client';
import { focusRing } from '@/app/(marketing)/_components/styles';

type CopyState = 'idle' | 'copied' | 'failed';

/**
 * Copies the code block it sits in. It reads the block's text from the
 * page when clicked, so the code is sent to the browser once (as the
 * block itself), not a second time as this component's props.
 */
export default function CopyCodeButton() {
  const t = useT();
  const [state, setState] = useState<CopyState>('idle');

  useEffect(() => {
    if (state === 'idle') return;
    const timer = setTimeout(() => setState('idle'), 2000);
    return () => clearTimeout(timer);
  }, [state]);

  async function copy(event: MouseEvent<HTMLButtonElement>) {
    const code = event.currentTarget.closest('[data-code-block]')?.querySelector('pre code')?.textContent ?? '';
    try {
      await navigator.clipboard.writeText(code);
      setState('copied');
    } catch {
      // No clipboard (an insecure origin, a denied permission): say so.
      setState('failed');
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={(event) => void copy(event)}
        aria-label={state === 'idle' ? t('developers.code.copyLabel') : undefined}
        className={`inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-xs font-medium text-text-secondary transition-colors hover:bg-surface-raised hover:text-text-primary ${focusRing}`}
      >
        <span className="material-symbols-outlined text-[16px]" aria-hidden>
          {state === 'copied' ? 'check' : 'content_copy'}
        </span>
        {state === 'copied' ? t('developers.code.copied') : state === 'failed' ? t('developers.code.copyFailed') : t('developers.code.copy')}
      </button>
      <span role="status" className="sr-only">
        {state === 'copied' ? t('developers.code.copiedStatus') : state === 'failed' ? t('developers.code.copyFailed') : ''}
      </span>
    </>
  );
}
