import type { ReactNode } from 'react';
import {
  Avatar,
  Badge,
  Button,
  Callout,
  Grid,
  Panel,
  ProgressBar,
  Row,
  SectionLabel,
  Stack,
  lf,
  tone,
} from '@lobbyforge/plugin-sdk/ui';
import type { VillageAction, VillagePlayer } from '../state';
import { canChat, chatLeft, lastNightNews, todaysVerdict, voteTally, type VillageView } from '../view';
import { SkullIcon } from './icons';
import { CAUSE_TAG, ROLE_NAME } from './labels';
import { ChatBox, Columns, LogPanel, NewsList, OutList, PrivateNotes, RoleCard, namer, tallyText } from './pieces';
import { useText } from './text';
import { COLOR_HEX } from './theme';

type Dispatch = (action: VillageAction) => void;

interface DayViewProps {
  view: VillageView;
  dispatch: Dispatch;
  actorUserId: string;
}

/** The public game chat (spec §16): the living talk by day; everyone who played, after the game. */
export function PublicChat({ view, dispatch, actorUserId }: DayViewProps) {
  const { t } = useText();
  const allowed = canChat(view);
  const closedText = allowed
    ? null
    : !view.me
      ? t('vampire.chat.closedSpectator')
      : !view.me.alive
        ? t('vampire.chat.closedDead')
        : t('vampire.chat.closedNight');
  return (
    <ChatBox
      view={view}
      title={t('vampire.chat.title')}
      messages={view.chat}
      emptyText={t('vampire.chat.empty')}
      canWrite={allowed}
      closedText={closedText}
      left={allowed ? t('vampire.chat.left', { count: chatLeft(view) }) : null}
      label={t('vampire.chat.label')}
      placeholder={t('vampire.chat.placeholder')}
      onSend={(text) => dispatch({ type: 'chat', playerId: actorUserId, text })}
    />
  );
}

function Sidebar({ view }: { view: VillageView }) {
  return (
    <>
      {view.me ? <RoleCard view={view} /> : null}
      <PrivateNotes view={view} limit={4} />
      <OutList view={view} />
    </>
  );
}

export function DawnView(props: DayViewProps) {
  const { t } = useText();
  const { view } = props;
  return (
    <Columns
      main={
        <>
          <Panel highlight="game" padding={22}>
            <Stack gap={12}>
              <SectionLabel>{t('vampire.dawn.title')}</SectionLabel>
              <NewsList entries={lastNightNews(view)} view={view} />
            </Stack>
          </Panel>
          <PrivateNotes view={view} limit={3} />
        </>
      }
      side={<PublicChat {...props} />}
    />
  );
}

/** A villager's card in the day grid; the dead show their role and how they died (spec §13). */
function VillageCard({ player, you }: { player: VillagePlayer; you: boolean }) {
  const { t } = useText();
  const death = player.death;
  return (
    <div
      style={{
        boxSizing: 'border-box',
        minWidth: 0,
        padding: 14,
        borderRadius: 18,
        background: death ? lf.sunken : lf.raised,
        border: `2px solid ${death ? lf.border : COLOR_HEX[player.color]}`,
        opacity: death ? 0.75 : 1,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 8,
        textAlign: 'center',
      }}
    >
      {death ? (
        <span aria-hidden="true" style={{ color: lf.muted }}>
          <SkullIcon size={34} />
        </span>
      ) : (
        <Avatar name={player.name} size={40} tint={COLOR_HEX[player.color]} />
      )}
      <span style={{ fontSize: 14, fontWeight: 600, textDecoration: death ? 'line-through' : 'none', maxWidth: '100%', overflowWrap: 'anywhere' }}>
        {player.name}
      </span>
      {death ? (
        <>
          <span style={{ fontSize: 12, color: lf.text2 }}>{t(ROLE_NAME[death.role])}</span>
          <Badge tone="danger">{t(CAUSE_TAG[death.cause])}</Badge>
        </>
      ) : you ? (
        <Badge tone="accent">{t('vampire.lobby.tagYou')}</Badge>
      ) : null}
    </div>
  );
}

export function DiscussionView(props: DayViewProps) {
  const { t } = useText();
  const { view, actorUserId } = props;
  return (
    <Columns
      main={
        <>
          <Panel>
            <Stack gap={12}>
              <SectionLabel>{t('vampire.day.village')}</SectionLabel>
              <Grid min={130} gap={12}>
                {view.players.map((p) => (
                  <VillageCard key={p.id} player={p} you={p.id === actorUserId} />
                ))}
              </Grid>
              <span style={{ fontSize: 14, color: lf.text2 }}>{t('vampire.day.discuss')}</span>
            </Stack>
          </Panel>
          <PublicChat {...props} />
        </>
      }
      side={
        <>
          <Sidebar view={view} />
          <LogPanel view={view} />
        </>
      }
    />
  );
}

