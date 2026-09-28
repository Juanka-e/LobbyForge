import { useId } from 'react';
import type { ButtonHTMLAttributes, CSSProperties, HTMLAttributes, InputHTMLAttributes, ReactNode } from 'react';
import { KIT_CSS, avatarTint, lf, tone as toneOf, type Tone } from './theme.js';

/*
 * The activity UI kit — building blocks for plugin panels.
 *
 * Plugins live outside the host's Tailwind build, so the kit styles itself:
 * layout and colour inline (theme-aware through `--lfui-*` variables), and
 * one small stylesheet for hover, focus and motion. Wrap every panel in
 * <ActivityShell>: it defines the variables and brings the stylesheet.
 */

const cx = (...names: Array<string | false | null | undefined>) => names.filter(Boolean).join(' ');

// ---------------------------------------------------------------------------
// Shell and layout
// ---------------------------------------------------------------------------

export interface ActivityShellProps extends HTMLAttributes<HTMLDivElement> {
  children?: ReactNode;
}

/** The root of a plugin panel: theme variables, the kit stylesheet, a vertical rhythm. */
export function ActivityShell({ children, className, style, ...rest }: ActivityShellProps) {
  return (
    <div
      className={cx('lfui', className)}
      style={{ display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0, ...style }}
      {...rest}
    >
      {/* React 19 hoists this into <head> once, however many panels mount. */}
      <style href="lfui-kit-v1" precedence="lfui">
        {KIT_CSS}
      </style>
      {children}
    </div>
  );
}

interface GapProps {
  gap?: number;
  children?: ReactNode;
  style?: CSSProperties;
  className?: string;
}

export function Stack({ gap = 12, children, style, className }: GapProps) {
  return (
    <div className={className} style={{ display: 'flex', flexDirection: 'column', gap, minWidth: 0, ...style }}>
      {children}
    </div>
  );
}

export function Row({
  gap = 12,
  align = 'center',
  justify = 'flex-start',
  wrap = false,
  children,
  style,
  className,
}: GapProps & { align?: CSSProperties['alignItems']; justify?: CSSProperties['justifyContent']; wrap?: boolean }) {
  return (
    <div
      className={className}
      style={{ display: 'flex', alignItems: align, justifyContent: justify, flexWrap: wrap ? 'wrap' : 'nowrap', gap, minWidth: 0, ...style }}
    >
      {children}
    </div>
  );
}

