/**
 * Vampire Village panel — what the lobby's activity surface renders.
 *
 * `state` arrives ALREADY PROJECTED for this viewer by @lobbyforge/core
 * (see `VillageView`): the panel only ever sees the viewer's own role,
 * notes and — for a living vampire — the pack. Every action goes through
 * `dispatch`; the server's reducer decides what happens.
 *
 * Night phases re-scope the kit's colours to a plum/rose palette, day
 * phases use the kit's surfaces with the amber game tone (./ui/theme.ts).
 *
 * Timers are deadlines in state. When one passes, this client reports a
 * `timeout` for that phase after a small, seat-dependent delay (the host
 * first), and the server checks its own clock before moving on — no
 * client can end a phase early, and the game never waits on one tab.
 */

'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { detectLocale, loadPluginLocale, pickBestLocale } from '@lobbyforge/plugin-sdk';
import {
  ActivityHeader,
  ActivityShell,
  Badge,
  Callout,
  EmptyState,
  PhasePill,
  Row,
  TimerRing,
  lf,
  useSecondsLeft,
  visuallyHidden,
} from '@lobbyforge/plugin-sdk/ui';
import { LOCALE_TABLES } from './locales.generated';
import { VAMPIRE_VILLAGE_PLUGIN_ID } from './plugin-id';
import { DAWN_SECONDS, ROLE_REVEAL_SECONDS, VERDICT_SECONDS } from './rules';
import { MAX_PLAYERS, MIN_PLAYERS } from './state';
import type { VillageAction, VillagePhase } from './state';
import { lastNightNews, timeoutDelayMs, todaysVerdict, voteTally, type VillageView } from './view';
import { DawnView, DiscussionView, VerdictView, VotingView } from './ui/DayView';
import { EndedView } from './ui/EndedView';
import { HostControls } from './ui/HostControls';
import { FangsIcon, MoonIcon, SunIcon } from './ui/icons';
import { END_REASON, PHASE_PILL, PHASE_TITLE } from './ui/labels';
import { LobbyView } from './ui/LobbyView';
import { NightView, RevealView } from './ui/NightView';
import { isNightPhase, namer } from './ui/pieces';
import { TextContext, makeText, useText } from './ui/text';
import { VV_CSS } from './ui/theme';

// Also registered by index.ts for the server; this module is client-only.
loadPluginLocale(VAMPIRE_VILLAGE_PLUGIN_ID, LOCALE_TABLES);

export interface VampireVillagePanelProps {
  /** The projected state for this viewer. */
  state: VillageView;
  dispatch: (action: VillageAction) => void | Promise<void>;
  actorUserId: string;
  hostUserId: string | null;
  players: Array<{ userId: string; name?: string | null }>;
}

/** A defensive read of the projected state: anything unexpected renders the empty state. */
function readView(raw: unknown): VillageView | null {
  if (!raw || typeof raw !== 'object') return null;
  const s = raw as Partial<VillageView>;
  if (typeof s.phase !== 'string' || !Array.isArray(s.players) || !s.settings || !Array.isArray(s.log)) return null;
  return {
    ...(s as VillageView),
    me: s.me ?? null,
    spectators: Array.isArray(s.spectators) ? s.spectators : [],
    chat: Array.isArray(s.chat) ? s.chat : [],
    chatSent: s.chatSent ?? {},
    votes: s.votes ?? {},
  };
}

function phaseSeconds(view: VillageView): number {
  switch (view.phase) {
    case 'role_reveal':
      return ROLE_REVEAL_SECONDS;
    case 'night':
      return view.settings.nightSeconds;
    case 'dawn':
      return DAWN_SECONDS;
    case 'day':
      return view.settings.daySeconds;
    case 'voting':
      return view.settings.votingSeconds;
    case 'verdict':
      return VERDICT_SECONDS;
    default:
      return 0;
  }
}

const isRunning = (phase: VillagePhase) => phase !== 'lobby' && phase !== 'ended';

/** Stand-in so the hooks below always run, even before the view is readable. */
const EMPTY_VIEW = {
  phase: 'lobby',
  phaseId: 0,
  phaseEndsAt: null,
  players: [],
} as unknown as VillageView;

/**
 * Report a finished phase. One client normally does it (the host, a
 * moment after the deadline); the others wait longer and stand down as
 * soon as the new phase reaches them. A refused report (this clock ran
 * ahead of the server's) is retried a few times.
 */
