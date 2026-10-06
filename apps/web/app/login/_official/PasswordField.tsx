'use client';

import { useState, type ReactNode } from 'react';
import { EyeIcon, EyeOffIcon } from '@/app/(marketing)/_components/icons';
import { focusRing } from '@/app/(marketing)/_components/styles';
import { useT } from '@/lib/i18n/client';
import { authInput } from './styles';

/**
 * A password input with a show/hide toggle. The toggle is a real button
 * with a constant name and `aria-pressed`, so a screen reader hears
 * "Show password, toggle button, pressed" rather than a name that flips.
 */
export default function PasswordField({
  id,
  label,
  labelAside,
  value,
  onChange,
  autoComplete,
  placeholder,
  minLength,
  describedBy,
  inputClassName = authInput,
  labelClassName = 'text-sm font-medium text-text-primary',
  children,
}: {
  id: string;
  label: string;
  /** Rendered at the label's far end (the design's "Forgot password?" slot). */
  labelAside?: ReactNode;
  value: string;
  onChange: (value: string) => void;
  autoComplete: 'current-password' | 'new-password';
  placeholder: string;
  minLength?: number;
  describedBy?: string;
  /** The input's look; the hub's 48 px field unless a self-hosted form passes its own. */
  inputClassName?: string;
  labelClassName?: string;
  /** Anything that belongs under the input, e.g. a strength meter. */
  children?: ReactNode;
}) {
  const t = useT();
  const [visible, setVisible] = useState(false);
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-3">
        <label htmlFor={id} className={labelClassName}>
          {label}
        </label>
        {labelAside}
      </div>
      <div className="relative">
        <input
          id={id}
          type={visible ? 'text' : 'password'}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          required
          minLength={minLength}
          maxLength={128}
          autoComplete={autoComplete}
          placeholder={placeholder}
          aria-describedby={describedBy}
          className={`${inputClassName} pr-12`}
        />
        <button
          type="button"
          onClick={() => setVisible((shown) => !shown)}
          aria-pressed={visible}
          aria-controls={id}
          className={`absolute right-0.5 top-1/2 flex size-11 -translate-y-1/2 items-center justify-center rounded-[10px] text-text-secondary transition-colors hover:text-text-primary ${focusRing}`}
        >
          {visible ? <EyeOffIcon size={18} /> : <EyeIcon size={18} />}
          <span className="sr-only">{t('auth.official.showPassword')}</span>
        </button>
      </div>
      {children}
    </div>
  );
}
