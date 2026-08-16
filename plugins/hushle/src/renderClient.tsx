/**
 * Hushle renderClient — the React panel the activity host renders in a
 * voice room once an activity for the `hushle` plugin is active.
 *
 * The panel receives a `state` snapshot (the server-authoritative
 * reducer output) and a `dispatch` function that POSTs to the
 * activity action route. It is purely a presentational component:
 * no HTTP, no DB — every action goes through `dispatch`, and the
 * host application is responsible for re-rendering the panel with
 * the next state once the dispatch round-trip completes.
 *
 * Locale strategy: the plugin ships its own `locales/{en,tr}.json`
 * bundles and a tiny `t()` helper. We do not depend on
 * `@lobbyforge/i18n` so the plugin stays self-contained and the
 * host app does not have to register a namespace. A future
 * iteration can replace this with a call into `@lobbyforge/i18n`
 * if the host wants a single, app-wide translation table.
 */

'use client';

import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import {
  tFor as tForShared,
  pickBestLocale,
  detectLocale,
} from '@lobbyforge/plugin-sdk';
import en from '../locales/en.json';
import tr from '../locales/tr.json';
import { HUSHLE_PLUGIN_ID } from './plugin-id';
import type { HushleAction, HushleState, HushleTeam } from './state';

// Load the plugin's locale tables into the shared registry the
// moment the panel mounts. This is the one-line step that lets a
// community contributor add a new language: drop a new JSON file in
// `locales/`, add it to the map below, and the panel + host
// language switcher pick it up automatically.
import { loadPluginLocale } from '@lobbyforge/plugin-sdk';
loadPluginLocale(HUSHLE_PLUGIN_ID, { en, tr });

export interface HushlePanelCardPack {
  id: string;
  slug: string;
  name: string;
  language: 'en' | 'tr';
  cardCount: number;
  isBuiltIn: boolean;
}

export interface HushlePanelClientProps {
  state: HushleState;
  dispatch: (action: HushleAction) => void | Promise<void>;
  actorUserId: string;
  hostUserId: string | null;
  players: Array<{ userId: string; name?: string | null }>;
  cardPacks?: HushlePanelCardPack[];
}

export type HushlePanelProps = HushlePanelClientProps;

const localeTables: Record<string, Record<string, string>> = { en, tr };

function tFor(locale: string, key: string, params?: Record<string, string | number>): string {
  // Delegate to the shared SDK helper so the rest of the file is the
  // same as a community plugin would write. The `localeTables` map is
  // kept around so a future iteration can swap it for a remote
  // catalog without rewriting every call site.
  void localeTables;
  return tForShared(HUSHLE_PLUGIN_ID, locale, key, params);
}

function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

function remainingSeconds(state: HushleState, now: number): number {
  if (state.timer.paused || !state.timer.startedAt) {
    return state.timer.durationSeconds;
  }
  const start = Date.parse(state.timer.startedAt);
  if (Number.isNaN(start)) return state.timer.durationSeconds;
  const elapsed = (now - start) / 1000;
  return Math.max(0, Math.ceil(state.timer.durationSeconds - elapsed));
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function playerName(
  players: Array<{ userId: string; name?: string | null }>,
  userId: string | null
): string {
  if (!userId) return '—';
  const p = players.find((x) => x.userId === userId);
  return p?.name ?? userId.slice(0, 8);
}

const baseButtonStyle: React.CSSProperties = {
  padding: '6px 12px',
  background: '#1c2530',
  color: '#e6e8eb',
  border: '1px solid #2a3140',
  borderRadius: 4,
  fontSize: 13,
  cursor: 'pointer',
};

const primaryButtonStyle: React.CSSProperties = {
  ...baseButtonStyle,
  background: '#2f8f62',
  borderColor: '#246f4d',
  color: '#fff',
};

const dangerButtonStyle: React.CSSProperties = {
  ...baseButtonStyle,
  background: '#7a2a2a',
  borderColor: '#5a1f1f',
  color: '#fff',
};

const inputStyle: React.CSSProperties = {
  padding: '6px 8px',
  background: '#0e1218',
  color: '#e6e8eb',
  border: '1px solid #2a3140',
  borderRadius: 4,
  fontSize: 13,
};

const labelStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
  fontSize: 12,
  color: '#9aa3ad',
};

