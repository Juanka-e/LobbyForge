'use client';

import { useId, useState } from 'react';
import {
  Button,
  Callout,
  Grid,
  Panel,
  PhasePill,
  Row,
  SectionLabel,
  SegmentedControl,
  Stack,
  TimerRing,
  lf,
  tone,
  useSecondsLeft,
  type Tone,
} from '@lobbyforge/plugin-sdk/ui';
import type { HushleAction, HushleTeam } from '../state';
import { CardFace, HiddenCard } from './card';
import { listOf, useHushleI18n } from './i18n';
import { outcomeName, playerName, roleLine } from './labels';
import {
  explainerCandidates,
  isTurnRunning,
  nextTurnPreview,
  playRole,
  teamById,
  turnDeadline,
  turnNumber,
  type HushleViewState,
  type PlayRole,
  type TurnLog,
  type TurnLogEntry,
} from './model';
import { EyeIcon, Field, ListenIcon, VisuallyHidden } from './parts';
import { TeamBoard } from './scoreboard';
import { HushleHeader, isHostViewer, useTapLock, type ViewProps } from './shared';

/**
 * The game in progress: a running turn, or the pause between two turns
 * once a team has played its cards.
 *
 * Who sees the card is decided on the server — `currentCard` arrives only
 * for the explainer and the OTHER teams. The panel shows what it is given
 * and words each viewer's job accordingly.
 */
export function PlayingView({ log, ...props }: ViewProps & { log: TurnLog }) {
  const { t } = useHushleI18n();
  const { state, dispatch, players, actorUserId, hostUserId } = props;
  const isHost = isHostViewer(props);
  const running = isTurnRunning(state);
  const secondsLeft = useSecondsLeft(running ? turnDeadline(state.timer) : null);
  // One clock per turn. When it runs out the turn's scoring is over — the
  // reducer refuses more cards — so the panel treats the turn as done and
  // offers the next one.
  const timeUp = running && secondsLeft === 0;
  const live = running && !timeUp;
  const duration = Math.max(0, state.timer.durationSeconds);
  const shownSeconds = live ? (secondsLeft ?? duration) : null;
  const cardsLeft = typeof state.cardsRemaining === 'number' ? state.cardsRemaining : null;
  const deckEmpty = cardsLeft === 0;

  // One lock for every host button that moves the card on: a double tap
  // must not score twice or skip two cards. The fingerprint changes with
  // each card, which releases it.
  const cardKey = `${state.totalCardsPlayed}:${state.cardsPlayedThisTurn}:${state.timer.startedAt ?? ''}`;
  const [hostLocked, lockHost] = useTapLock(cardKey);
  const hostAct = (action: HushleAction) => {
    lockHost();
    void dispatch(action);
  };

  return (
    <>
      <HushleHeader
        hostUserId={hostUserId}
        players={players}
        detail={cardsLeft !== null ? t('hushle.header.cardsLeft', { count: cardsLeft }) : null}
        status={
          live ? (
            <PhasePill tone="game" live>
              {t('hushle.phase.turn', { number: turnNumber(state) })}
            </PhasePill>
          ) : timeUp ? (
            <PhasePill tone="danger">{t('hushle.phase.timeUp')}</PhasePill>
          ) : (
            <PhasePill tone="info">{t('hushle.phase.turnOver')}</PhasePill>
          )
        }
        timer={
          shownSeconds !== null ? (
            <TimerRing
              seconds={shownSeconds}
              total={duration}
              label={t('hushle.playing.secondsLeft', { count: shownSeconds })}
            />
          ) : null
        }
        actions={
          isHost ? (
            <>
              {live ? (
                <Button variant="secondary" onClick={() => void dispatch({ type: 'end-turn' })}>
                  {t('hushle.playing.endTurn')}
                </Button>
              ) : (
                <Button variant="primary" disabled={deckEmpty} onClick={() => void dispatch({ type: 'end-turn' })}>
                  {t('hushle.host.nextTurn')}
                </Button>
              )}
              <Button variant="danger" onClick={() => void dispatch({ type: 'end-game' })}>
                {t('hushle.playing.endGame')}
              </Button>
            </>
          ) : null
        }
      />

      <Grid min={340} gap={18}>
        {live ? (
          <TurnColumn {...props} isHost={isHost} deckEmpty={deckEmpty} hostLocked={hostLocked} hostAct={hostAct} />
        ) : (
          <BetweenTurns {...props} isHost={isHost} deckEmpty={deckEmpty} timeUp={timeUp} />
        )}
        <Stack gap={18}>
          <TeamBoard state={state} players={players} actorUserId={actorUserId} hostUserId={hostUserId} showRoles={live} />
          {live ? <WhoSeesWhat {...props} /> : null}
          <ThisTurn state={state} log={log} running={live} />
          {isHost && live ? <HostTools {...props} hostLocked={hostLocked} hostAct={hostAct} /> : null}
        </Stack>
      </Grid>
    </>
  );
}