/** A responsive grid: as many columns of at least `min` px as fit. */
export function Grid({ min = 160, gap = 12, children, style, className }: GapProps & { min?: number }) {
  return (
    <div
      className={className}
      style={{ display: 'grid', gridTemplateColumns: `repeat(auto-fit, minmax(min(${min}px, 100%), 1fr))`, gap, ...style }}
    >
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Surfaces
// ---------------------------------------------------------------------------

export interface PanelProps extends HTMLAttributes<HTMLDivElement> {
  /** `surface` (default), `raised` (a card on a card), `sunken` (wells), `outline` (dashed). */
  variant?: 'surface' | 'raised' | 'sunken' | 'outline';
  /** Tints the panel and its border — for the "current" team, the selected card… */
  highlight?: Tone;
  padding?: number | string;
  radius?: number;
}

export function Panel({ variant = 'surface', highlight, padding = 20, radius = 20, style, children, ...rest }: PanelProps) {
  const background =
    variant === 'raised' ? lf.raised : variant === 'sunken' ? lf.sunken : variant === 'outline' ? 'transparent' : lf.surface;
  const border = variant === 'outline' ? `1px dashed ${lf.borderStrong}` : `1px solid ${lf.border}`;
  const tint = highlight ? toneOf(highlight) : null;
  return (
    <div
      style={{
        boxSizing: 'border-box',
        minWidth: 0,
        padding,
        borderRadius: radius,
        background: tint ? tint.soft : background,
        border: tint ? `1px solid ${tint.line}` : border,
        ...style,
      }}
      {...rest}
    >
      {children}
    </div>
  );
}

/** A small uppercase heading for a group of controls. */
export function SectionLabel({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return (
    <span style={{ fontSize: 12, fontWeight: 500, letterSpacing: '0.12em', textTransform: 'uppercase', color: lf.muted, ...style }}>
      {children}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Header, status and time
// ---------------------------------------------------------------------------

export interface ActivityHeaderProps {
  /** A letter or an inline SVG for the game's tile. */
  glyph: ReactNode;
  tone?: Tone;
  title: ReactNode;
  subtitle?: ReactNode;
  /** Usually a <PhasePill>. */
  status?: ReactNode;
  /** Usually a <TimerRing>. */
  timer?: ReactNode;
  /** Host controls, "Leave", … */
  actions?: ReactNode;
}

export function ActivityHeader({ glyph, tone = 'game', title, subtitle, status, timer, actions }: ActivityHeaderProps) {
  const t = toneOf(tone);
  return (
    <header
      style={{
        boxSizing: 'border-box',
        minHeight: 76,
        padding: '12px 20px',
        borderRadius: 20,
        background: lf.surface,
        border: `1px solid ${lf.border}`,
        display: 'flex',
        alignItems: 'center',
        flexWrap: 'wrap',
        gap: 16,
      }}
    >
      <span
        aria-hidden="true"
        style={{
          width: 44,
          height: 44,
          flexShrink: 0,
          borderRadius: 13,
          background: t.soft,
          color: t.text,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 21,
          fontWeight: 800,
        }}
      >
        {glyph}
      </span>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 }}>
        <span style={{ fontSize: 17, fontWeight: 600 }}>{title}</span>
        {subtitle ? <span style={{ fontSize: 13, color: lf.text2 }}>{subtitle}</span> : null}
      </div>
      {status}
      <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 12 }}>
        {timer}
        {actions}
      </div>
    </header>
  );
}

export function PhasePill({ children, tone = 'game', live = false }: { children: ReactNode; tone?: Tone; live?: boolean }) {
  const t = toneOf(tone);
  return (
    <span
      style={{
        minHeight: 28,
        padding: '4px 12px',
        boxSizing: 'border-box',
        borderRadius: 99,
        background: t.soft,
        color: t.text,
        fontSize: 12,
        fontWeight: 600,
        letterSpacing: '0.06em',
        textTransform: 'uppercase',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 8,
      }}
    >
      {live ? <span className="lfui-pulse" aria-hidden="true" style={{ width: 7, height: 7, borderRadius: 99, background: t.fill }} /> : null}
      {children}
    </span>
  );
}

export function Badge({ children, tone = 'neutral' }: { children: ReactNode; tone?: Tone }) {
  const t = toneOf(tone);
  return (
    <span
      style={{
        minHeight: 22,
        padding: '2px 8px',
        boxSizing: 'border-box',
        borderRadius: 99,
        background: t.soft,
        color: t.text,
        fontSize: 11,
        fontWeight: 600,
        letterSpacing: '0.06em',
        textTransform: 'uppercase',
        display: 'inline-flex',
        alignItems: 'center',
      }}
    >
      {children}
    </span>
  );
}

/** "0:37", "1:05", "12:00" — minutes and seconds, never negative. */
export function formatClock(seconds: number): string {
  const s = Math.max(0, Math.ceil(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export interface TimerRingProps {
  /** Seconds left. */
  seconds: number;
  /** The full duration, for the ring's progress. */
  total: number;
  tone?: Tone;
  size?: number;
  /** Accessible text, e.g. "37 seconds left" — translate it. */
  label: string;
}

export function TimerRing({ seconds, total, tone = 'game', size = 52, label }: TimerRingProps) {
  const t = toneOf(tone);
  const stroke = 4;
  const r = size / 2 - stroke;
  const circumference = 2 * Math.PI * r;
  const fraction = total > 0 ? Math.min(1, Math.max(0, seconds / total)) : 0;
  const shown = seconds >= 60 ? formatClock(seconds) : String(Math.max(0, Math.ceil(seconds)));
  return (
    <span role="timer" aria-label={label} style={{ position: 'relative', width: size, height: size, flexShrink: 0 }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={lf.track} strokeWidth={stroke} />
        <circle
          className="lfui-ring-progress"
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={seconds <= 5 && total > 0 ? toneOf('danger').fill : t.fill}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - fraction)}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      </svg>
      <span
        aria-hidden="true"
        style={{
          position: 'absolute',
          inset: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontVariantNumeric: 'tabular-nums',
          fontSize: size >= 52 ? 15 : 13,
          fontWeight: 600,
        }}
      >
        {shown}
      </span>
    </span>
  );
}

export interface ProgressBarProps {
  /** 0 to 1. */
  value: number;
  tone?: Tone;
  height?: number;
  /** Accessible name, e.g. "Time left". */
  label?: string;
  /** Accessible value text, e.g. "12 seconds". */
  valueText?: string;
}

export function ProgressBar({ value, tone = 'accent', height = 8, label, valueText }: ProgressBarProps) {
  const pct = Math.round(Math.min(1, Math.max(0, value)) * 100);
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct}
      aria-valuetext={valueText}
      style={{ height, borderRadius: height, background: lf.track, overflow: 'hidden' }}
    >
      <div className="lfui-bar-fill" style={{ width: `${pct}%`, height: '100%', borderRadius: height, background: toneOf(tone).fill }} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------

export type ButtonVariant = 'primary' | 'game' | 'success' | 'danger' | 'secondary' | 'ghost';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: 'sm' | 'md' | 'lg';
  block?: boolean;
}

const BUTTON_HEIGHT = { sm: 36, md: 44, lg: 52 } as const;

export function Button({ variant = 'primary', size = 'md', block = false, type = 'button', className, style, children, ...rest }: ButtonProps) {
  let colours: CSSProperties;
  switch (variant) {
    case 'primary':
      colours = { background: 'var(--lfui-accent)', color: 'var(--lfui-on-accent)', border: '1px solid transparent', fontWeight: 600 };
      break;
    case 'game':
    case 'success': {
      const t = toneOf(variant);
      colours = { background: t.fill, color: t.onFill, border: '1px solid transparent', fontWeight: 600 };
      break;
    }
    case 'danger': {
      const t = toneOf('danger');
      colours = { background: t.soft, color: t.text, border: `1px solid ${t.line}`, fontWeight: 600 };
      break;
    }
    case 'secondary':
      colours = { background: 'transparent', color: lf.text, border: `1px solid ${lf.borderStrong}`, fontWeight: 500 };
      break;
    default:
      colours = { background: 'transparent', color: lf.text2, border: '1px solid transparent', fontWeight: 500 };
  }
  const height = BUTTON_HEIGHT[size];
  return (
    <button
      type={type}
      className={cx('lfui-btn', variant === 'ghost' && 'lfui-btn-quiet', className)}
      style={{
        minHeight: height,
        padding: size === 'sm' ? '0 12px' : size === 'lg' ? '0 24px' : '0 18px',
        borderRadius: size === 'lg' ? 16 : 14,
        font: 'inherit',
        fontSize: size === 'sm' ? 14 : size === 'lg' ? 16 : 15,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
        width: block ? '100%' : undefined,
        boxSizing: 'border-box',
        ...colours,
        ...style,
      }}
      {...rest}
    >
      {children}
    </button>
  );
}

/** Present to screen readers, invisible on screen. */
export const visuallyHidden: CSSProperties = {
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

export function VisuallyHidden({ children }: { children: ReactNode }) {
  return <span style={visuallyHidden}>{children}</span>;
}

export interface TextFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> {
  /** The visible label — required; pass `hideLabel` to keep it for screen readers only. */
  label: ReactNode;
  hideLabel?: boolean;
  /** Help under the field. */
  hint?: ReactNode;
  /** An error under the field; marks it invalid. */
  error?: ReactNode;
}

/** A labelled text input with hint and error wired to it for assistive tech. */
export function TextField({ label, hideLabel = false, hint, error, id, style, ...rest }: TextFieldProps) {
  const autoId = useId();
  const inputId = id ?? `lfui-field-${autoId}`;
  const hintId = hint ? `${inputId}-hint` : undefined;
  const errorId = error ? `${inputId}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(' ') || undefined;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
      <label htmlFor={inputId} style={hideLabel ? visuallyHidden : { fontSize: 14, fontWeight: 500, color: lf.text }}>
        {label}
      </label>
      <input
        id={inputId}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        className="lfui-focus"
        style={{
          boxSizing: 'border-box',
          width: '100%',
          minWidth: 0,
          minHeight: 44,
          padding: '10px 14px',
          borderRadius: 12,
          border: `1px solid ${error ? toneOf('danger').fill : lf.borderStrong}`,
          background: lf.sunken,
          color: lf.text,
          font: 'inherit',
          fontSize: 15,
          ...style,
        }}
        {...rest}
      />
      {hint ? <span id={hintId} style={{ fontSize: 13, color: lf.muted }}>{hint}</span> : null}
      {error ? <span id={errorId} style={{ fontSize: 13, lineHeight: 1.4, color: toneOf('danger').text }}>{error}</span> : null}
    </div>
  );
}

export interface SegmentedOption<T extends string> {
  value: T;
  label: ReactNode;
}

/** A row of mutually exclusive choices (mode, difficulty, duration). */
export function SegmentedControl<T extends string>({
  label,
  options,
  value,
  onChange,
  disabled = false,
}: {
  /** Accessible name for the group. */
  label: string;
  options: Array<SegmentedOption<T>>;
  value: T;
  onChange: (value: T) => void;
  disabled?: boolean;
}) {
  return (
    <div role="group" aria-label={label} style={{ display: 'flex', flexWrap: 'wrap', gap: 6, padding: 4, borderRadius: 14, background: lf.sunken, border: `1px solid ${lf.border}` }}>
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={selected}
            disabled={disabled}
            onClick={() => onChange(option.value)}
            className="lfui-btn lfui-focus"
            style={{
              minHeight: 36,
              padding: '0 14px',
              borderRadius: 10,
              border: 0,
              font: 'inherit',
              fontSize: 14,
              fontWeight: selected ? 600 : 500,
              background: selected ? lf.raised : 'transparent',
              color: selected ? lf.text : lf.text2,
              boxShadow: selected ? `inset 0 0 0 1px ${lf.borderStrong}` : 'none',
            }}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// People and scores
// ---------------------------------------------------------------------------

export function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const letters = parts.length > 1 ? `${parts[0]![0]}${parts[1]![0]}` : (parts[0] ?? '?').slice(0, 1);
  return letters.toLocaleUpperCase();
}

export function Avatar({ name, size = 34, tint }: { name: string; size?: number; tint?: string }) {
  return (
    <span
      aria-hidden="true"
      style={{
        width: size,
        height: size,
        flexShrink: 0,
        borderRadius: 99,
        background: tint ?? avatarTint(name),
        color: '#07101E',
        fontWeight: 700,
        fontSize: Math.round(size * 0.4),
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      {initialsOf(name)}
    </span>
  );
}

export interface PlayerChipProps {
  name: string;
  /** A short status after the name: "HOST", "READY", "OUT"… (translated). */
  tag?: ReactNode;
  tagTone?: Tone;
  /** Rings the chip — the current explainer, the speaker, your own chip. */
  highlight?: Tone;
  /** Greys the chip out — eliminated, disconnected. */
  dimmed?: boolean;
  trailing?: ReactNode;
}

export function PlayerChip({ name, tag, tagTone = 'neutral', highlight, dimmed = false, trailing }: PlayerChipProps) {
  const ring = highlight ? toneOf(highlight).line : lf.border;
  return (
    <span
      style={{
        minHeight: 44,
        boxSizing: 'border-box',
        padding: '4px 14px 4px 5px',
        borderRadius: 99,
        background: lf.raised,
        border: `1px solid ${ring}`,
        display: 'inline-flex',
        alignItems: 'center',
        gap: 9,
        opacity: dimmed ? 0.55 : 1,
        maxWidth: '100%',
      }}
    >
      <Avatar name={name} />
      <span style={{ fontSize: 14, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textDecoration: dimmed ? 'line-through' : 'none' }}>
        {name}
      </span>
      {tag ? (
        <span style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: toneOf(tagTone).text }}>{tag}</span>
      ) : null}
      {trailing}
    </span>
  );
}

export interface ScoreRow {
  id: string;
  name: ReactNode;
  score: number | string;
  /** Marks the leader, your team… */
  highlight?: boolean;
  detail?: ReactNode;
}

export function Scoreboard({ rows, label }: { rows: ScoreRow[]; label?: string }) {
  return (
    <ol aria-label={label} style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
      {rows.map((row, index) => {
        const accent = toneOf('accent');
        return (
          <li
            key={row.id}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              padding: '10px 14px',
              borderRadius: 14,
              background: row.highlight ? accent.soft : lf.raised,
              border: `1px solid ${row.highlight ? accent.line : 'transparent'}`,
            }}
          >
            <span style={{ width: 18, fontSize: 12, fontWeight: 600, color: row.highlight ? accent.text : lf.muted, fontVariantNumeric: 'tabular-nums' }}>
              {index + 1}
            </span>
            <span style={{ flexGrow: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
              <span style={{ fontSize: 15, fontWeight: row.highlight ? 600 : 500 }}>{row.name}</span>
              {row.detail ? <span style={{ fontSize: 12, color: lf.muted }}>{row.detail}</span> : null}
            </span>
            <span style={{ fontSize: 18, fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{row.score}</span>
          </li>
        );
      })}
    </ol>
  );
}

export function Stat({ label, value, tone }: { label: ReactNode; value: ReactNode; tone?: Tone }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
      <SectionLabel>{label}</SectionLabel>
      <span style={{ fontSize: 22, fontWeight: 700, color: tone ? toneOf(tone).text : lf.text, fontVariantNumeric: 'tabular-nums' }}>{value}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export function Callout({ tone = 'info', children, role }: { tone?: Tone; children: ReactNode; role?: 'status' | 'alert' }) {
  const t = toneOf(tone);
  return (
    <div role={role} style={{ padding: '12px 14px', borderRadius: 14, background: t.soft, color: t.text, fontSize: 14, lineHeight: 1.5 }}>
      {children}
    </div>
  );
}

export function EmptyState({ icon, title, body, action }: { icon?: ReactNode; title: ReactNode; body?: ReactNode; action?: ReactNode }) {
  return (
    <div
      style={{
        padding: '28px 20px',
        borderRadius: 20,
        background: lf.surface,
        border: `1px dashed ${lf.borderStrong}`,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 10,
        textAlign: 'center',
      }}
    >
      {icon ? <span aria-hidden="true" style={{ color: lf.muted }}>{icon}</span> : null}
      <span style={{ fontSize: 15, fontWeight: 600 }}>{title}</span>
      {body ? <span style={{ fontSize: 14, lineHeight: 1.5, color: lf.text2, maxWidth: 420 }}>{body}</span> : null}
      {action}
    </div>
  );
}