function usePhaseTimeout(
  view: VillageView,
  dispatch: (action: VillageAction) => void | Promise<void>,
  actorUserId: string,
  hostUserId: string | null
): void {
  const send = useRef(dispatch);
  useEffect(() => {
    send.current = dispatch;
  }, [dispatch]);
  const { phaseId, phaseEndsAt } = view;
  const delay = timeoutDelayMs(view, actorUserId, hostUserId);
  useEffect(() => {
    if (!phaseEndsAt || !actorUserId) return;
    const endsAt = Date.parse(phaseEndsAt);
    if (!Number.isFinite(endsAt)) return;
    let attempts = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const fire = () => {
      attempts += 1;
      void send.current({ type: 'timeout', playerId: actorUserId, phaseId });
      if (attempts < 5) timer = setTimeout(fire, 3_000 * attempts);
    };
    timer = setTimeout(fire, Math.max(0, endsAt + delay - Date.now()));
    return () => {
      if (timer) clearTimeout(timer);
    };
  }, [phaseId, phaseEndsAt, delay, actorUserId]);
}

/** The dusk vignette / dawn light — only when the look changes, never on first paint. */
function useVeil(look: 'night' | 'day'): { key: number; look: 'night' | 'day' } | null {
  const previous = useRef(look);
  const [veil, setVeil] = useState<{ key: number; look: 'night' | 'day' } | null>(null);
  useEffect(() => {
    if (previous.current === look) return;
    previous.current = look;
    setVeil((current) => ({ key: (current?.key ?? 0) + 1, look }));
  }, [look]);
  return veil;
}

function Header({ view }: { view: VillageView }) {
  const { t, list } = useText();
  const name = namer(view);
  const seconds = useSecondsLeft(view.phaseEndsAt);
  const night = isNightPhase(view.phase);
  const tone = night ? 'accent' : 'game';
  const running = isRunning(view.phase);
  const paused = view.pausedRemainingMs !== null;

  let subtitle: string;
  switch (view.phase) {
    case 'lobby':
      subtitle = t('vampire.header.sub.lobby', { count: view.players.length, min: MIN_PLAYERS, max: MAX_PLAYERS });
      break;
    case 'role_reveal':
      subtitle = t('vampire.header.sub.reveal');
      break;
    case 'night':
      subtitle =
        view.me?.alive && view.me.role === 'vampire' ? t('vampire.header.sub.nightPack') : t('vampire.header.sub.night');
      break;
    case 'dawn':
      subtitle = t('vampire.header.sub.dawn');
      break;
    case 'day': {
      const dead = lastNightNews(view).flatMap((e) => (e.kind === 'death' ? [name(e.playerId)] : []));
      subtitle = dead.length
        ? t('vampire.header.sub.dayDeaths', { names: list(dead), count: dead.length })
        : t('vampire.header.sub.dayQuiet');
      break;
    }
    case 'voting':
      subtitle = t('vampire.header.sub.voting', { needed: voteTally(view).needed });
      break;
    case 'verdict': {
      const verdict = todaysVerdict(view);
      subtitle = verdict?.hangedId
        ? t('vampire.news.hanged', { name: name(verdict.hangedId) })
        : t('vampire.news.noHanging');
      break;
    }
    default:
      subtitle = view.outcome ? t(END_REASON[view.outcome.reason]) : '';
  }

  // Spec §13: at night only the vampires see the clock; everyone else just sees "Night…".
  const seesClock = view.phase !== 'night' || (view.me?.alive === true && view.me.role === 'vampire');
  let timer: ReactNode = null;
  if (running && paused && seesClock) {
    const left = Math.ceil((view.pausedRemainingMs ?? 0) / 1000);
    timer = <TimerRing seconds={left} total={phaseSeconds(view)} tone={tone} label={t('vampire.header.paused', { count: left })} />;
  } else if (running && seesClock && seconds !== null) {
    timer = <TimerRing seconds={seconds} total={phaseSeconds(view)} tone={tone} label={t('vampire.header.timer', { count: seconds })} />;
  } else if (running && !seesClock) {
    timer = <span style={{ fontSize: 14, color: lf.muted }}>{t('vampire.header.nightHidden')}</span>;
  }

  const living = view.players.filter((p) => p.alive).length;
  const glyph = night ? <MoonIcon /> : running ? <SunIcon /> : <FangsIcon />;
  return (
    <ActivityHeader
      glyph={glyph}
      tone={tone}
      title={t(PHASE_TITLE[view.phase], { round: view.round })}
      subtitle={subtitle}
      status={
        <Row gap={8} wrap>
          <PhasePill tone={tone} live={running && !paused}>
            {t(PHASE_PILL[view.phase], { round: view.round })}
          </PhasePill>
          {running ? <Badge>{t('vampire.header.alive', { alive: living, total: view.players.length })}</Badge> : null}
        </Row>
      }
      timer={timer}
    />
  );
}