const cardStyle: React.CSSProperties = {
  background: '#0e1218',
  border: '1px solid #2a3140',
  borderRadius: 8,
  padding: 16,
  minWidth: 240,
};

export function HushlePanel(props: HushlePanelProps): ReactNode {
  const { state, dispatch, actorUserId, hostUserId, players, cardPacks } = props;
  const isHost = hostUserId !== null && actorUserId === hostUserId;
  // Resolve the active locale against the plugin's actual locale list
  // so a user with `fr` falls back to the first available language
  // (en/tr) without showing raw keys.
  const locale = useMemo(
    () => pickBestLocale(HUSHLE_PLUGIN_ID, detectLocale('en')),
    // Re-run only on mount — the document lang doesn't change mid-session.
    []
  );
  const t = (key: string, params?: Record<string, string | number>) => tFor(locale, key, params);
  const now = useNow(500);

  if (state.phase === 'lobby') {
    return (
      <LobbyView
        isHost={isHost}
        dispatch={dispatch}
        actorUserId={actorUserId}
        cardPacks={cardPacks}
        t={t}
      />
    );
  }
  if (state.phase === 'team_setup') {
    return (
      <TeamSetupView
        isHost={isHost}
        state={state}
        dispatch={dispatch}
        actorUserId={actorUserId}
        players={players}
        t={t}
      />
    );
  }
  if (state.phase === 'playing') {
    return (
      <PlayingView
        isHost={isHost}
        state={state}
        dispatch={dispatch}
        actorUserId={actorUserId}
        players={players}
        t={t}
        now={now}
      />
    );
  }
  return (
    <EndedView
      isHost={isHost}
      state={state}
      dispatch={dispatch}
      actorUserId={actorUserId}
      t={t}
    />
  );
}

function LobbyView({
  isHost,
  dispatch,
  actorUserId,
  cardPacks,
  t,
}: {
  isHost: boolean;
  dispatch: HushlePanelClientProps['dispatch'];
  actorUserId: string;
  cardPacks?: HushlePanelCardPack[];
  t: (key: string, params?: Record<string, string | number>) => string;
}): ReactNode {
  // Prefer the host's card-pack list (DB-backed, includes community packs).
  // Fall back to the legacy language dropdown if no packs are available.
  const hasPacks = Array.isArray(cardPacks) && cardPacks.length > 0;
  const defaultPackSlug = hasPacks ? cardPacks![0]!.slug : 'hushle-en-basic';
  const [packSlug, setPackSlug] = useState<string>(defaultPackSlug);
  const [turnDuration, setTurnDuration] = useState(60);
  const startGame = () => {
    const selected = hasPacks ? cardPacks!.find((p) => p.slug === packSlug) : null;
    const language = selected?.language ?? (packSlug === 'hushle-tr-basic' ? 'tr' : 'en');
    void dispatch({
      type: 'start-game',
      packId: packSlug,
      language,
      turnDurationSeconds: turnDuration,
      createdBy: actorUserId,
    });
  };
  return (
    <div style={{ ...cardStyle, maxWidth: 480 }}>
      <h3 style={{ margin: '0 0 8px 0' }}>
        {t('hushle.title')} — {t('hushle.phase.lobby')}
      </h3>
      <p style={{ color: '#9aa3ad', fontSize: 13, margin: '0 0 12px 0' }}>{t('hushle.tagline')}</p>
      {isHost ? (
        <>
          <p style={{ fontSize: 13, margin: '0 0 12px 0' }}>{t('hushle.lobby.hostPrompt')}</p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 12 }}>
            {hasPacks ? (
              <label style={labelStyle}>
                {t('hushle.lobby.packLabel')}
                <select
                  value={packSlug}
                  onChange={(e) => setPackSlug(e.target.value)}
                  style={inputStyle}
                >
                  {cardPacks!.map((pack) => (
                    <option key={pack.id} value={pack.slug}>
                      {pack.name} ({pack.cardCount})
                    </option>
                  ))}
                </select>
              </label>
            ) : (
              <label style={labelStyle}>
                {t('hushle.lobby.language')}
                <select
                  value={packSlug === 'hushle-tr-basic' ? 'tr' : 'en'}
                  onChange={(e) =>
                    setPackSlug(e.target.value === 'tr' ? 'hushle-tr-basic' : 'hushle-en-basic')
                  }
                  style={inputStyle}
                >
                  <option value="en">English</option>
                  <option value="tr">Türkçe</option>
                </select>
              </label>
            )}
            <label style={labelStyle}>
              {t('hushle.lobby.turnDuration')}
              <input
                type="number"
                min={15}
                max={300}
                value={turnDuration}
                onChange={(e) => setTurnDuration(Math.max(15, Math.min(300, Number(e.target.value) || 60)))}
                style={inputStyle}
              />
            </label>
          </div>
          <button
            type="button"
            style={primaryButtonStyle}
            onClick={startGame}
          >
            {t('hushle.lobby.startButton')}
          </button>
        </>
      ) : (
        <p style={{ fontSize: 13, margin: 0 }}>{t('hushle.lobby.waitingForHost')}</p>
      )}
    </div>
  );
}

