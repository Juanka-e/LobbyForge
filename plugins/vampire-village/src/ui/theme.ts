/**
 * Vampire Village's own palette, layered on the activity UI kit.
 *
 * Day phases use the kit as it is (its surfaces + the amber `game` tone).
 * Night phases re-scope the kit's own `--lfui-*` tokens inside `.vv-night`
 * — deep plum surfaces, a rose accent — so every kit piece (Panel, Button,
 * TimerRing, ActivityHeader…) turns to night with no per-component work.
 * `.lf-theme-light` (set on <html> by the app) gets a light plum night that
 * keeps text at ≥ 4.5:1, instead of a dark island on a white page.
 *
 * Motion: the dusk vignette, the dawn light-wipe and the stars are
 * decoration only. Their resting state is invisible, and the kit's
 * reduced-motion rule (`.lfui *{animation:none!important}`) switches the
 * animations off, which leaves them invisible — never stuck on screen.
 */
import type { VillageColor } from '../state';

/** Avatar fills for the character colours; the kit's Avatar prints dark initials on them. */
export const COLOR_HEX: Record<VillageColor, string> = {
  rose: '#E68A9B',
  amber: '#E7B86A',
  ice: '#8FB8FF',
  mint: '#7CCFA6',
  violet: '#C9B6FF',
  coral: '#E98282',
  sky: '#6FD3E0',
  sand: '#D9C4A0',
};

/** Rose, for night accents drawn inline (with the dark value as fallback). */
export const ROSE = {
  text: 'var(--vv-rose-text, #F3C1CA)',
  line: 'var(--vv-rose-line, rgba(217,103,123,.45))',
  soft: 'var(--vv-rose-soft, rgba(217,103,123,.14))',
  fill: 'var(--vv-rose, #E68A9B)',
} as const;

export const VV_CSS = `
.vv-stage{position:relative;display:flex;flex-direction:column;gap:16px;min-width:0;padding:16px;border-radius:26px;
border:1px solid var(--vv-edge,rgba(231,184,106,.28));background:var(--vv-bg,transparent);
transition:background-color .8s ease,border-color .8s ease;isolation:isolate}
.vv-stage>*{position:relative;z-index:1}
.vv-stage>.vv-veil,.vv-stage>.vv-stars{position:absolute;z-index:0}
.vv-day{--vv-edge:rgba(231,184,106,.28);--vv-bg:transparent}
.vv-night{
--vv-bg:#0E0A12;--vv-edge:rgba(217,103,123,.28);
--vv-rose:#E68A9B;--vv-rose-text:#F3C1CA;--vv-rose-soft:rgba(217,103,123,.14);--vv-rose-line:rgba(217,103,123,.45);
--lfui-surface:#150E14;--lfui-raised:#1A1016;--lfui-sunken:#120B10;--lfui-container:#221520;
--lfui-border:#2A1B24;--lfui-border-strong:#4A2E3B;--lfui-track:#2A1B24;
--lfui-text:#F7EEF1;--lfui-text-2:#D9C4CA;--lfui-muted:#B89AA4;
--lfui-accent:#E68A9B;--lfui-on-accent:#2A0A14;--lfui-accent-text:#F3C1CA;
--lfui-accent-soft:rgba(217,103,123,.16);--lfui-accent-line:rgba(217,103,123,.45);
color:var(--lfui-text)}
.lf-theme-light .vv-day{--vv-edge:rgba(138,90,0,.28)}
.lf-theme-light .vv-night{
--vv-bg:#F7EDF1;--vv-edge:rgba(142,42,67,.28);
--vv-rose:#A8344F;--vv-rose-text:#8E2A43;--vv-rose-soft:rgba(168,52,79,.10);--vv-rose-line:rgba(168,52,79,.40);
--lfui-surface:#FFF9FB;--lfui-raised:#F8ECF0;--lfui-sunken:#F3E4EA;--lfui-container:#EBD7DF;
--lfui-border:#E2C7D1;--lfui-border-strong:#C79AAB;--lfui-track:#E8D3DA;
--lfui-text:#2A1520;--lfui-text-2:#553543;--lfui-muted:#6F4C5A;
--lfui-accent:#A8344F;--lfui-on-accent:#FFFFFF;--lfui-accent-text:#8E2A43;
--lfui-accent-soft:rgba(168,52,79,.10);--lfui-accent-line:rgba(168,52,79,.40)}
.vv-veil{inset:0;border-radius:inherit;pointer-events:none;opacity:0}
.vv-veil-dusk{background:radial-gradient(ellipse at center,rgba(10,4,14,0) 30%,rgba(10,4,14,.85) 100%);animation:vv-dusk 1.3s ease-in-out}
.vv-veil-dawn{background:linear-gradient(180deg,rgba(255,228,170,.38) 0%,rgba(255,228,170,0) 70%);animation:vv-dawn 1.2s ease-out}
@keyframes vv-dusk{0%{opacity:0}35%{opacity:1}100%{opacity:0}}
@keyframes vv-dawn{0%{opacity:1;transform:translateY(-100%)}60%{opacity:.8}100%{opacity:0;transform:translateY(0)}}
.vv-stars{top:0;left:0;right:0;height:140px;border-radius:26px 26px 0 0;pointer-events:none;opacity:.55;
background-image:radial-gradient(1.5px 1.5px at 12% 30%,#F3C1CA 50%,transparent 51%),radial-gradient(1px 1px at 28% 62%,#fff 50%,transparent 51%),
radial-gradient(1.5px 1.5px at 47% 22%,#fff 50%,transparent 51%),radial-gradient(1px 1px at 63% 48%,#F3C1CA 50%,transparent 51%),
radial-gradient(1.5px 1.5px at 78% 18%,#fff 50%,transparent 51%),radial-gradient(1px 1px at 91% 55%,#fff 50%,transparent 51%);
animation:vv-twinkle 4s ease-in-out infinite}
.lf-theme-light .vv-stars{display:none}
@keyframes vv-twinkle{0%,100%{opacity:.55}50%{opacity:.25}}
.vv-target{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;min-height:104px;padding:12px 8px;
border-radius:18px;font:inherit;color:var(--lfui-text);background:var(--lfui-raised);border:2px solid var(--lfui-border)}
.vv-target[aria-pressed="true"]{border-color:var(--lfui-accent);background:var(--lfui-accent-soft)}
.vv-input{box-sizing:border-box;width:100%;min-height:44px;padding:0 12px;border-radius:12px;font:inherit;font-size:14px;
color:var(--lfui-text);background:var(--lfui-sunken);border:1px solid var(--lfui-border)}
.vv-input::placeholder{color:var(--lfui-muted)}
.vv-swatch{width:32px;height:32px;border-radius:99px;cursor:pointer;border:2px solid transparent;box-shadow:inset 0 0 0 2px var(--lfui-surface)}
.vv-swatch[aria-checked="true"]{border-color:var(--lfui-text)}
.vv-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:8px}
.vv-scroll{max-height:260px;overflow-y:auto}
`;