function Body({
  view,
  dispatch,
  actorUserId,
  hostUserId,
  isHost,
  displayName,
}: {
  view: VillageView;
  dispatch: (action: VillageAction) => void;
  actorUserId: string;
  hostUserId: string | null;
  isHost: boolean;
  displayName: string | null;
}) {
  const props = { view, dispatch, actorUserId };
  switch (view.phase) {
    case 'lobby':
      return <LobbyView {...props} hostUserId={hostUserId} isHost={isHost} displayName={displayName} />;
    case 'role_reveal':
      return <RevealView {...props} />;
    case 'night':
      return <NightView {...props} />;
    case 'dawn':
      return <DawnView {...props} />;
    case 'day':
      return <DiscussionView {...props} />;
    case 'voting':
      return <VotingView {...props} />;
    case 'verdict':
      return <VerdictView {...props} />;
    default:
      return <EndedView {...props} isHost={isHost} />;
  }
}

export function VampireVillagePanel(props: VampireVillagePanelProps): ReactNode {
  const { actorUserId, hostUserId, players } = props;
  const locale = useMemo(
    () => pickBestLocale(VAMPIRE_VILLAGE_PLUGIN_ID, detectLocale('en')),
    // The document language does not change mid-session.
    []
  );
  const text = useMemo(() => makeText(locale), [locale]);
  const view = readView(props.state);
  const dispatch = props.dispatch;
  const send = useMemo(() => (action: VillageAction) => void dispatch(action), [dispatch]);

  usePhaseTimeout(view ?? EMPTY_VIEW, dispatch, actorUserId, hostUserId);
  const look: 'night' | 'day' = view && isNightPhase(view.phase) ? 'night' : 'day';
  const veil = useVeil(look);

  if (!view) {
    return (
      <ActivityShell>
        <TextContext.Provider value={text}>
          <EmptyState icon={<FangsIcon size={36} />} title={text.t('vampire.title')} />
        </TextContext.Provider>
      </ActivityShell>
    );
  }

  const isHost = hostUserId !== null && actorUserId === hostUserId;
  const running = isRunning(view.phase);
  const displayName = players.find((p) => p.userId === actorUserId)?.name ?? null;
  const title = text.t(PHASE_TITLE[view.phase], { round: view.round });

  return (
    <ActivityShell>
      <style href="vv-panel-v1" precedence="vv">
        {VV_CSS}
      </style>
      <TextContext.Provider value={text}>
        <div className={`vv-stage ${look === 'night' ? 'vv-night' : 'vv-day'}`} data-phase={view.phase}>
          {look === 'night' ? <div className="vv-stars" aria-hidden="true" /> : null}
          {veil ? (
            <div
              key={veil.key}
              className={`vv-veil ${veil.look === 'night' ? 'vv-veil-dusk' : 'vv-veil-dawn'}`}
              aria-hidden="true"
            />
          ) : null}
          <Header view={view} />
          {/* Phase changes are announced once, politely, for screen readers. */}
          <p role="status" aria-live="polite" style={visuallyHidden}>
            {title}
          </p>
          {running && view.pausedRemainingMs !== null ? (
            <Callout tone="info" role="status">
              {text.t('vampire.status.paused')}
            </Callout>
          ) : null}
          {running && !view.me ? <Callout tone="info">{text.t('vampire.status.spectator')}</Callout> : null}
          {running && view.me && !view.me.alive ? <Callout tone="neutral">{text.t('vampire.status.dead')}</Callout> : null}
          <Body
            view={view}
            dispatch={send}
            actorUserId={actorUserId}
            hostUserId={hostUserId}
            isHost={isHost}
            displayName={displayName}
          />
          {isHost && running ? <HostControls view={view} dispatch={send} /> : null}
        </div>
      </TextContext.Provider>
    </ActivityShell>
  );
}
