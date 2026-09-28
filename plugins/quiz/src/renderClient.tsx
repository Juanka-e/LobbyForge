/**
 * Quiz renderClient — the panel the lobby mounts for a running `quiz`
 * activity.
 *
 * Presentational: it renders the PROJECTED state the host hands it (no
 * deck, nobody else's answers — see packages/core/src/activity-projection.ts)
 * and sends every intention through `dispatch`. No fetch, no storage.
 *
 * Layout follows the "Quiz · answering and reveal" artboard, built from the
 * activity UI kit so it follows the viewer's theme; the centre column is
 * 640–1200 px wide, so every row wraps.
 */

'use client';

import { useMemo } from 'react';
import type { ReactNode } from 'react';
import { detectLocale, loadPluginLocale, pickBestLocale, tFor } from '@lobbyforge/plugin-sdk';
import { ActivityHeader, ActivityShell, PhasePill, lf } from '@lobbyforge/plugin-sdk/ui';
import { LOCALE_TABLES } from './locales.generated';
import { findQuizPackSummary } from './packs';
import { QUIZ_PLUGIN_ID } from './plugin-id';
import { eligiblePlayers } from './roster';
import type { QuizClientAction, QuizViewState } from './state';
import type { QuizUi, Translate } from './ui/context';
import { FinalView } from './ui/FinalView';
import { resolvePlayerName, type SessionPlayer } from './ui/helpers';
import { LobbyView } from './ui/LobbyView';
import { QuestionView } from './ui/QuestionView';
import { RevealView } from './ui/RevealView';
import { toQuizView } from './view';

// Register the tables the moment the panel module loads (the plugin entry
// does too, but this is a 'use client' module the server never evaluates).
loadPluginLocale(QUIZ_PLUGIN_ID, LOCALE_TABLES);

export interface QuizPanelClientProps {
  /** The projected state for THIS viewer. */
  state: QuizViewState | Record<string, unknown>;
  dispatch: (action: QuizClientAction) => void | Promise<void>;
  actorUserId: string;
  hostUserId: string | null;
  players: SessionPlayer[];
  /** Hushle's word packs — the host passes them to every panel; Quiz ignores them. */
  cardPacks?: unknown;
}

export type QuizPanelProps = QuizPanelClientProps;

export function QuizPanel(props: QuizPanelClientProps): ReactNode {
  const { actorUserId, hostUserId, players: sessionPlayers } = props;
  const state = useMemo(() => toQuizView(props.state), [props.state]);
  const locale = useMemo(
    () => pickBestLocale(QUIZ_PLUGIN_ID, detectLocale('en')),
    // The page language does not change while a panel is mounted.
    []
  );
  const t: Translate = (key, params) => tFor(QUIZ_PLUGIN_ID, locale, key, params);

  const numberFormat = useMemo(() => {
    try {
      return new Intl.NumberFormat(locale);
    } catch {
      return new Intl.NumberFormat('en');
    }
  }, [locale]);

  const roster = state.players;
  const nameOf = (userId: string) =>
    resolvePlayerName(userId, sessionPlayers ?? [], roster, (number) =>
      number === null ? t('quiz.player.unknown') : t('quiz.player.fallback', { number })
    );
  const mePlayer = roster.find((player) => player.id === actorUserId) ?? null;

  const ui: QuizUi = {
    t,
    locale,
    number: (value) => numberFormat.format(value),
    nameOf,
    me: actorUserId,
    mePlayer,
    isHost: hostUserId !== null && hostUserId === actorUserId,
    hostId: hostUserId,
    hostName: hostUserId ? nameOf(hostUserId) : null,
    dispatch: (action) => {
      void props.dispatch(action);
    },
  };

  const pack = state.settings.source === 'pack' ? findQuizPackSummary(state.settings.packId, state.settings.packLanguage) : null;
  const packTitle = pack ? pack.title : state.settings.source === 'custom' && state.phase !== 'lobby' ? t('quiz.customTitle') : null;
  const number = (state.current?.index ?? state.currentIndex) + 1;
  const total = state.questionTotal;

  let pill: ReactNode;
  let side: ReactNode = null;
  if (state.phase === 'lobby') {
    // The player count lives in the lobby's player panel.
    pill = <PhasePill tone="neutral">{t('quiz.phase.lobby')}</PhasePill>;
  } else if (state.phase === 'playing') {
    pill = (
      <PhasePill tone="accent" live>
        {t('quiz.phase.question', { number, total })}
      </PhasePill>
    );
    const eligible = eligiblePlayers(roster, state.currentIndex).length;
    side = t('quiz.answeredCount', { answered: state.answeredCount, total: Math.max(eligible, state.answeredCount) });
  } else if (state.phase === 'reveal') {
    pill = <PhasePill tone="success">{t('quiz.phase.reveal', { number, total })}</PhasePill>;
  } else {
    pill = <PhasePill tone="game">{t('quiz.phase.ended')}</PhasePill>;
  }

  return (
    <ActivityShell role="region" aria-label={t('quiz.title')} style={{ position: 'relative' }}>
      <ActivityHeader
        glyph="Q"
        tone="accent"
        title={packTitle ? t('quiz.titleWithPack', { pack: packTitle }) : t('quiz.title')}
        subtitle={ui.hostName ? t('quiz.hostedBy', { name: ui.hostName }) : undefined}
        status={pill}
        actions={side ? <span style={{ fontSize: 14, color: lf.text2 }}>{side}</span> : null}
      />
      {state.phase === 'lobby' ? <LobbyView state={state} ui={ui} /> : null}
      {state.phase === 'playing' ? <QuestionView state={state} ui={ui} /> : null}
      {state.phase === 'reveal' ? <RevealView state={state} ui={ui} /> : null}
      {state.phase === 'ended' ? <FinalView state={state} ui={ui} /> : null}
    </ActivityShell>
  );
}