function TeamSetupView({
  isHost,
  state,
  dispatch,
  players,
  t,
}: {
  isHost: boolean;
  state: HushleState;
  dispatch: HushlePanelClientProps['dispatch'];
  actorUserId: string;
  players: Array<{ userId: string; name?: string | null }>;
  t: (key: string, params?: Record<string, string | number>) => string;
}): ReactNode {
  const [name, setName] = useState('');
  const [ids, setIds] = useState('');

  const addTeam = () => {
    if (!name.trim()) return;
    const playerIds = ids
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    void dispatch({
      type: 'set-teams',
      teams: [
        ...state.teams.map((t2) => ({ name: t2.name, playerIds: t2.playerIds })),
        { name: name.trim(), playerIds },
      ],
    });
    setName('');
    setIds('');
  };

  const removeTeam = (idx: number) => {
    void dispatch({
      type: 'set-teams',
      teams: state.teams
        .filter((_, i) => i !== idx)
        .map((t2) => ({ name: t2.name, playerIds: t2.playerIds })),
    });
  };

  const firstTeam = state.teams[0] ?? null;
  const canStart = firstTeam !== null;

  return (
    <div style={{ ...cardStyle, maxWidth: 560 }}>
      <h3 style={{ margin: '0 0 8px 0' }}>
        {t('hushle.title')} — {t('hushle.phase.team_setup')}
      </h3>
      {isHost ? (
        <p style={{ fontSize: 13, margin: '0 0 12px 0' }}>{t('hushle.teamSetup.hostPrompt')}</p>
      ) : null}
      {state.teams.length === 0 ? (
        <p style={{ color: '#9aa3ad', fontSize: 13 }}>{t('hushle.teamSetup.emptyTeams')}</p>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0, margin: '0 0 12px 0' }}>
          {state.teams.map((team, idx) => (
            <li
              key={team.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                background: '#11151b',
                border: '1px solid #1f242c',
                borderRadius: 4,
                padding: '6px 10px',
                marginBottom: 4,
                fontSize: 13,
              }}
            >
              <span>
                <strong>{team.name}</strong> — {team.playerIds.length} oyuncu
                {team.playerIds.length > 0 ? `: ${team.playerIds.map((id) => playerName(players, id)).join(', ')}` : ''}
              </span>
              {isHost ? (
                <button
                  type="button"
                  onClick={() => removeTeam(idx)}
                  style={{ ...baseButtonStyle, fontSize: 12, padding: '2px 8px' }}
                >
                  ×
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {isHost ? (
        <>
          <div style={{ display: 'flex', gap: 8, marginBottom: 12, alignItems: 'flex-end' }}>
            <label style={{ ...labelStyle, flex: 1 }}>
              {t('hushle.teamSetup.teamName')}
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                style={inputStyle}
                placeholder="Takım A"
              />
            </label>
            <label style={{ ...labelStyle, flex: 2 }}>
              {t('hushle.teamSetup.playerIds')}
              <input
                value={ids}
                onChange={(e) => setIds(e.target.value)}
                style={inputStyle}
                placeholder="u-1, u-2"
              />
            </label>
            <button
              type="button"
              style={primaryButtonStyle}
              onClick={addTeam}
              disabled={!name.trim()}
            >
              {t('hushle.teamSetup.addTeam')}
            </button>
          </div>
          <button
            type="button"
            style={canStart ? primaryButtonStyle : { ...baseButtonStyle, opacity: 0.5 }}
            disabled={!canStart}
            onClick={() => {
              if (!firstTeam) return;
              void dispatch({
                type: 'start-turn',
                teamId: firstTeam.id,
                explainerId: firstTeam.playerIds[0] ?? null,
              });
            }}
          >
            {canStart
              ? t('hushle.teamSetup.startTurn')
              : t('hushle.teamSetup.startTurnMissing')}
          </button>
        </>
      ) : null}
    </div>
  );
}

function PlayingView({
  isHost,
  state,
  dispatch,
  actorUserId,
  players,
  t,
  now,
}: {
  isHost: boolean;
  state: HushleState;
  dispatch: HushlePanelClientProps['dispatch'];
  actorUserId: string;
  players: Array<{ userId: string; name?: string | null }>;
  t: (key: string, params?: Record<string, string | number>) => string;
  now: number;
}): ReactNode {
  const isExplainer = state.currentExplainerId === actorUserId;
  const remaining = remainingSeconds(state, now);
  const currentTeam = state.teams.find((tm) => tm.id === state.currentTeamId) ?? null;
  const explainerName = state.currentExplainerId
    ? playerName(players, state.currentExplainerId)
    : null;
  // Classic Taboo roles: the viewer is either the explainer, a GUESSER
  // (same team as the explainer — must NOT see the card) or an OPPONENT
  // (another team — watches the card and can BUST forbidden words). The
  // server projection already nulls currentCard for guessers; the
  // viewerTeam math below drives the role line and the BUST button.
  const viewerTeam = state.teams.find((tm) => tm.playerIds.includes(actorUserId)) ?? null;
  const isOpponent =
    Boolean(viewerTeam && state.currentTeamId && viewerTeam.id !== state.currentTeamId) &&
    !isExplainer;

  const card = state.currentCard;

  const bustButton = useMemo(() => {
    if (!isOpponent || !card) return null;
    return (
      <button
        type="button"
        style={{ ...dangerButtonStyle, fontSize: 15, padding: '10px 16px' }}
        onClick={() => {
          void dispatch({ type: 'bust-forbidden' });
        }}
      >
        ⛔ {t('hushle.playing.bust')}
      </button>
    );
  }, [isOpponent, card, dispatch, t]);

  const buttons = useMemo(() => {
    if (!isHost) return null;
    return (
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button
          type="button"
          style={primaryButtonStyle}
          onClick={() => {
            void dispatch({ type: 'correct-guess' });
          }}
        >
          {t('hushle.playing.correct')}
        </button>
        <button
          type="button"
          style={baseButtonStyle}
          onClick={() => {
            void dispatch({ type: 'pass' });
          }}
        >
          {t('hushle.playing.pass')}
        </button>
        <button
          type="button"
          style={dangerButtonStyle}
          onClick={() => {
            void dispatch({ type: 'penalty' });
          }}
        >
          {t('hushle.playing.penalty')}
        </button>
        <button
          type="button"
          style={baseButtonStyle}
          onClick={() => {
            void dispatch({ type: 'next-card' });
          }}
        >
          {t('hushle.playing.nextCard')}
        </button>
        <button
          type="button"
          style={baseButtonStyle}
          onClick={() => {
            void dispatch({ type: 'end-turn' });
          }}
        >
          {t('hushle.playing.endTurn')}
        </button>
        <button
          type="button"
          style={dangerButtonStyle}
          onClick={() => {
            void dispatch({ type: 'end-game' });
          }}
        >
          {t('hushle.playing.endGame')}
        </button>
      </div>
    );
  }, [isHost, dispatch, t]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 640 }}>
      <div style={cardStyle}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginBottom: 8,
          }}
        >
          <strong>
            {currentTeam ? t('hushle.playing.currentTeam', { name: currentTeam.name }) : t('hushle.title')}
          </strong>
          <span style={{ fontSize: 13, color: remaining <= 10 ? '#e36049' : '#9aa3ad' }}>
            {t('hushle.playing.timer')}: {formatTime(remaining)}
          </span>
        </div>
        <p style={{ margin: '0 0 8px 0', fontSize: 13, color: '#9aa3ad' }}>
          {explainerName
            ? t('hushle.playing.explainer', { name: explainerName })
            : t('hushle.playing.noExplainer')}
          {' · '}
          {isExplainer
            ? t('hushle.playing.youAreExplainer')
            : isOpponent
              ? t('hushle.playing.youAreOpponent')
              : t('hushle.playing.youAreGuesser')}
        </p>
        <p style={{ fontSize: 12, color: '#9aa3ad', margin: 0 }}>
          {t('hushle.playing.cardsPlayed', {
            count: state.totalCardsPlayed,
            max: state.settings.cardsPerTurn * Math.max(1, state.teams.length),
          })}
        </p>
      </div>

      {card ? (
        // The card is present only for the explainer and opposing-team
        // players (server projection nulls it for guessers). Opponents
        // additionally get the hint + BUST button rendered above/below.
        <div style={{ ...cardStyle, background: '#11151b' }}>
          <p style={{ margin: '0 0 6px 0', fontSize: 12, color: '#9aa3ad' }}>
            {t('hushle.playing.word')}
          </p>
          <p
            style={{
              margin: '0 0 12px 0',
              fontSize: 32,
              fontWeight: 700,
              letterSpacing: 1,
              color: '#e6e8eb',
            }}
          >
            {card.word}
          </p>
          <p style={{ margin: '0 0 4px 0', fontSize: 12, color: '#9aa3ad' }}>
            {t('hushle.playing.forbiddenWords')}
          </p>
          <ul
            style={{
              margin: 0,
              paddingLeft: 18,
              fontSize: 14,
              color: '#e36049',
            }}
          >
            {card.forbiddenWords.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
          {isOpponent ? (
            <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
              <p style={{ margin: 0, fontSize: 12, color: '#9aa3ad' }}>
                {t('hushle.playing.opponentHint')}
              </p>
              {bustButton}
            </div>
          ) : null}
        </div>
      ) : isExplainer ? (
        <div
          style={{
            ...cardStyle,
            background: '#11151b',
            fontSize: 14,
            color: '#9aa3ad',
          }}
        >
          {t('hushle.playing.noCard')}
        </div>
      ) : (
        <div
          style={{
            ...cardStyle,
            background: '#11151b',
            fontSize: 14,
            color: '#9aa3ad',
          }}
        >
          {t('hushle.playing.youAreGuesser')} — {t('hushle.playing.hideFromGuessers')}
        </div>
      )}

      <div style={cardStyle}>
        <p style={{ margin: '0 0 6px 0', fontSize: 12, color: '#9aa3ad' }}>
          {t('hushle.playing.scores')}
        </p>
        <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
          {state.teams.map((team: HushleTeam) => (
            <li
              key={team.id}
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                padding: '4px 0',
                fontSize: 14,
                color: team.id === state.currentTeamId ? '#5ad48a' : '#e6e8eb',
              }}
            >
              <span>
                {team.name}
                {team.id === state.currentTeamId ? ' ★' : ''}
              </span>
              <span>
                {team.score} ({team.correctCount}/{team.passCount}/{team.penaltyCount})
              </span>
            </li>
          ))}
        </ul>
      </div>

      {buttons}
    </div>
  );
}

