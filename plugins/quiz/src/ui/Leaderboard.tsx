'use client';

import type { ReactNode } from 'react';
import { Avatar, lf, tone } from '@lobbyforge/plugin-sdk/ui';
import type { RankedQuizPlayer } from '../roster';
import type { QuizUi } from './context';
import { MONO_FONT, SR_ONLY } from './palette';

/**
 * The leaderboard. Local rather than the kit's `Scoreboard`: ranks here are
 * shared on a tie (1, 2, 2, 4) and each row carries this round's gain.
 */
export function Leaderboard({
  ranked,
  ui,
  showGains = false,
  detail,
  label,
}: {
  ranked: RankedQuizPlayer[];
  ui: QuizUi;
  showGains?: boolean;
  /** An extra line under a name (the final screen's stats). */
  detail?: (entry: RankedQuizPlayer) => ReactNode;
  label: string;
}) {
  const { t } = ui;
  const accent = tone('accent');
  const success = tone('success');
  return (
    <ol aria-label={label} style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
      {ranked.map((entry) => {
        const { player, rank } = entry;
        const mine = player.id === ui.me;
        const name = ui.nameOf(player.id);
        const gain = showGains && player.lastGain > 0 ? player.lastGain : 0;
        return (
          <li
            key={player.id}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              padding: '10px 12px',
              borderRadius: 14,
              background: mine ? accent.soft : lf.raised,
              border: `1px solid ${mine ? accent.line : 'transparent'}`,
              opacity: player.active ? 1 : 0.7,
              minWidth: 0,
            }}
          >
            <span
              style={{ width: 24, flexShrink: 0, fontFamily: MONO_FONT, fontSize: 13, color: mine ? accent.text : lf.muted, fontVariantNumeric: 'tabular-nums' }}
            >
              <span style={SR_ONLY}>{t('quiz.leaderboard.rank', { rank })}</span>
              <span aria-hidden="true">{rank}</span>
            </span>
            <Avatar name={name} size={30} />
            <span style={{ flexGrow: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
              <span style={{ fontSize: 15, fontWeight: mine ? 600 : 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {name}
                {mine ? <span style={{ marginLeft: 8, fontSize: 11, fontWeight: 600, letterSpacing: '0.06em', color: accent.text }}>{t('quiz.player.youTag')}</span> : null}
                {player.active ? null : (
                  <span style={{ marginLeft: 8, fontSize: 11, fontWeight: 600, letterSpacing: '0.06em', color: lf.muted }}>{t('quiz.player.leftTag')}</span>
                )}
              </span>
              {detail ? <span style={{ fontSize: 12, color: lf.muted }}>{detail(entry)}</span> : null}
            </span>
            {gain > 0 ? (
              <span style={{ fontSize: 13, fontWeight: 600, color: success.text, whiteSpace: 'nowrap' }}>
                {t('quiz.leaderboard.gain', { points: ui.number(gain) })}
              </span>
            ) : null}
            <span style={{ fontFamily: MONO_FONT, fontSize: 15, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
              <span aria-hidden="true">{ui.number(player.score)}</span>
              <span style={SR_ONLY}>{t('quiz.leaderboard.points', { count: player.score })}</span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}
