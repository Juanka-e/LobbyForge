'use client';

import { useId, type CSSProperties, type InputHTMLAttributes, type ReactNode } from 'react';
import { lf, tone } from '@lobbyforge/plugin-sdk/ui';

/*
 * Small generic pieces the UI kit does not ship (yet). They follow the
 * kit's look — its `--lfui-*` colours and its `lfui-option` / `lfui-focus`
 * classes for hover and the focus ring — so they read as part of it.
 */

const srOnly: CSSProperties = {
  position: 'absolute',
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: 'hidden',
  clip: 'rect(0 0 0 0)',
  whiteSpace: 'nowrap',
  border: 0,
};

/** Text for screen readers only. */
export function VisuallyHidden({ children }: { children: ReactNode }) {
  return <span style={srOnly}>{children}</span>;
}

/** A labelled group of controls: a visible caption over the control, and an optional hint. */
export function Field({ label, hint, children }: { label: ReactNode; hint?: ReactNode; children: ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0 }}>
      <span style={{ fontSize: 13, fontWeight: 600, color: lf.text2 }}>{label}</span>
      {children}
      {hint ? <span style={{ fontSize: 12, lineHeight: 1.5, color: lf.muted }}>{hint}</span> : null}
    </div>
  );
}

export interface TextFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'id'> {
  label: ReactNode;
  hint?: ReactNode;
}

/** A labelled text input. */
export function TextField({ label, hint, style, ...input }: TextFieldProps) {
  const id = useId();
  const hintId = `${id}-hint`;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
      <label htmlFor={id} style={{ fontSize: 13, fontWeight: 600, color: lf.text2 }}>
        {label}
      </label>
      <input
        id={id}
        type="text"
        aria-describedby={hint ? hintId : undefined}
        className="lfui-focus"
        style={{
          minHeight: 44,
          boxSizing: 'border-box',
          width: '100%',
          padding: '0 14px',
          borderRadius: 12,
          border: `1px solid ${lf.borderStrong}`,
          background: lf.sunken,
          color: lf.text,
          font: 'inherit',
          fontSize: 15,
          ...style,
        }}
        {...input}
      />
      {hint ? (
        <span id={hintId} style={{ fontSize: 12, lineHeight: 1.5, color: lf.muted }}>
          {hint}
        </span>
      ) : null}
    </div>
  );
}

/** A large selectable tile — one of several mutually exclusive choices (a word pack). */
export function ChoiceTile({
  selected,
  onSelect,
  disabled = false,
  children,
}: {
  selected: boolean;
  onSelect: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  const accent = tone('accent');
  return (
    <button
      type="button"
      aria-pressed={selected}
      disabled={disabled}
      onClick={onSelect}
      className="lfui-option lfui-focus"
      style={{
        boxSizing: 'border-box',
        width: '100%',
        minWidth: 0,
        minHeight: 72,
        padding: '14px 16px',
        borderRadius: 16,
        font: 'inherit',
        textAlign: 'start',
        color: lf.text,
        background: selected ? accent.soft : lf.raised,
        border: `1px solid ${selected ? accent.line : lf.border}`,
        boxShadow: selected ? `inset 0 0 0 1px ${accent.line}` : 'none',
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
      }}
    >
      {children}
    </button>
  );
}

/** A dashed placeholder the size of a player chip — an empty seat on a team. */
export function EmptySeat({ children }: { children: ReactNode }) {
  return (
    <span
      style={{
        minHeight: 44,
        boxSizing: 'border-box',
        padding: '4px 14px',
        borderRadius: 99,
        border: `1px dashed ${lf.borderStrong}`,
        color: lf.muted,
        fontSize: 13,
        display: 'inline-flex',
        alignItems: 'center',
      }}
    >
      {children}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Icons — decorative, always next to text that says the same thing
// ---------------------------------------------------------------------------

const iconProps = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.6,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
  focusable: false,
};

export function ListenIcon({ size = 36 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" {...iconProps}>
      <path d="M6 15.5V11a6 6 0 1 1 12 0c0 2.4-1.2 3.4-2.3 4.3-1 .8-1.7 1.5-1.7 3.2a2.5 2.5 0 0 1-4.6 1.3" />
      <path d="M9.5 11a2.5 2.5 0 0 1 5 0c0 1.1-.6 1.6-1.2 2" />
    </svg>
  );
}

export function EyeIcon({ size = 36 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" {...iconProps}>
      <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

export function PeopleIcon({ size = 36 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" {...iconProps}>
      <circle cx="9" cy="8" r="3.5" />
      <path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6" />
      <path d="M17 8v6M14 11h6" />
    </svg>
  );
}

export function TrophyIcon({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" {...iconProps}>
      <path d="M8 4h8v5a4 4 0 0 1-8 0V4Z" />
      <path d="M16 6h3v1.5A3.5 3.5 0 0 1 15.6 11M8 6H5v1.5A3.5 3.5 0 0 0 8.4 11" />
      <path d="M12 13v4M8.5 20h7M10 17h4v3h-4z" />
    </svg>
  );
}

export function CloseIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" {...iconProps} strokeWidth={2}>
      <path d="M6 6l12 12M18 6 6 18" />
    </svg>
  );
}