function TurnColumn({
  state,
  players,
  actorUserId,
  dispatch,
  isHost,
  deckEmpty,
  hostLocked,
  hostAct,
}: ViewProps & {
  isHost: boolean;
  deckEmpty: boolean;
  hostLocked: boolean;
  hostAct: (action: HushleAction) => void;
}) {
  const { t } = useHushleI18n();
  const role = playRole(state, actorUserId);
  const card = state.currentCard;
  const currentTeam = teamById(state, state.currentTeamId);
  const explainerName = state.currentExplainerId ? playerName(players, state.currentExplainerId, t) : null;
  const bustHintId = useId();

  // Double-click guard (client side of LF-002): after pressing BUST the
  // button stays disabled until a DIFFERENT card arrives (the bust always
  // rotates the card), so a jittery tap can't score -1 twice. The server
  // additionally dedups by actionId for transport-level retries.
  const [bustedCardId, setBustedCardId] = useState<string | null>(null);
  const bustDisabled = card !== null && bustedCardId === card.id;
  // The other team watches the card and busts. A host sitting on that team
  // gets BUST instead of the host's Penalty — both cost the explaining team
  // a point and draw the next card, and two red buttons doing the same
  // thing would only make the host hesitate.
  const canBust = role === 'opponent' && card !== null;

  return (
    <Panel padding={22} radius={24} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <Row justify="space-between" gap={12} wrap style={{ fontSize: 13, color: lf.text2 }}>
        <span>{roleLine(role, isHost, t)}</span>
        {currentTeam ? <span style={{ overflowWrap: 'anywhere' }}>{currentTeam.name}</span> : null}
      </Row>

      {card ? (
        <CardFace key={card.id} card={card} />
      ) : (
        <CardPlaceholder role={role} isHost={isHost} explainerName={explainerName} deckEmpty={deckEmpty} />
      )}

      {isHost ? (
        <Stack gap={10}>
          <Grid min={140} gap={12}>
            <Button variant="success" size="lg" disabled={hostLocked} onClick={() => hostAct({ type: 'correct-guess' })}>
              {t('hushle.playing.correct')}
            </Button>
            <Button variant="secondary" size="lg" disabled={hostLocked} onClick={() => hostAct({ type: 'pass' })}>
              {t('hushle.playing.pass')}
            </Button>
          </Grid>
          {canBust ? null : (
            <Button variant="danger" block disabled={hostLocked} onClick={() => hostAct({ type: 'penalty' })}>
              {t('hushle.playing.penalty')}
            </Button>
          )}
        </Stack>
      ) : null}

      {canBust && card ? (
        <Stack gap={8}>
          <span id={bustHintId} style={{ fontSize: 14, lineHeight: 1.5, color: lf.text2 }}>
            {t('hushle.playing.opponentHint')}
          </span>
          <Button
            variant="danger"
            size="lg"
            block
            aria-describedby={bustHintId}
            disabled={bustDisabled}
            style={{ fontWeight: 700, letterSpacing: '0.06em' }}
            onClick={() => {
              setBustedCardId(card.id);
              void dispatch({ type: 'bust-forbidden' });
            }}
          >
            {t('hushle.playing.bust')}
          </Button>
        </Stack>
      ) : null}

      {role === 'explainer' && !isHost ? <Callout tone="info">{t('hushle.playing.explainerHint')}</Callout> : null}
    </Panel>
  );
}