export function VotingView(props: DayViewProps) {
  const { t, list } = useText();
  const { view, dispatch, actorUserId } = props;
  const name = namer(view);
  const tally = voteTally(view);
  const paused = view.pausedRemainingMs !== null;
  const canVote = Boolean(view.me?.alive) && !paused;
  const hasVoted = Object.prototype.hasOwnProperty.call(view.votes, actorUserId);
  const myVote = hasVoted ? view.votes[actorUserId] : undefined;
  const vote = (targetId: string | null) => dispatch({ type: 'vote', playerId: actorUserId, targetId });

  const row = (key: string, label: string, avatar: ReactNode, voters: string[], mine: boolean, action: ReactNode) => {
    const count = voters.length;
    return (
      <div
        key={key}
        style={{
          display: 'flex',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: 14,
          padding: '12px 14px',
          borderRadius: 16,
          background: lf.raised,
          border: `1px solid ${mine ? tone('game').line : lf.border}`,
        }}
      >
        {avatar}
        <div style={{ flex: '1 1 120px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
          <Row gap={8} wrap>
            <span style={{ fontSize: 15 }}>{label}</span>
            {mine ? <Badge tone="game">{t('vampire.vote.voted')}</Badge> : null}
          </Row>
          {count > 0 ? (
            <span style={{ fontSize: 12, color: lf.muted }}>{t('vampire.vote.by', { names: list(voters.map(name)) })}</span>
          ) : null}
        </div>
        <div style={{ flex: '2 1 120px', minWidth: 90 }}>
          <ProgressBar
            value={tally.needed > 0 ? count / tally.needed : 0}
            tone="game"
            height={10}
            label={label}
            valueText={t('vampire.vote.count', { count })}
          />
        </div>
        <span style={{ minWidth: 64, textAlign: 'right', fontSize: 14, color: lf.text2, fontVariantNumeric: 'tabular-nums' }}>
          {t('vampire.vote.count', { count })}
        </span>
        {action}
      </div>
    );
  };

  return (
    <Columns
      main={
        <>
          <Panel>
            <Stack gap={10}>
              <Row justify="space-between" wrap>
                <SectionLabel>{t('vampire.pill.voting')}</SectionLabel>
                <span role="status" style={{ fontSize: 13, color: lf.text2 }}>
                  {t('vampire.vote.progress', { voted: tally.voted, living: tally.living })}
                </span>
              </Row>
              {tally.rows.map((r) => {
                const p = view.players.find((x) => x.id === r.id)!;
                const mine = myVote === r.id;
                return row(
                  r.id,
                  p.name,
                  <Avatar name={p.name} size={36} tint={COLOR_HEX[p.color]} />,
                  r.voters,
                  mine,
                  canVote && r.id !== actorUserId ? (
                    <Button
                      size="sm"
                      variant={mine ? 'game' : 'secondary'}
                      aria-pressed={mine}
                      aria-label={t('vampire.vote.aria', { name: p.name })}
                      onClick={() => vote(r.id)}
                    >
                      {t('vampire.vote.vote')}
                    </Button>
                  ) : null
                );
              })}
              {row(
                'no-one',
                t('vampire.vote.noOne'),
                <span aria-hidden="true" style={{ width: 36, height: 36, borderRadius: 99, background: lf.container, flexShrink: 0 }} />,
                tally.skip,
                hasVoted && myVote === null,
                canVote ? (
                  <Button
                    size="sm"
                    variant={hasVoted && myVote === null ? 'game' : 'secondary'}
                    aria-pressed={hasVoted && myVote === null}
                    aria-label={t('vampire.vote.noOneAria')}
                    onClick={() => vote(null)}
                  >
                    {t('vampire.vote.vote')}
                  </Button>
                ) : null
              )}
              <Callout tone="game">{t('vampire.vote.rule', { needed: tally.needed })}</Callout>
              {!view.me?.alive ? <span style={{ fontSize: 13, color: lf.muted }}>{t('vampire.vote.cannot')}</span> : null}
            </Stack>
          </Panel>
          <PublicChat {...props} />
        </>
      }
      side={<Sidebar view={view} />}
    />
  );
}

export function VerdictView(props: DayViewProps) {
  const { t } = useText();
  const { view } = props;
  const name = namer(view);
  const verdict = todaysVerdict(view);
  const today = view.log.filter(
    (e) => e.round === view.round && e.time === 'day' && (e.kind === 'death' || e.kind === 'jester-win')
  );
  return (
    <Columns
      main={
        <Panel highlight="game" padding={22}>
          <Stack gap={12}>
            <SectionLabel>{t('vampire.verdict.title')}</SectionLabel>
            {verdict?.hangedId ? (
              <NewsList entries={today} view={view} />
            ) : (
              <span style={{ fontSize: 17, fontWeight: 600 }}>{t('vampire.news.noHanging')}</span>
            )}
            {verdict && Object.keys(verdict.votes).length > 0 ? (
              <span style={{ fontSize: 14, color: lf.text2 }}>{tallyText(verdict.votes, t, name)}</span>
            ) : null}
          </Stack>
        </Panel>
      }
      side={
        <>
          <PublicChat {...props} />
          <OutList view={view} />
        </>
      }
    />
  );
}

