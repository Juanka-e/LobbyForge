import type { ReactNode } from 'react';
import { Button, Callout, EmptyState, Grid, Panel, Row, Stack, lf } from '@lobbyforge/plugin-sdk/ui';
import type { VillageAction } from '../state';
import {
  canWhisper,
  nightTargets,
  nightTaskFor,
  packTally,
  whispersLeft,
  type NightTask,
  type VillageView,
} from '../view';
import { MoonIcon } from './icons';
import { ChatBox, LogPanel, PrivateNotes, RoleCard, TargetButton, namer } from './pieces';
import { useText } from './text';

type Dispatch = (action: VillageAction) => void;

interface NightViewProps {
  view: VillageView;
  dispatch: Dispatch;
  actorUserId: string;
}

/** Three columns that wrap: the role card, the night's job, the pack chat (or the log). */
function NightColumns({ left, middle, right }: { left: ReactNode; middle: ReactNode; right: ReactNode }) {
  const column = (grow: number, basis: number, node: ReactNode) =>
    node ? (
      <div style={{ flex: `${grow} 1 ${basis}px`, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 14 }}>{node}</div>
    ) : null;
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 18, alignItems: 'flex-start', minWidth: 0 }}>
      {column(1, 260, left)}
      {column(2, 340, middle)}
      {column(1, 280, right)}
    </div>
  );
}

function PackChat({ view, dispatch, actorUserId }: NightViewProps) {
  const { t } = useText();
  const pack = view.me?.pack;
  if (!pack) return null;
  return (
    <ChatBox
      view={view}
      title={t('vampire.pack.title')}
      messages={pack.chat}
      emptyText={t('vampire.pack.empty')}
      canWrite={canWhisper(view)}
      left={t('vampire.pack.left', { count: whispersLeft(view) })}
      label={t('vampire.pack.label')}
      placeholder={t('vampire.pack.placeholder')}
      onSend={(text) => dispatch({ type: 'pack-chat', playerId: actorUserId, text })}
    />
  );
}

export function RevealView(props: NightViewProps) {
  const { t } = useText();
  const { view } = props;
  if (!view.me) {
    return <EmptyState icon={<MoonIcon size={36} />} title={t('vampire.header.reveal')} body={t('vampire.reveal.spectator')} />;
  }
  return (
    <NightColumns
      left={<RoleCard view={view} hint={t('vampire.reveal.hint')} />}
      middle={null}
      right={view.me.pack ? <PackChat {...props} /> : <LogPanel view={view} />}
    />
  );
}

export function NightView(props: NightViewProps) {
  const { view } = props;
  return (
    <NightColumns
      left={view.me ? <><RoleCard view={view} /><PrivateNotes view={view} limit={3} /></> : null}
      middle={<NightAction {...props} />}
      right={view.me?.pack ? <PackChat {...props} /> : <LogPanel view={view} />}
    />
  );
}

function NightAction({ view, dispatch, actorUserId }: NightViewProps) {
  const { t } = useText();
  const task = nightTaskFor(view);
  const name = namer(view);
  const paused = view.pausedRemainingMs !== null;
  const choice = view.me?.choice ?? null;
  const target = (targetId: string | null) => dispatch({ type: 'night-target', playerId: actorUserId, targetId });

  const quiet = (text: string) => (
    <EmptyState icon={<MoonIcon size={36} />} title={t('vampire.header.sub.night')} body={text} />
  );

  switch (task.kind) {
    case 'watch':
      return quiet(t('vampire.night.watch'));
    case 'dead':
      return quiet(t('vampire.night.dead'));
    case 'sleep':
      return quiet(t('vampire.night.sleep'));
    case 'hunter-waits':
      return quiet(t('vampire.night.hunterWaits'));
    case 'out-of-bullets':
      return quiet(t('vampire.night.noBullets'));
    case 'out-of-shields':
      return quiet(t('vampire.night.noShields'));
    case 'shield':
      return (
        <Panel>
          <Stack gap={14}>
            <span style={{ fontSize: 15, color: lf.text2 }}>{t('vampire.night.shieldPrompt', { count: task.shields })}</span>
            <Row gap={10} wrap>
              <Button
                variant={choice?.kind === 'shield' && choice.raise ? 'primary' : 'secondary'}
                aria-pressed={choice?.kind === 'shield' && choice.raise}
                disabled={paused}
                onClick={() => dispatch({ type: 'night-shield', playerId: actorUserId, raise: true })}
              >
                {t('vampire.night.shieldRaise')}
              </Button>
              <Button
                variant={choice?.kind === 'shield' && !choice.raise ? 'primary' : 'secondary'}
                aria-pressed={choice?.kind === 'shield' && !choice.raise}
                disabled={paused}
                onClick={() => dispatch({ type: 'night-shield', playerId: actorUserId, raise: false })}
              >
                {t('vampire.night.shieldLower')}
              </Button>
            </Row>
            {choice?.kind === 'shield' ? (
              <span role="status" style={{ fontSize: 14, color: lf.text2 }}>
                {choice.raise ? t('vampire.night.chosenShield') : t('vampire.night.chosenNoShield')}
              </span>
            ) : null}
          </Stack>
        </Panel>
      );
    default:
      return <TargetPicker view={view} task={task} onPick={target} paused={paused} name={name} />;
  }
}

