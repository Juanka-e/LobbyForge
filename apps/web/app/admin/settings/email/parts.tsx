'use client';

import type { ReactNode } from 'react';
import { useT } from '@/lib/i18n/client';

/** The admin settings cards' shared look (see BotProtectionCard). */
export const inputClass =
  'w-full rounded-lg border border-border-strong bg-surface-raised px-3 py-2 text-sm text-text-primary outline-none focus:border-primary disabled:cursor-not-allowed disabled:opacity-60 read-only:bg-surface-container/40 read-only:text-text-secondary';
export const fieldLabel = 'mb-1.5 block text-xs text-text-muted';
export const hintClass = 'mt-1.5 text-pretty text-xs text-text-muted';
export const focusRing = 'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary';
export const secondaryButton = `rounded-lg border border-border-strong px-3 py-1.5 text-sm font-medium text-text-secondary transition-colors hover:bg-surface-raised hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-40 ${focusRing}`;
export const primaryButton = `rounded-lg bg-primary-container px-4 py-2 text-sm font-semibold text-on-primary-container transition-all hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40 ${focusRing}`;

export function Section({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <div className="mt-5 border-t border-border-subtle pt-5">
      <h3 className="text-sm font-semibold text-text-primary">{title}</h3>
      {description ? <p className="mt-1 max-w-2xl text-pretty text-sm text-text-secondary">{description}</p> : null}
      <div className="mt-3">{children}</div>
    </div>
  );
}

export function LockedNote({ name }: { name: string }) {
  const t = useT();
  return (
    <p className="mt-1.5 flex items-center gap-1.5 text-xs text-text-muted">
      <span className="material-symbols-outlined text-sm" aria-hidden>
        lock
      </span>
      <span>{t('adminSettings.email.lockedBy', { name })}</span>
    </p>
  );
}

export function Note({ icon = 'info', tone = 'muted', children }: { icon?: string; tone?: 'muted' | 'warning'; children: ReactNode }) {
  return (
    <p
      className={`flex gap-2 text-sm ${
        tone === 'warning'
          ? 'rounded-xl border border-ember/40 bg-ember/10 px-3.5 py-2.5 text-text-primary'
          : 'text-text-secondary'
      }`}
    >
      <span className={`material-symbols-outlined text-lg ${tone === 'warning' ? 'text-ember' : 'text-text-muted'}`} aria-hidden>
        {icon}
      </span>
      <span className="min-w-0 text-pretty">{children}</span>
    </p>
  );
}

export function Toggle(props: {
  checked: boolean;
  disabled?: boolean;
  label: string;
  description: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label
      className={`flex gap-3 rounded-xl border border-border-subtle bg-surface-container/40 p-4 focus-within:outline focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-primary ${
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
        <span className="mt-1 block text-pretty text-sm text-text-secondary">{props.description}</span>
      </span>
    </label>
  );
}

export interface Choice<T extends string> {
  value: T;
  label: string;
  description?: string;
  disabled?: boolean;
}

/** Radio cards with a description each (verification mode). */
export function ChoiceCards<T extends string>(props: {
  name: string;
  legend: string;
  value: T;
  disabled?: boolean;
  choices: Array<Choice<T>>;
  onChange: (value: T) => void;
  describedBy?: string;
}) {
  return (
    <fieldset disabled={props.disabled} className="min-w-0" aria-describedby={props.describedBy}>
      <legend className="sr-only">{props.legend}</legend>
      <div className="grid gap-3 md:grid-cols-3">
        {props.choices.map((choice) => {
          const active = props.value === choice.value;
          const off = props.disabled || choice.disabled;
          return (
            <label
              key={choice.value}
              className={`flex gap-3 rounded-xl border p-4 transition-colors focus-within:outline focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-primary ${
                off ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'
              } ${
                active
                  ? 'border-primary-container bg-primary-container/10'
                  : 'border-border-subtle bg-surface-container/40 hover:bg-surface-raised/50'
              }`}
            >
              <input
                type="radio"
                name={props.name}
                value={choice.value}
                checked={active}
                disabled={choice.disabled}
                onChange={() => props.onChange(choice.value)}
                className="mt-1"
              />
              <span className="min-w-0">
                <span className="block text-sm font-medium text-text-primary">{choice.label}</span>
                {choice.description ? (
                  <span className="mt-1 block text-pretty text-sm text-text-secondary">{choice.description}</span>
                ) : null}
              </span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