function EndedView({
  isHost,
  state,
  dispatch,
  actorUserId,
  t,
}: {
  isHost: boolean;
  state: HushleState;
  dispatch: HushlePanelClientProps['dispatch'];
  actorUserId: string;
  t: (key: string, params?: Record<string, string | number>) => string;
}): ReactNode {
  const sorted = [...state.teams].sort((a, b) => b.score - a.score);
  return (
    <div style={{ ...cardStyle, maxWidth: 480 }}>
      <h3 style={{ margin: '0 0 8px 0' }}>{t('hushle.ended.title')}</h3>
      <p style={{ margin: '0 0 12px 0', fontSize: 12, color: '#9aa3ad' }}>
        {t('hushle.ended.finalScores')}
      </p>
      <ul style={{ listStyle: 'none', padding: 0, margin: '0 0 12px 0' }}>
        {sorted.map((team, idx) => (
          <li
            key={team.id}
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              padding: '6px 0',
              borderBottom: '1px solid #1f242c',
              fontSize: 14,
            }}
          >
            <span>
              {idx + 1}. {team.name}
            </span>
            <span>{team.score}</span>
          </li>
        ))}
      </ul>
      {isHost ? (
        <button
          type="button"
          style={primaryButtonStyle}
          onClick={() => {
            const packId = state.settings.packId ?? 'hushle-en-basic';
            void dispatch({
              type: 'start-game',
              packId,
              language: state.settings.language,
              createdBy: actorUserId,
            });
          }}
        >
          {t('hushle.ended.newGame')}
        </button>
      ) : null}
    </div>
  );
}