function TargetPicker({
  view,
  task,
  onPick,
  paused,
  name,
}: {
  view: VillageView;
  task: Extract<NightTask, { kind: 'bite' | 'inspect' | 'protect' | 'shoot' }>;
  onPick: (targetId: string | null) => void;
  paused: boolean;
  name: (id: string | null | undefined) => string;
}) {
  const { t } = useText();
  const targets = nightTargets(view);
  const choice = view.me?.choice ?? null;
  const picked = choice && 'targetId' in choice ? choice.targetId : null;
  const tally = task.kind === 'bite' ? packTally(view) : null;

  const prompt =
    task.kind === 'bite'
      ? t('vampire.night.bitePrompt', { needed: tally?.needed ?? 1 })
      : task.kind === 'inspect'
        ? t('vampire.night.inspectPrompt')
        : task.kind === 'protect'
          ? t('vampire.night.protectPrompt')
          : t('vampire.night.shootPrompt', { count: task.bullets });
  const ariaKey =
    task.kind === 'bite'
      ? 'vampire.night.biteAria'
      : task.kind === 'inspect'
        ? 'vampire.night.inspectAria'
        : task.kind === 'protect'
          ? 'vampire.night.protectAria'
          : 'vampire.night.shootAria';

  let status: string | null = null;
  if (task.kind === 'bite') {
    if (tally?.agreedId) status = t('vampire.night.agreed', { name: name(tally.agreedId) });
  } else if (choice?.kind === 'skip') {
    status = t('vampire.night.chosenSkip');
  } else if (picked) {
    status = t('vampire.night.chosen', { name: name(picked) });
  }

  return (
    <Stack gap={12}>
      <span style={{ fontSize: 15, lineHeight: 1.5, color: lf.text2 }}>{prompt}</span>
      <Grid min={120} gap={12}>
        {targets.map((p) => {
          const voters = tally?.byTarget[p.id] ?? [];
          const tag =
            task.kind === 'bite' && voters.length > 0
              ? t('vampire.night.agree', { count: voters.length, needed: tally!.needed })
              : picked === p.id
                ? t('vampire.night.pick')
                : p.id === view.me?.id
                  ? t('vampire.night.you')
                  : '';
          return (
            <TargetButton
              key={p.id}
              player={p}
              label={t(ariaKey, { name: p.name })}
              selected={picked === p.id}
              tag={tag}
              disabled={paused}
              onPick={() => onPick(p.id)}
            />
          );
        })}
      </Grid>
      {status ? (
        <Callout tone="accent" role="status">
          {status}
        </Callout>
      ) : null}
      <Row gap={8} wrap>
        {task.kind === 'bite' ? (
          picked ? (
            <Button variant="ghost" disabled={paused} onClick={() => onPick(null)}>
              {t('vampire.night.withdraw')}
            </Button>
          ) : null
        ) : (
          <Button variant="secondary" aria-pressed={choice?.kind === 'skip'} disabled={paused} onClick={() => onPick(null)}>
            {task.kind === 'shoot' ? t('vampire.night.hold') : t('vampire.night.skip')}
          </Button>
        )}
      </Row>
    </Stack>
  );
}
