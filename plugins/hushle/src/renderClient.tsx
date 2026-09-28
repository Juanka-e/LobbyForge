/**
 * Hushle renderClient — the React panel the activity host renders in a
 * voice room once an activity for the `hushle` plugin is active.
 *
 * The panel receives a `state` snapshot (the server-authoritative
 * reducer output, already projected for this viewer) and a `dispatch`
 * function that POSTs to the activity action route. It is purely a
 * presentational component: no HTTP, no DB — every action goes through
 * `dispatch`, and the host application is responsible for re-rendering
 * the panel with the next state once the dispatch round-trip completes.
 *
 * Built from the activity UI kit (`@lobbyforge/plugin-sdk/ui`); the phase
 * views live in `./ui/` — lobby, team setup, playing (a running turn and
 * the pause between turns) and the end screen.
 *
 * Locale strategy: the plugin ships its own `locales/*.json` tables,
 * registered through `@lobbyforge/plugin-sdk`, so it stays
 * self-contained and works in any host. The host tells it which
 * language to speak via `data-lf-locale`; see docs/TRANSLATING.md.
 */

'use client';

import { useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { detectLocale, loadPluginLocale, pickBestLocale } from '@lobbyforge/plugin-sdk';
import { ActivityShell } from '@lobbyforge/plugin-sdk/ui';
import { LOCALE_TABLES } from './locales.generated';
import { HUSHLE_PLUGIN_ID } from './plugin-id';
import type { HushleAction, HushleState } from './state';
import { EndedView } from './ui/ended';
import { HushleI18nProvider, createHushleI18n } from './ui/i18n';
import { LobbyView } from './ui/lobby';
import { EMPTY_TURN_LOG, advanceTurnLog, type HushleViewState, type PanelPlayer, type TurnLog } from './ui/model';
import { PlayingView } from './ui/playing';
import { TeamSetupView } from './ui/setup';
import type { ViewProps } from './ui/shared';
import { HUSHLE_CSS } from './ui/theme';

// Load the plugin's locale tables into the shared registry the
// moment the panel mounts. This is the one-line step that lets a
// community contributor add a new language: drop a new JSON file in
// `locales/`, run `pnpm i18n:sync`, and the panel + host language
// switcher pick it up automatically.
loadPluginLocale(HUSHLE_PLUGIN_ID, LOCALE_TABLES);

export interface HushlePanelCardPack {
  id: string;
  slug: string;
  name: string;
  /** Any language tag — hosts create packs in their own language. */
  language: string;
  cardCount: number;
  isBuiltIn: boolean;
}

export interface HushlePanelClientProps {
  state: HushleState;
  dispatch: (action: HushleAction) => void | Promise<void>;
  actorUserId: string;
  hostUserId: string | null;
  /** The people in the room — the voice channel and anyone who has acted — with their names. */
  players: Array<{ userId: string; name?: string | null }>;
  cardPacks?: HushlePanelCardPack[];
}

export type HushlePanelProps = HushlePanelClientProps;

export function HushlePanel(props: HushlePanelProps): ReactNode {
  const { dispatch, actorUserId, hostUserId, players, cardPacks } = props;
  // The projected state carries a few fields the reducer's type does not
  // (deckSize, cardsRemaining) — see HushleViewState.
  const state = props.state as HushleViewState;
  // Resolve the active locale against the plugin's actual locale list
  // so a user with `fr` falls back to the first available language
  // (en/tr) without showing raw keys.
  const locale = useMemo(
    () => pickBestLocale(HUSHLE_PLUGIN_ID, detectLocale('en')),
    // Re-run only on mount — the document lang doesn't change mid-session.
    []
  );
  const i18n = useMemo(() => createHushleI18n(locale), [locale]);
  const log = useTurnLog(state);
  const inRoom = players ?? [];
  const everyone = useRememberedPlayers(inRoom);
  const present = useMemo(() => new Set(inRoom.map((player) => player.userId)), [inRoom]);
  const view: ViewProps = { state, dispatch, actorUserId, hostUserId, players: everyone, present };

  return (
    <HushleI18nProvider value={i18n}>
      <ActivityShell className="hushle" data-phase={state.phase}>
        {/* React 19 hoists this into <head> once, like the kit's own sheet. */}
        <style href="hushle-ui-v1" precedence="hushle">
          {HUSHLE_CSS}
        </style>
        {state.phase === 'lobby' ? (
          <LobbyView {...view} cardPacks={cardPacks} />
        ) : state.phase === 'team_setup' ? (
          <TeamSetupView {...view} />
        ) : state.phase === 'playing' ? (
          <PlayingView {...view} log={log} />
        ) : (
          <EndedView {...view} />
        )}
      </ActivityShell>
    </HushleI18nProvider>
  );
}

/**
 * Everyone the panel has been given a name for this session. The host
 * passes the people in the room NOW; a player who steps out stays on their
 * team and keeps their name here instead of becoming "Unknown player".
 */
function useRememberedPlayers(players: PanelPlayer[]): PanelPlayer[] {
  const book = useRef(new Map<string, string>());
  for (const player of players) {
    const name = player.name?.trim();
    if (name) book.current.set(player.userId, name);
  }
  const here = new Set(players.map((player) => player.userId));
  const earlier = [...book.current]
    .filter(([userId]) => !here.has(userId))
    .map(([userId, name]) => ({ userId, name }));
  return earlier.length === 0 ? players : [...players, ...earlier];
}

/**
 * The "this turn" log, advanced once per new state snapshot. This is
 * React's pattern for state derived from the previous props: compare with
 * the snapshot stored alongside, and update during render.
 */
function useTurnLog(state: HushleViewState): TurnLog {
  const [track, setTrack] = useState(() => ({ state, log: advanceTurnLog(EMPTY_TURN_LOG, null, state) }));
  if (track.state !== state) {
    const next = { state, log: advanceTurnLog(track.log, track.state, state) };
    setTrack(next);
    return next.log;
  }
  return track.log;
}
