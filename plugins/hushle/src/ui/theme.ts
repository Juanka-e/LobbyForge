import type { Tone } from '@lobbyforge/plugin-sdk/ui';
import type { HushleDifficulty } from '../state';

/**
 * Hushle's own colours, on top of the UI kit's.
 *
 * Difficulty is Hushle's: easy is blue, medium purple, hard red (the M20
 * card spec), always paired with its name and a pip count so colour is
 * never the only cue. The kit's `--lfui-*` variables cover everything
 * else. `.lf-theme-light` (set on <html> by the host) swaps the TEXT
 * shades for ones that stay readable on white; fills keep their hue.
 */
export const HUSHLE_CSS = `
.hushle{
--hushle-easy:#6FA8FF;--hushle-easy-line:rgba(111,168,255,.55);--hushle-easy-text:#9CC2FF;
--hushle-medium:#A98BFF;--hushle-medium-line:rgba(169,139,255,.55);--hushle-medium-text:#C6B2FF;
--hushle-hard:#F07A7A;--hushle-hard-line:rgba(240,122,122,.55);--hushle-hard-text:#F6A5A5;
--hushle-pip-off:var(--lfui-border-strong);
--hushle-strike:rgba(242,160,160,.45);
}
.lf-theme-light .hushle{
--hushle-easy:#3B7BE0;--hushle-easy-line:rgba(59,123,224,.5);--hushle-easy-text:#1F56B3;
--hushle-medium:#7C5AE6;--hushle-medium-line:rgba(124,90,230,.5);--hushle-medium-text:#5B37C2;
--hushle-hard:#D9534F;--hushle-hard-line:rgba(217,83,79,.5);--hushle-hard-text:#B42318;
--hushle-strike:rgba(180,35,24,.45);
}
.hushle-card{container-type:inline-size}
.hushle-word{font-size:36px;font-size:clamp(28px,12cqi,46px);overflow-wrap:anywhere;hyphens:auto}
.hushle-id{user-select:all;-webkit-user-select:all}
`;

export interface DifficultyColours {
  /** The card's top bar and the filled pips. */
  bar: string;
  /** The card's border. */
  line: string;
  /** The difficulty name. */
  text: string;
  /** Filled pips out of three. */
  pips: 1 | 2 | 3;
}

/** Old sessions may carry a card without a known tier — they draw as easy. */
export function difficultyOf(value: unknown): HushleDifficulty {
  return value === 'medium' || value === 'hard' ? value : 'easy';
}

export function difficultyColours(level: HushleDifficulty): DifficultyColours {
  return {
    bar: `var(--hushle-${level})`,
    line: `var(--hushle-${level}-line)`,
    text: `var(--hushle-${level}-text)`,
    pips: level === 'hard' ? 3 : level === 'medium' ? 2 : 1,
  };
}

/** Team colours by seat: the first team is ice, the second amber, then green and red. */
const TEAM_TONES: Tone[] = ['info', 'game', 'success', 'danger'];

export function teamTone(index: number): Tone {
  return TEAM_TONES[((index % TEAM_TONES.length) + TEAM_TONES.length) % TEAM_TONES.length]!;
}

/**
 * The big word and the scores use the host's display face when it defines
 * `--font-display`; when it does not, the declaration drops out and the
 * text inherits the app's font.
 */
export const DISPLAY_FONT = 'var(--font-display)';