/** What sits in the card's place when this viewer gets no card. */
function CardPlaceholder({
  role,
  isHost,
  explainerName,
  deckEmpty,
}: {
  role: PlayRole;
  isHost: boolean;
  explainerName: string | null;
  deckEmpty: boolean;
}) {
  const { t } = useHushleI18n();
  if (role === 'explainer' || role === 'opponent') {
    // Entitled to the card, but there is none in play.
    return (
      <HiddenCard
        icon={<EyeIcon />}
        title={deckEmpty ? t('hushle.hidden.deckEmpty') : t('hushle.playing.noCard')}
        body={deckEmpty && isHost ? t('hushle.hidden.deckEmptyHost') : undefined}
      />
    );
  }
  if (!explainerName) {
    return (
      <HiddenCard
        icon={<EyeIcon />}
        title={t('hushle.playing.noExplainer')}
        body={isHost ? t('hushle.hidden.pickExplainer') : undefined}
      />
    );
  }
  if (role === 'guesser') {
    return (
      <HiddenCard
        icon={<ListenIcon />}
        title={t('hushle.hidden.listen', { name: explainerName })}
        body={t('hushle.hidden.guesserBody')}
      />
    );
  }
  return (
    <HiddenCard
      icon={<EyeIcon />}
      title={t('hushle.hidden.watching', { name: explainerName })}
      body={t('hushle.hidden.watcherBody')}
    />
  );
}

/**
 * Between two turns — the team played its cards, or its time ran out: who
 * goes next, and (for the host) the way on.
 */
function BetweenTurns({
  state,
  players,
  isHost,
  deckEmpty,
  timeUp,
}: ViewProps & { isHost: boolean; deckEmpty: boolean; timeUp: boolean }) {
  const { t } = useHushleI18n();
  const next = nextTurnPreview(state);
  const nextExplainer = next?.explainerId ? playerName(players, next.explainerId, t) : null;
  return (
    <Panel padding={22} radius={24} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <SectionLabel>{timeUp ? t('hushle.phase.timeUp') : t('hushle.phase.turnOver')}</SectionLabel>
      {deckEmpty ? (
        <HiddenCard
          icon={<EyeIcon />}
          title={t('hushle.hidden.deckEmpty')}
          body={isHost ? t('hushle.hidden.deckEmptyHost') : t('hushle.between.deckEmptyWaiting')}
        />
      ) : next ? (
        <HiddenCard
          icon={<ListenIcon />}
          title={t('hushle.between.nextTeam', { team: next.team.name })}
          body={nextExplainer ? t('hushle.between.nextExplainer', { name: nextExplainer }) : undefined}
        />
      ) : null}
      {!deckEmpty ? (
        isHost ? (
          <span style={{ fontSize: 14, lineHeight: 1.5, color: lf.text2 }}>{t('hushle.between.hostHint')}</span>
        ) : (
          <Callout role="status">{t('hushle.between.waiting')}</Callout>
        )
      ) : null}
    </Panel>
  );
}

/** Who sees the card this turn — the rule every player needs to hand. */
function WhoSeesWhat({ state, players }: ViewProps) {
  const { t, locale } = useHushleI18n();
  const current = teamById(state, state.currentTeamId);
  if (!current || !state.currentExplainerId) return null;
  const name = playerName(players, state.currentExplainerId, t);
  const others = state.teams.filter((team: HushleTeam) => team.id !== current.id);
  return (
    <Panel>
      <Stack gap={14}>
        <SectionLabel>{t('hushle.roles.title')}</SectionLabel>
        <Grid min={200} gap={14}>
          <Panel variant="raised" padding={16} radius={16}>
            <Stack gap={8}>
              <span style={{ fontSize: 14, fontWeight: 600, overflowWrap: 'anywhere' }}>
                {t('hushle.roles.guessersTitle', { team: current.name })}
              </span>
              <span style={{ fontSize: 14, lineHeight: 1.5, color: lf.text2 }}>{t('hushle.roles.guessersBody', { name })}</span>
            </Stack>
          </Panel>
          {others.length > 0 ? (
            <Panel variant="raised" padding={16} radius={16}>
              <Stack gap={8}>
                <span style={{ fontSize: 14, fontWeight: 600, overflowWrap: 'anywhere' }}>
                  {t('hushle.roles.watchersTitle', {
                    teams: listOf(
                      others.map((team) => team.name),
                      locale
                    ),
                    count: others.length,
                  })}
                </span>
                <span style={{ fontSize: 14, lineHeight: 1.5, color: lf.text2 }}>{t('hushle.roles.watchersBody', { name })}</span>
              </Stack>
            </Panel>
          ) : null}
        </Grid>
      </Stack>
    </Panel>
  );
}

