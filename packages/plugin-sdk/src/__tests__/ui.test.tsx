import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  ActivityHeader,
  ActivityShell,
  Button,
  PhasePill,
  PlayerChip,
  ProgressBar,
  Scoreboard,
  SegmentedControl,
  TextField,
  TimerRing,
  avatarTint,
  formatClock,
  initialsOf,
  secondsUntil,
  tone,
} from '../ui/index.js';

const html = (node: React.ReactNode) => renderToStaticMarkup(<>{node}</>);

describe('ActivityShell', () => {
  it('scopes the theme variables and brings the stylesheet', () => {
    const out = html(<ActivityShell>content</ActivityShell>);
    expect(out).toContain('class="lfui"');
    expect(out).toContain('--lfui-surface:var(--lf-surface');
    // Light theme swaps text shades so amber and green stay readable on white.
    expect(out).toContain('.lf-theme-light .lfui');
    expect(out).toContain('content');
  });
});

describe('controls', () => {
  it('renders real buttons, submit only when asked', () => {
    expect(html(<Button>Go</Button>)).toContain('type="button"');
    expect(html(<Button type="submit">Go</Button>)).toContain('type="submit"');
    expect(html(<Button disabled>Go</Button>)).toContain('disabled');
  });

  it('marks the chosen segment for assistive tech', () => {
    const out = html(
      <SegmentedControl
        label="Difficulty"
        value="medium"
        onChange={() => {}}
        options={[
          { value: 'easy', label: 'Easy' },
          { value: 'medium', label: 'Medium' },
        ]}
      />
    );
    expect(out).toContain('role="group"');
    expect(out).toContain('aria-label="Difficulty"');
    expect(out.match(/aria-pressed="true"/g)).toHaveLength(1);
  });
});

describe('TextField', () => {
  it('labels the input and ties hint and error to it', () => {
    const out = html(<TextField id="link" label="YouTube link" hint="Paste a video URL" error="Not a YouTube link" />);
    expect(out).toContain('<label for="link"');
    expect(out).toContain('aria-invalid="true"');
    expect(out).toContain('aria-describedby="link-hint link-error"');
    expect(out).toContain('id="link-error"');
  });

  it('keeps a hidden label for screen readers', () => {
    const out = html(<TextField id="msg" label="Whisper to your pack" hideLabel />);
    expect(out).toContain('Whisper to your pack');
    expect(out).toContain('clip:rect(0 0 0 0)');
  });
});

describe('time', () => {
  it('formats clocks and counts down to a shared deadline', () => {
    expect(formatClock(37)).toBe('0:37');
    expect(formatClock(65)).toBe('1:05');
    expect(formatClock(-3)).toBe('0:00');
    expect(secondsUntil(10_500, 1_000)).toBe(10);
    expect(secondsUntil(new Date(5_000).toISOString(), 9_000)).toBe(0);
    expect(secondsUntil(null, 0)).toBeNull();
    expect(secondsUntil('not a date', 0)).toBeNull();
  });

  it('gives the timer an accessible name and switches to minutes past one', () => {
    const short = html(<TimerRing seconds={12} total={30} label="12 seconds left" />);
    expect(short).toContain('role="timer"');
    expect(short).toContain('aria-label="12 seconds left"');
    expect(short).toContain('>12<');
    expect(html(<TimerRing seconds={75} total={90} label="x" />)).toContain('>1:15<');
  });

  it('reports progress as a percentage', () => {
    const out = html(<ProgressBar value={0.42} label="Time left" valueText="12 seconds" />);
    expect(out).toContain('aria-valuenow="42"');
    expect(out).toContain('aria-valuetext="12 seconds"');
  });
});

describe('people and status', () => {
  it('derives stable initials and tints', () => {
    expect(initialsOf('Kaya')).toBe('K');
    expect(initialsOf('ada lovelace')).toBe('AL');
    expect(initialsOf('  ')).toBe('?');
    expect(avatarTint('Kaya')).toBe(avatarTint('Kaya'));
  });

  it('renders a header with its status and timer', () => {
    const out = html(
      <ActivityHeader glyph="H" title="Hushle" subtitle="Main Lounge" status={<PhasePill live>Round 3</PhasePill>} timer={<TimerRing seconds={9} total={60} label="9 seconds left" />} />
    );
    expect(out).toContain('Hushle');
    expect(out).toContain('Round 3');
    expect(out).toContain('9 seconds left');
  });

  it('dims an eliminated player and ranks a scoreboard', () => {
    expect(html(<PlayerChip name="Nova" tag="Out" dimmed />)).toContain('line-through');
    const board = html(
      <Scoreboard label="Scores" rows={[{ id: 'a', name: 'Ice', score: 7, highlight: true }, { id: 'b', name: 'Amber', score: 5 }]} />
    );
    expect(board).toContain('<ol aria-label="Scores"');
    expect(board.indexOf('Ice')).toBeLessThan(board.indexOf('Amber'));
  });

  it('builds tone colours from the kit variables', () => {
    expect(tone('game')).toEqual({
      fill: 'var(--lfui-game)',
      onFill: 'var(--lfui-on-game)',
      text: 'var(--lfui-game-text)',
      soft: 'var(--lfui-game-soft)',
      line: 'var(--lfui-game-line)',
    });
    expect(tone('neutral').fill).toBe('var(--lfui-raised)');
  });
});
