import type { ReactNode } from 'react';
import { Avatar, Badge, Button, Panel, Row, SectionLabel, Stack, lf } from '@lobbyforge/plugin-sdk/ui';
import type { VillageAction, VillageRole } from '../state';
import { teamOf } from '../rules';
import type { VillageView } from '../view';
import { PublicChat } from './DayView';
import { RoleIcon, TrophyIcon } from './icons';
import { CAUSE_NEWS, CAUSE_TAG, END_REASON, ROLE_NAME } from './labels';
import { Columns, logText, namer } from './pieces';
import { useText } from './text';
import { COLOR_HEX } from './theme';

type Dispatch = (action: VillageAction) => void;

interface EndedViewProps {
  view: VillageView;
  dispatch: Dispatch;
  actorUserId: string;
  isHost: boolean;
}

/** Game over (spec §19): the winner, every role, and how the game went. */
export function EndedView(props: EndedViewProps) {
  const { t, list } = useText();
  const { view, dispatch, actorUserId, isHost } = props;
  const name = namer(view);
  const outcome = view.outcome;
  const roles = view.secret?.roles ?? {};
  const winners = new Set(outcome?.winners ?? []);
  const winningTeam = outcome?.winner ?? null;
  const title =
    winningTeam === 'village'
      ? t('vampire.end.village')
      : winningTeam === 'vampires'
        ? t('vampire.end.vampires')
        : t('vampire.end.none');
  // Survivors and hanged jesters win on their own, whoever wins the game.
  const alsoWon = (outcome?.winners ?? []).filter((id) => {
    const role = roles[id];
    return !role || !winningTeam || teamOf(role) !== winningTeam;
  });
  const seated = view.players.some((p) => p.id === actorUserId);

  return (
    <Stack gap={16}>
      <Panel highlight={winningTeam === 'village' ? 'success' : winningTeam === 'vampires' ? 'danger' : undefined} padding={22}>
        <Stack gap={10}>
          <Row gap={12}>
            <span aria-hidden="true" style={{ display: 'inline-flex', color: 'var(--lfui-game-text)' }}>
              <TrophyIcon size={30} />
            </span>
            <h3 style={{ margin: 0, fontSize: 28, fontWeight: 800 }}>{title}</h3>
          </Row>
          {outcome ? <span style={{ fontSize: 15, color: lf.text2 }}>{t(END_REASON[outcome.reason])}</span> : null}
          {alsoWon.length > 0 ? (
            <span style={{ fontSize: 15, color: lf.text2 }}>{t('vampire.end.alsoWon', { names: list(alsoWon.map(name)) })}</span>
          ) : null}
          {seated ? (
            <span role="status" style={{ fontSize: 16, fontWeight: 600 }}>
              {winners.has(actorUserId) ? t('vampire.end.youWon') : t('vampire.end.youLost')}
            </span>
          ) : null}
          <Row gap={10} wrap>
            {isHost ? (
              <Button variant="game" size="lg" onClick={() => dispatch({ type: 'play-again' })}>
                {t('vampire.end.playAgain')}
              </Button>
            ) : (
              <span style={{ fontSize: 14, color: lf.muted }}>{t('vampire.end.waitHost')}</span>
            )}
          </Row>
        </Stack>
      </Panel>
      <Columns
        main={
          <>
            <Panel>
              <Stack gap={12}>
                <SectionLabel>{t('vampire.end.rolesTitle')}</SectionLabel>
                <ul className="vv-list">
                  {view.players.map((p) => {
                    const role = roles[p.id] as VillageRole | undefined;
                    const death = p.death;
                    const status = !death
                      ? t('vampire.end.alive')
                      : t(death.time === 'night' ? 'vampire.end.diedNight' : 'vampire.end.diedDay', {
                          round: death.round,
                          cause: t(CAUSE_TAG[death.cause]),
                        });
                    return (
                      <li
                        key={p.id}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          flexWrap: 'wrap',
                          gap: 12,
                          padding: '10px 12px',
                          borderRadius: 14,
                          background: lf.raised,
                        }}
                      >
                        <Avatar name={p.name} size={32} tint={COLOR_HEX[p.color]} />
                        <span style={{ flex: '1 1 110px', minWidth: 0, fontSize: 15, fontWeight: 600, overflowWrap: 'anywhere' }}>
                          {p.name}
                        </span>
                        {role ? (
                          <span style={{ flex: '1 1 120px', display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 14 }}>
                            <RoleIcon role={role} size={18} />
                            {t(ROLE_NAME[role])}
                          </span>
                        ) : null}
                        <span style={{ flex: '1 1 140px', fontSize: 13, color: lf.text2 }}>{status}</span>
                        {winners.has(p.id) ? <Badge tone="success">{t('vampire.end.winner')}</Badge> : null}
                      </li>
                    );
                  })}
                </ul>
              </Stack>
            </Panel>
            <Timeline view={view} />
          </>
        }
        side={
          <>
            <PublicChat view={view} dispatch={dispatch} actorUserId={actorUserId} />
            <PackTranscript view={view} />
          </>
        }
      />
    </Stack>
  );
}