const OUTCOME_TONES: Record<TurnLogEntry['outcome'], Tone> = {
  correct: 'success',
  pass: 'neutral',
  penalty: 'danger',
  next: 'neutral',
};

/** The cards of this turn (or the one that just ended) and what became of each. */
function ThisTurn({ state, log, running }: { state: HushleViewState; log: TurnLog; running: boolean }) {
  const { t } = useHushleI18n();
  const entries = log.entries;
  if (!running && entries.length === 0) return null;
  const total = Math.max(1, state.settings.cardsPerTurn);
  const current = Math.min(state.cardsPlayedThisTurn + 1, total);
  const last = entries[entries.length - 1];
  return (
    <Panel padding="18px 20px" radius={22}>
      <Stack gap={10}>
        <Row justify="space-between" gap={12} wrap>
          <SectionLabel>{running ? t('hushle.turn.title') : t('hushle.turn.lastTitle')}</SectionLabel>
          {running ? (
            <span style={{ fontSize: 13, color: lf.text2 }}>{t('hushle.turn.progress', { current, total })}</span>
          ) : null}
        </Row>
        {entries.length > 0 ? (
          <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {entries.map((entry) => {
              const colours = tone(OUTCOME_TONES[entry.outcome]);
              return (
                <li
                  key={entry.key}
                  style={{
                    minHeight: 30,
                    boxSizing: 'border-box',
                    padding: '4px 12px',
                    borderRadius: 99,
                    background: colours.soft,
                    color: colours.text,
                    fontSize: 13,
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 6,
                  }}
                >
                  {entry.word ? (
                    <>
                      <span lang={entry.language ?? undefined} style={{ textTransform: 'capitalize' }}>
                        {entry.word}
                      </span>
                      <span aria-hidden="true">·</span>
                    </>
                  ) : null}
                  <span>{outcomeName(entry.outcome, t)}</span>
                </li>
              );
            })}
          </ul>
        ) : (
          <span style={{ fontSize: 13, color: lf.muted }}>{t('hushle.turn.empty')}</span>
        )}
        <VisuallyHidden>
          <span aria-live="polite">
            {last ? (last.word ? `${last.word} · ${outcomeName(last.outcome, t)}` : outcomeName(last.outcome, t)) : ''}
          </span>
        </VisuallyHidden>
      </Stack>
    </Panel>
  );
}

/** The host's less frequent moves: a new card without scoring, and who explains. */
function HostTools({
  state,
  players,
  dispatch,
  hostLocked,
  hostAct,
}: ViewProps & { hostLocked: boolean; hostAct: (action: HushleAction) => void }) {
  const { t } = useHushleI18n();
  const candidates = explainerCandidates(state);
  return (
    <Panel variant="sunken" padding={18} radius={22}>
      <Stack gap={14}>
        <SectionLabel>{t('hushle.host.tools')}</SectionLabel>
        <Row wrap gap={12}>
          <Button variant="secondary" size="sm" disabled={hostLocked} onClick={() => hostAct({ type: 'next-card' })}>
            {t('hushle.playing.nextCard')}
          </Button>
          <span style={{ fontSize: 13, lineHeight: 1.5, color: lf.muted }}>{t('hushle.host.nextCardHint')}</span>
        </Row>
        {candidates.length > 1 ? (
          <Field label={t('hushle.host.explainer')} hint={t('hushle.host.explainerHint')}>
            <SegmentedControl
              label={t('hushle.host.explainer')}
              value={state.currentExplainerId ?? ''}
              onChange={(explainerId) => {
                if (explainerId !== state.currentExplainerId) void dispatch({ type: 'set-explainer', explainerId });
              }}
              options={candidates.map((userId) => ({ value: userId, label: playerName(players, userId, t) }))}
            />
          </Field>
        ) : null}
      </Stack>
    </Panel>
  );
}
