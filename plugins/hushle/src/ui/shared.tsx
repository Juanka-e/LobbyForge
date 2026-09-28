'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { ActivityHeader, Row, lf } from '@lobbyforge/plugin-sdk/ui';
import type { HushleAction } from '../state';
import { useHushleI18n } from './i18n';
import { playerName } from './labels';
import type { HushleViewState, PanelPlayer } from './model';

/** What every phase view receives from the panel root. */
export interface ViewProps {
  state: HushleViewState;
  dispatch: (action: HushleAction) => void | Promise<void>;
  actorUserId: string;
  hostUserId: string | null;
  /** Everyone the panel can name: who is in the room now, and who was earlier. */
  players: PanelPlayer[];
  /** Who is in the room now — the people the host passes in `players`. */
  present: ReadonlySet<string>;
}

export function isHostViewer({ actorUserId, hostUserId }: Pick<ViewProps, 'actorUserId' | 'hostUserId'>): boolean {
  return hostUserId !== null && actorUserId === hostUserId;
}

/**
 * The panel's header, the same in every phase: the Hushle tile, who hosts,
 * the phase, the timer while a turn runs, and — always in this spot — the
 * host's controls for moving the game along.
 */
export function HushleHeader({
  hostUserId,
  players,
  detail,
  status,
  timer,
  actions,
}: {
  hostUserId: string | null;
  players: PanelPlayer[];
  /** Extra subtitle text after the host: "31 cards left". */
  detail?: string | null;
  status: ReactNode;
  timer?: ReactNode;
  actions?: ReactNode;
}) {
  const { t } = useHushleI18n();
  const parts = [
    hostUserId ? t('hushle.header.host', { name: playerName(players, hostUserId, t) }) : null,
    detail ?? null,
  ].filter((part): part is string => Boolean(part));
  return (
    <ActivityHeader
      glyph="H"
      tone="game"
      title={t('hushle.title')}
      subtitle={parts.length > 0 ? parts.join(' · ') : undefined}
      status={status}
      timer={timer}
      actions={
        actions ? (
          <Row gap={8} wrap justify="flex-end">
            {actions}
          </Row>
        ) : undefined
      }
    />
  );
}

/**
 * "(you)" after the viewer's own name, in a player chip's trailing slot —
 * said in words, not only by the chip's ring, and kept out of the name so
 * the avatar's initials stay the player's.
 */
export function YouMark() {
  const { t } = useHushleI18n();
  return <span style={{ fontSize: 12, color: lf.muted }}>{t('hushle.player.you')}</span>;
}

/**
 * A lock against double taps on a host button. Pressing locks the buttons
 * for the current `key` (a fingerprint of the card in play); the next state
 * brings a new key and unlocks them. If the action never lands — a network
 * error the panel cannot see — the lock lifts by itself after a few
 * seconds, so the host is never stuck.
 */
export function useTapLock(key: string, releaseMs = 4000): [boolean, () => void] {
  const [lockedKey, setLockedKey] = useState<string | null>(null);
  useEffect(() => {
    if (lockedKey === null) return undefined;
    const id = setTimeout(() => setLockedKey(null), releaseMs);
    return () => clearTimeout(id);
  }, [lockedKey, releaseMs]);
  return [lockedKey !== null && lockedKey === key, () => setLockedKey(key)];
}
