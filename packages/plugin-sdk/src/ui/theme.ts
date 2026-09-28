/**
 * The activity UI kit's colours, as CSS custom properties.
 *
 * Every value reads the host's theme variables (`--lf-*`, set by the app for
 * its dark, dim and light themes) with a dark fallback, so a panel matches
 * whatever theme the viewer picked — including community plugins the host
 * never compiled. The semantic tones (game, success, danger, info) are the
 * kit's own; `.lf-theme-light` swaps their TEXT shades for ones that stay
 * readable on white, while fills keep their brand colour.
 */

export type Tone = 'accent' | 'game' | 'success' | 'danger' | 'info' | 'neutral';

/** `var(--lfui-…)` references, for inline styles. */
export const lf = {
  surface: 'var(--lfui-surface)',
  raised: 'var(--lfui-raised)',
  sunken: 'var(--lfui-sunken)',
  container: 'var(--lfui-container)',
  border: 'var(--lfui-border)',
  borderStrong: 'var(--lfui-border-strong)',
  text: 'var(--lfui-text)',
  text2: 'var(--lfui-text-2)',
  muted: 'var(--lfui-muted)',
  track: 'var(--lfui-track)',
} as const;

export interface ToneColors {
  /** A solid fill (buttons, bars, dots). */
  fill: string;
  /** Text on top of `fill`. */
  onFill: string;
  /** Text or icon in this tone on a normal surface. */
  text: string;
  /** A tinted background for pills, callouts and highlights. */
  soft: string;
  /** A tinted border for highlighted cards. */
  line: string;
}

export function tone(name: Tone): ToneColors {
  if (name === 'neutral') {
    return { fill: lf.raised, onFill: lf.text, text: lf.text2, soft: lf.raised, line: lf.border };
  }
  return {
    fill: `var(--lfui-${name})`,
    onFill: `var(--lfui-on-${name})`,
    text: `var(--lfui-${name}-text)`,
    soft: `var(--lfui-${name}-soft)`,
    line: `var(--lfui-${name}-line)`,
  };
}

/** Avatar fills for players without a picture, picked by name so they stay stable. */
export const AVATAR_TINTS = ['#8FB8FF', '#E7B86A', '#7CCFA6', '#C9B6FF', '#E98282', '#A8B3C5', '#F5C451', '#6FD3E0'];

export function avatarTint(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) hash = (hash * 31 + seed.charCodeAt(i)) | 0;
  return AVATAR_TINTS[Math.abs(hash) % AVATAR_TINTS.length]!;
}

/**
 * The kit's stylesheet: the variables above plus what inline styles cannot
 * express — hover, focus rings, keyframes and reduced motion. Class names
 * are prefixed `lfui-` so they cannot collide with the host or a plugin.
 */
export const KIT_CSS = `
.lfui{
--lfui-surface:var(--lf-surface,#111722);
--lfui-raised:var(--lf-surface-raised,#171E2B);
--lfui-sunken:var(--lf-background,#0B1018);
--lfui-container:var(--lf-surface-container,#1D2533);
--lfui-border:var(--lf-border-subtle,#263142);
--lfui-border-strong:#334155;
--lfui-text:var(--lf-text-primary,#F4F7FB);
--lfui-text-2:var(--lf-text-secondary,#B7C0CC);
--lfui-muted:var(--lf-text-muted,#7F8A99);
--lfui-track:#263142;
--lfui-accent:var(--lf-user-accent,#8FB8FF);
--lfui-on-accent:var(--lf-on-accent,#07101E);
--lfui-accent-text:var(--lf-user-accent,#8FB8FF);
--lfui-accent-soft:rgba(143,184,255,.12);
--lfui-accent-line:rgba(143,184,255,.45);
--lfui-game:#E7B86A;--lfui-on-game:#2A1B00;--lfui-game-text:#E7B86A;
--lfui-game-soft:rgba(231,184,106,.14);--lfui-game-line:rgba(231,184,106,.45);
--lfui-success:#7CCFA6;--lfui-on-success:#06281A;--lfui-success-text:#7CCFA6;
--lfui-success-soft:rgba(124,207,166,.14);--lfui-success-line:rgba(124,207,166,.45);
--lfui-danger:#E98282;--lfui-on-danger:#3A0A0A;--lfui-danger-text:#F2A0A0;
--lfui-danger-soft:rgba(233,130,130,.14);--lfui-danger-line:rgba(233,130,130,.45);
--lfui-info:#8FB8FF;--lfui-on-info:#07101E;--lfui-info-text:#C9DAFF;
--lfui-info-soft:rgba(143,184,255,.10);--lfui-info-line:rgba(143,184,255,.35);
color:var(--lfui-text);
font-family:inherit;
}
.lf-theme-light .lfui{
--lfui-border-strong:#AEBBCC;
--lfui-track:#D5DDE8;
--lfui-game-text:#8A5A00;--lfui-success-text:#1E7A52;--lfui-danger-text:#B42318;
--lfui-info-text:#2F4A77;--lfui-accent-soft:rgba(84,109,151,.12);--lfui-accent-line:rgba(84,109,151,.45);
--lfui-game-soft:rgba(231,184,106,.22);--lfui-success-soft:rgba(124,207,166,.22);--lfui-danger-soft:rgba(233,130,130,.18);
}
.lfui-btn{cursor:pointer;transition:filter .15s ease,transform .15s ease,background-color .15s ease,border-color .15s ease}
.lfui-btn:hover:not(:disabled){filter:brightness(1.08)}
.lfui-btn:active:not(:disabled){transform:translateY(1px)}
.lfui-btn:disabled{cursor:not-allowed;opacity:.5}
.lfui-btn-quiet:hover:not(:disabled){background:var(--lfui-raised);filter:none}
.lfui-btn:focus-visible,.lfui-focus:focus-visible{outline:2px solid var(--lfui-accent);outline-offset:2px}
.lfui-option{cursor:pointer;transition:border-color .15s ease,background-color .15s ease,transform .15s ease}
.lfui-option:hover:not(:disabled){border-color:var(--lfui-border-strong)}
.lfui-option:disabled{cursor:default}
.lfui-pulse{animation:lfui-pulse 1.6s ease-in-out infinite}
@keyframes lfui-pulse{0%,100%{opacity:1}50%{opacity:.4}}
.lfui-pop{animation:lfui-pop .28s cubic-bezier(.2,.8,.2,1)}
@keyframes lfui-pop{from{transform:scale(.96);opacity:0}to{transform:none;opacity:1}}
.lfui-shake{animation:lfui-shake .4s ease}
@keyframes lfui-shake{0%,100%{transform:none}25%{transform:translateX(-4px)}75%{transform:translateX(4px)}}
.lfui-ring-progress{transition:stroke-dashoffset .3s linear}
.lfui-bar-fill{transition:width .35s ease}
@media (prefers-reduced-motion: reduce){.lfui *{animation:none!important;transition:none!important}}
.force-reduced-motion .lfui *{animation:none!important;transition:none!important}
`;
