/**
 * `@lobbyforge/plugin-sdk/ui` — the activity UI kit.
 *
 * Wrap a panel in <ActivityShell>, then compose the rest:
 *
 *   <ActivityShell>
 *     <ActivityHeader glyph="Q" tone="accent" title="Quiz" status={<PhasePill>Question 4</PhasePill>}
 *       timer={<TimerRing seconds={12} total={20} label={t('quiz.timeLeft', { seconds: 12 })} />} />
 *     <Panel>…</Panel>
 *   </ActivityShell>
 *
 * Everything follows the host theme (dark, dim, light) with no work from the
 * plugin. Text is the plugin's to translate — the kit renders what it is given.
 */
export {
  ActivityHeader,
  ActivityShell,
  Avatar,
  Badge,
  Button,
  Callout,
  EmptyState,
  Grid,
  Panel,
  PhasePill,
  PlayerChip,
  ProgressBar,
  Row,
  Scoreboard,
  SectionLabel,
  SegmentedControl,
  Stack,
  Stat,
  TextField,
  TimerRing,
  VisuallyHidden,
  formatClock,
  initialsOf,
  visuallyHidden,
  type ActivityHeaderProps,
  type ActivityShellProps,
  type ButtonProps,
  type ButtonVariant,
  type PanelProps,
  type PlayerChipProps,
  type ProgressBarProps,
  type ScoreRow,
  type SegmentedOption,
  type TextFieldProps,
  type TimerRingProps,
} from './components.js';
export { AVATAR_TINTS, KIT_CSS, avatarTint, lf, tone, type Tone, type ToneColors } from './theme.js';
export { secondsUntil, useNow, useSecondsLeft } from './time.js';