/** Every night and day, now that nothing is secret (spec §19 "full log"). */
function Timeline({ view }: { view: VillageView }) {
  const { t, list } = useText();
  const name = namer(view);
  const roles = view.secret?.roles ?? {};
  const history = view.secret?.history ?? [];
  const lastRound = Math.max(view.round, ...history.map((h) => h.round), 0);
  const sections: Array<{ key: string; label: string; lines: string[] }> = [];

  for (let round = 1; round <= lastRound; round += 1) {
    const lines: string[] = [];
    const night = history.find((h) => h.round === round);
    if (night) {
      if (!night.biteTargetId) lines.push(t('vampire.end.biteNone'));
      else if (night.saved.includes(night.biteTargetId)) lines.push(t('vampire.end.bite', { name: name(night.biteTargetId) }));
      for (const p of view.players) {
        const choice = night.choices[p.id];
        if (!choice) continue;
        if (choice.kind === 'inspect') {
          const seen = roles[choice.targetId];
          lines.push(
            t('vampire.end.inspect', {
              actor: name(p.id),
              name: name(choice.targetId),
              role: seen ? t(ROLE_NAME[seen]) : '?',
            })
          );
        } else if (choice.kind === 'protect') {
          lines.push(t('vampire.end.protect', { actor: name(p.id), name: name(choice.targetId) }));
        } else if (choice.kind === 'shoot') {
          lines.push(t('vampire.end.shoot', { actor: name(p.id), name: name(choice.targetId) }));
        } else if (choice.kind === 'shield' && choice.raise) {
          lines.push(t('vampire.end.shield', { actor: name(p.id) }));
        }
      }
      if (night.saved.length > 0) lines.push(t('vampire.end.saved', { names: list(night.saved.map(name)) }));
      for (const death of night.deaths) lines.push(t(CAUSE_NEWS[death.cause], { name: name(death.playerId) }));
    }
    // Leaving mid-night is not part of the night's resolution; it is in the log.
    for (const entry of view.log) {
      if (entry.round !== round || entry.time !== 'night' || entry.kind !== 'death') continue;
      if (entry.cause === 'fled' || entry.cause === 'removed') lines.push(logText(entry, t, name) ?? '');
    }
    if (lines.length) sections.push({ key: `n${round}`, label: t('vampire.log.night', { round }), lines });

    const day: string[] = [];
    for (const entry of view.log) {
      if (entry.round !== round || entry.time !== 'day') continue;
      if (entry.kind === 'vote-result' || entry.kind === 'death' || entry.kind === 'jester-win') {
        const text = logText(entry, t, name);
        if (text) day.push(text);
      }
    }
    if (day.length) sections.push({ key: `d${round}`, label: t('vampire.log.day', { round }), lines: day });
  }

  if (sections.length === 0) return null;
  return (
    <Panel>
      <Stack gap={12}>
        <SectionLabel>{t('vampire.end.timeline')}</SectionLabel>
        {sections.map((section) => (
          <div key={section.key} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ fontSize: 12, fontWeight: 600, color: lf.muted }}>{section.label}</span>
            {section.lines.map((line, i) => (
              <span key={i} style={{ fontSize: 14, lineHeight: 1.5, color: lf.text2 }}>
                {line}
              </span>
            ))}
          </div>
        ))}
      </Stack>
    </Panel>
  );
}

function PackTranscript({ view }: { view: VillageView }) {
  const { t } = useText();
  const name = namer(view);
  const chat = view.secret?.packChat ?? [];
  let body: ReactNode;
  if (chat.length === 0) {
    body = <span style={{ fontSize: 14, color: lf.muted }}>{t('vampire.end.packChatEmpty')}</span>;
  } else {
    body = (
      <div className="vv-scroll" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {chat.map((m) => (
          <p key={m.id} style={{ margin: 0, fontSize: 14, lineHeight: 1.5, overflowWrap: 'anywhere' }}>
            <span style={{ fontWeight: 600, color: 'var(--lfui-danger-text)' }}>{name(m.authorId)}</span> {m.text}
          </p>
        ))}
      </div>
    );
  }
  return (
    <Panel variant="raised" padding={16}>
      <details>
        <summary className="lfui-focus" style={{ cursor: 'pointer', fontSize: 14, fontWeight: 600 }}>
          {t('vampire.end.packChat')}
        </summary>
        <div style={{ marginTop: 10 }}>{body}</div>
      </details>
    </Panel>
  );
}
