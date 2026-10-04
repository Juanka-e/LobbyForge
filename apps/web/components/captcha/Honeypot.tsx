'use client';

import { useId } from 'react';
import { useT } from '@/lib/i18n/client';

/**
 * The honeypot of docs/CAPTCHA.md §6: a `website` field people never see
 * or reach — off-screen rather than `display: none`, which form-filling
 * bots skip — hidden from assistive technology and out of the tab order.
 * Anything typed into it is sent as-is, and the server answers
 * `form_rejected`.
 */
export function Honeypot({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const t = useT();
  const id = useId();
  return (
    <div aria-hidden="true" className="pointer-events-none absolute -left-[10000px] top-auto size-px overflow-hidden opacity-0">
      <label htmlFor={id}>{t('captcha.honeypot.label')}</label>
      <input
        id={id}
        type="text"
        name="website"
        tabIndex={-1}
        autoComplete="off"
        data-1p-ignore="true"
        data-lpignore="true"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}
